//! The event bus (docs/protocol.md, "Event delivery"; D-077): process memory
//! on a single instance, Redis pub/sub when `CHAT_REDIS_URL` is set. A
//! replica hands its sockets only what arrives from the bus, so every socket
//! sees one order. Delivery is at most once; a gap becomes [`Note::Reset`].

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use chat_protocol::{EVENT_ID, Event};
use futures_util::StreamExt;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use tokio::sync::{Notify, broadcast};
use uuid::Uuid;

use chat_protocol::{permissions::Outcome, redact::Secret};

use crate::{agent::Fingerprint, auth::store::StoreError, permissions::Answer};

const CHANNEL: &str = "chat:bus";
/// Notes buffered per receiver: deltas of a few busy turns at once.
const CAPACITY: usize = 1024;
/// After Redis refuses a note, this replica stops trying it for a while, so
/// a turn does not wait out a timeout on every delta.
const DEGRADED: Duration = Duration::from_secs(5);

/// Which sockets an event frame is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    User(Uuid),
    Session(Uuid),
}

#[derive(Clone, Debug)]
pub enum Note {
    /// An encoded event frame for every socket of the target.
    Frame { target: Target, frame: Arc<[u8]> },
    /// Cancel this turn, on whichever replica runs it; a later turn of the
    /// same chat is not touched.
    Cancel { chat_id: Uuid, turn_id: Uuid },
    /// The user retired these provider configs (`agent.retire`): their agent
    /// sessions end and their turns stop, on every replica.
    Retire { user_id: Uuid, fingerprints: Arc<[Fingerprint]> },
    /// The answer to a permission request, for the turn waiting on it
    /// (docs/protocol.md, "Permissions and the access log"). A result is
    /// plaintext, as deltas are.
    Answer(Answer),
    /// Notes may have been lost on this replica: sockets send `sync.reset`.
    Reset,
}

impl Note {
    pub fn event<E: Event>(target: Target, event: &E) -> Self {
        Self::Frame { target, frame: chat_protocol::encode(E::TYPE, EVENT_ID, event).into() }
    }

    /// `tag (u8) || id (16) || rest`, where `rest` is the frame, the turn
    /// id, the fingerprints back to back, or an answer's outcome (u8) and
    /// result; a reset never leaves its replica.
    fn encode(&self) -> Option<Vec<u8>> {
        let answer;
        let (tag, id, rest): (u8, Uuid, &[u8]) = match self {
            Self::Frame { target: Target::User(id), frame } => (1, *id, frame),
            Self::Frame { target: Target::Session(id), frame } => (2, *id, frame),
            Self::Cancel { chat_id, turn_id } => (3, *chat_id, turn_id.as_bytes()),
            Self::Retire { user_id, fingerprints } => (4, *user_id, fingerprints.as_flattened()),
            Self::Answer(a) => {
                let mut bytes = vec![outcome_code(a.outcome)];
                if let Some(result) = &a.result {
                    bytes.extend_from_slice(result.0.as_bytes());
                }
                answer = bytes;
                (5, a.request_id, answer.as_slice())
            }
            Self::Reset => return None,
        };
        let mut out = Vec::with_capacity(17 + rest.len());
        out.push(tag);
        out.extend_from_slice(id.as_bytes());
        out.extend_from_slice(rest);
        Some(out)
    }

    fn decode(bytes: &[u8]) -> Option<Self> {
        let (&tag, rest) = bytes.split_first()?;
        let id = Uuid::from_slice(rest.get(..16)?).ok()?;
        let rest = rest.get(16..)?;
        match tag {
            1 => Some(Self::Frame { target: Target::User(id), frame: rest.into() }),
            2 => Some(Self::Frame { target: Target::Session(id), frame: rest.into() }),
            3 => Some(Self::Cancel { chat_id: id, turn_id: Uuid::from_slice(rest).ok()? }),
            4 => {
                let (fingerprints, []) = rest.as_chunks::<32>() else { return None };
                Some(Self::Retire { user_id: id, fingerprints: fingerprints.into() })
            }
            5 => {
                let (&code, result) = rest.split_first()?;
                let outcome = outcome_of(code)?;
                let result = match outcome {
                    Outcome::Approved if !result.is_empty() => Some(Secret(String::from_utf8(result.to_vec()).ok()?)),
                    _ if result.is_empty() => None,
                    _ => return None,
                };
                Some(Self::Answer(Answer { request_id: id, outcome, result }))
            }
            _ => None,
        }
    }
}

const OUTCOMES: [Outcome; 6] =
    [Outcome::Approved, Outcome::Denied, Outcome::Refused, Outcome::Timeout, Outcome::Cancelled, Outcome::Answered];

fn outcome_code(outcome: Outcome) -> u8 {
    OUTCOMES.iter().position(|&o| o == outcome).and_then(|i| u8::try_from(i).ok()).unwrap_or(u8::MAX)
}

fn outcome_of(code: u8) -> Option<Outcome> {
    OUTCOMES.get(usize::from(code)).copied()
}

#[derive(Clone)]
struct Redis {
    conn: ConnectionManager,
    /// Until when Redis is skipped after a refused note.
    degraded: Arc<Mutex<Option<Instant>>>,
    /// Asks the listener to subscribe again.
    resubscribe: Arc<Notify>,
}

