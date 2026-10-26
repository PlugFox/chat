//! Agent sessions (docs/protocol.md, "Agent sessions"): the provider a socket
//! runs its turns with, in this replica's memory only. A session outlives its
//! socket for a grace period so a reconnect can resume it, and a turn started
//! in it outlives the session (D-088). Revoking the auth session or retiring
//! the provider ends the session at once and interrupts its turns through
//! [`Agent::interrupted`].

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use chat_protocol::agent::{ProviderKind, ProviderSettings};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, oneshot, watch};
use uuid::Uuid;

use crate::{
    auth::{Principal, store::Store},
    bus::Note,
    providers::Provider,
};

/// Identifies a provider config of one user without holding it
/// (docs/protocol.md, "Agent sessions"): SHA-256 over a label, the user id
/// and each field with its length.
pub type Fingerprint = [u8; 32];

pub fn fingerprint(user: Uuid, settings: &ProviderSettings) -> Fingerprint {
    let kind = match settings.kind {
        ProviderKind::OpenaiCompatible => "openai_compatible",
        ProviderKind::Anthropic => "anthropic",
    };
    let mut hash = Sha256::new();
    hash.update(b"vc/v1/provider-fingerprint");
    hash.update(user.as_bytes());
    for field in [kind, &settings.base_url, &settings.api_key.0, &settings.model] {
        hash.update(u32::try_from(field.len()).unwrap_or(u32::MAX).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hash.finalize().into()
}

static SOCKETS: AtomicU64 = AtomicU64::new(1);

/// A process-unique id for a socket.
pub fn socket_id() -> u64 {
    SOCKETS.fetch_add(1, Ordering::Relaxed)
}

/// What a turn needs from its agent session.
#[derive(Clone, Debug)]
pub struct Agent {
    pub id: Uuid,
    pub provider: Arc<Provider>,
    pub fingerprint: Fingerprint,
    /// Changes when the session's turns must stop.
    pub interrupted: watch::Receiver<()>,
    /// Keeps `interrupted` open after the session ended quietly.
    _interrupt: Arc<watch::Sender<()>>,
}

#[derive(Debug)]
struct Entry {
    session_id: Uuid,
    user_id: Uuid,
    provider: Arc<Provider>,
    fingerprint: Fingerprint,
    socket: Option<u64>,
    /// Closes the socket that holds the session when another one resumes it.
    supersede: Option<oneshot::Sender<()>>,
    /// Counts attachments, so a stale grace timer leaves a resumed session alone.
    generation: u64,
    interrupt: Arc<watch::Sender<()>>,
}

impl Entry {
    fn interrupt(&self) {
        self.interrupt.send_replace(());
    }
}

#[derive(Clone, Debug, Default)]
pub struct Agents(Arc<Mutex<HashMap<Uuid, Entry>>>);

impl Agents {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Entry>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new session for the socket, replacing the one it held; turns of
    /// the old one run to their end.
    pub fn start(
        &self,
        socket: u64,
        principal: &Principal,
        provider: Provider,
        fingerprint: Fingerprint,
        supersede: oneshot::Sender<()>,
    ) -> Uuid {
        let id = Uuid::now_v7();
        let mut map = self.lock();
        map.retain(|_, e| e.socket != Some(socket));
        let entry = Entry {
            session_id: principal.session_id,
            user_id: principal.user_id,
            provider: Arc::new(provider),
            fingerprint,
            socket: Some(socket),
            supersede: Some(supersede),
            generation: 0,
            interrupt: Arc::new(watch::channel(()).0),
        };
        map.insert(id, entry);
        id
    }

    /// Ends the socket's session and drops its provider config; its running
    /// turns run to their end.
    pub fn stop(&self, socket: u64) {
        self.lock().retain(|_, e| e.socket != Some(socket));
    }

    /// Ends the user's sessions started with these configs and interrupts
    /// their turns. Turns whose session already ended watch the bus for the
    /// same note themselves.
    pub fn retire(&self, user: Uuid, fingerprints: &[Fingerprint]) {
        self.lock().retain(|_, e| {
            let retired = e.user_id == user && fingerprints.contains(&e.fingerprint);
            if retired {
                e.interrupt();
            }
            !retired
        });
    }

    /// Applies `Note::Retire` from every replica until the bus closes. A note
    /// lost in a gap is not replayed: its sessions end with their grace
    /// period or their clients' next start, and their turns run on.
    pub fn watch(&self, mut notes: broadcast::Receiver<Note>) {
        let agents = self.clone();
        tokio::spawn(async move {
            loop {
                match notes.recv().await {
                    Ok(Note::Retire { user_id, fingerprints }) => agents.retire(user_id, &fingerprints),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    /// Attaches the socket to a session of the same auth session; a socket
    /// that held it is told to close.
    pub fn resume(&self, id: Uuid, principal: &Principal, socket: u64, supersede: oneshot::Sender<()>) -> bool {
        let mut map = self.lock();
        let Some(entry) = map.get_mut(&id) else { return false };
        if entry.session_id != principal.session_id {
            return false;
        }
        if entry.socket.is_some_and(|s| s != socket)
            && let Some(old) = entry.supersede.take()
        {
            let _ = old.send(());
        }
        entry.socket = Some(socket);
        entry.supersede = Some(supersede);
        entry.generation += 1;
        true
    }

    /// The session the socket holds.
    pub fn of_socket(&self, socket: u64) -> Option<Agent> {
        self.lock().iter().find(|(_, e)| e.socket == Some(socket)).map(|(id, e)| Agent {
            id: *id,
            provider: e.provider.clone(),
            fingerprint: e.fingerprint,
            interrupted: e.interrupt.subscribe(),
            _interrupt: e.interrupt.clone(),
        })
    }

    /// The socket closed: its session waits `grace` for a resume and then
    /// ends, its turns running on. It ends now, interrupting them, when
    /// `revoked` or as soon as its auth session is revoked, and when
    /// revocations may have been missed (a lag, a store error).
    pub fn detach(&self, socket: u64, revoked: bool, store: &Store, grace: Duration) {
        let mut map = self.lock();
        let Some((&id, entry)) = map.iter_mut().find(|(_, e)| e.socket == Some(socket)) else { return };
        if revoked {
            entry.interrupt();
            map.remove(&id);
            return;
        }
        entry.socket = None;
        entry.supersede = None;
        let (generation, session) = (entry.generation, entry.session_id);
        let (agents, store) = (self.clone(), store.clone());
        // Subscribed before the check below, so no revocation falls between them.
        let mut revocations = store.subscribe();
        tokio::spawn(async move {
            if !matches!(store.is_revoked(session).await, Ok(false)) {
                agents.end(id, generation, true);
                return;
            }
            let grace = tokio::time::sleep(grace);
            tokio::pin!(grace);
            let revoked = loop {
                tokio::select! {
                    () = &mut grace => break false,
                    revoked = revocations.recv() => match revoked {
                        Ok(s) if s == session => break true,
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if !matches!(store.is_revoked(session).await, Ok(false)) {
                                break true;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break true,
                    },
                }
            };
            agents.end(id, generation, revoked);
        });
    }

    /// Drops a detached session unless a resume attached it again meanwhile.
    fn end(&self, id: Uuid, generation: u64, interrupt: bool) {
        self.lock().retain(|key, e| {
            let ends = *key == id && e.socket.is_none() && e.generation == generation;
            if ends && interrupt {
                e.interrupt();
            }
            !ends
        });
    }
}

#[cfg(test)]
mod tests {
    use chat_protocol::redact::Secret;

    use super::*;

    /// The same vector is in client/src/agent/agent.test.ts.
    #[test]
    fn fingerprints_match_the_spec() {
        let settings = ProviderSettings {
            kind: ProviderKind::OpenaiCompatible,
            base_url: "https://api.example.com/v1".into(),
            api_key: Secret("sk-test".into()),
            model: "gpt-test".into(),
        };
        let user = Uuid::parse_str("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b").unwrap();
        let hex: String = fingerprint(user, &settings).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "ec60e285e14c619ec61d3e36b6604ea66fbee3df211a61d41e49c45ad1f8b2b4");
    }
}