#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<Note>,
    redis: Option<Redis>,
}

impl std::fmt::Debug for Bus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.redis.is_some() { "Bus(redis)" } else { "Bus(memory)" })
    }
}

impl Default for Bus {
    fn default() -> Self {
        Self::memory()
    }
}

impl Bus {
    pub fn memory() -> Self {
        Self { tx: broadcast::channel(CAPACITY).0, redis: None }
    }

    pub async fn redis(url: &str) -> Result<Self, StoreError> {
        let client = redis::Client::open(url)?;
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(2)))
            .set_response_timeout(Some(Duration::from_secs(2)))
            .set_number_of_retries(1);
        let conn = ConnectionManager::new_with_config(client.clone(), config).await?;
        let tx = broadcast::channel(CAPACITY).0;
        let resubscribe = Arc::new(Notify::new());
        tokio::spawn(listen(client, tx.clone(), resubscribe.clone()));
        Ok(Self { tx, redis: Some(Redis { conn, degraded: Arc::default(), resubscribe }) })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Note> {
        self.tx.subscribe()
    }

    /// Sends a note to every replica, this one included. When Redis does not
    /// take it, this replica's sockets still get it, followed by a reset; the
    /// other replicas' sockets catch up on their next reset or reconnect.
    pub async fn publish(&self, note: Note) {
        let Some(redis) = &self.redis else {
            // No receivers is fine: no socket is open.
            let _ = self.tx.send(note);
            return;
        };
        let Some(bytes) = note.encode() else {
            let _ = self.tx.send(note);
            return;
        };
        let degraded = |until: Option<Instant>| until.is_some_and(|t| t > Instant::now());
        let lock = || redis.degraded.lock().unwrap_or_else(PoisonError::into_inner);
        if degraded(*lock()) {
            let _ = self.tx.send(note);
            return;
        }
        let mut conn = redis.conn.clone();
        let sent: Result<u64, _> = redis::cmd("PUBLISH").arg(CHANNEL).arg(bytes).query_async(&mut conn).await;
        match sent {
            // Our own subscription would have counted: it is gone without noticing.
            Ok(0) => {
                redis.resubscribe.notify_one();
                let _ = self.tx.send(note);
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(kind = ?e.kind(), "cannot publish to the bus");
                *lock() = Some(Instant::now() + DEGRADED);
                let _ = self.tx.send(note);
                let _ = self.tx.send(Note::Reset);
            }
        }
    }
}

/// Forwards notes from Redis to this replica, reconnecting with a capped
/// backoff. Every new subscription resets the local sockets: notes published
/// while it was down are gone.
async fn listen(client: redis::Client, tx: broadcast::Sender<Note>, resubscribe: Arc<Notify>) {
    let mut backoff = Duration::from_millis(500);
    loop {
        match client.get_async_pubsub().await {
            Ok(mut pubsub) => {
                if pubsub.subscribe(CHANNEL).await.is_ok() {
                    backoff = Duration::from_millis(500);
                    let _ = tx.send(Note::Reset);
                    let mut messages = pubsub.on_message();
                    loop {
                        tokio::select! {
                            message = messages.next() => match message {
                                Some(message) => {
                                    match message.get_payload::<Vec<u8>>().ok().as_deref().and_then(Note::decode) {
                                        Some(note) => {
                                            let _ = tx.send(note);
                                        }
                                        None => tracing::warn!("malformed bus note"),
                                    }
                                }
                                None => break,
                            },
                            () = resubscribe.notified() => break,
                        }
                    }
                }
                tracing::warn!("bus subscription lost; reconnecting");
            }
            Err(e) => tracing::warn!(kind = ?e.kind(), "cannot subscribe to the bus"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_survive_the_wire() {
        let id = Uuid::now_v7();
        let frame: Arc<[u8]> = vec![1, 2, 3].into();
        for note in [
            Note::Frame { target: Target::User(id), frame: frame.clone() },
            Note::Frame { target: Target::Session(id), frame },
            Note::Cancel { chat_id: id, turn_id: Uuid::now_v7() },
            Note::Retire { user_id: id, fingerprints: [[7; 32], [8; 32]].into() },
            Note::Answer(Answer { request_id: id, outcome: Outcome::Approved, result: Some(Secret("{}".into())) }),
            Note::Answer(Answer { request_id: id, outcome: Outcome::Denied, result: None }),
        ] {
            let back = Note::decode(&note.encode().unwrap()).unwrap();
            assert_eq!(format!("{back:?}"), format!("{note:?}"));
        }
        assert!(Note::Reset.encode().is_none());
        assert!(Note::decode(&[9; 17]).is_none());
        assert!(Note::decode(&[1; 10]).is_none());
        assert!(Note::decode(&[3; 20]).is_none());
        assert!(Note::decode(&[4; 17 + 33]).is_none());
        // A result only comes with an approval.
        let mut denied = vec![5; 17];
        denied.extend_from_slice(&[1, b'x']);
        assert!(Note::decode(&denied).is_none());
    }

    #[test]
    fn tls_urls_open() {
        redis::Client::open("rediss://cache:6380").unwrap();
    }
}
