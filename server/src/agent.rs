//! Agent sessions (docs/protocol.md, "Agent sessions"): the provider a socket
//! runs its turns with, in this replica's memory only. A session outlives its
//! socket for a grace period so a reconnect can resume it; revoking the auth
//! session drops it at once. Turns watch [`Agent::alive`] and stop when their
//! session is dropped.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use tokio::sync::{broadcast, oneshot, watch};
use uuid::Uuid;

use crate::{
    auth::{Principal, store::Store},
    providers::Provider,
};

/// How long a session waits for its socket to come back.
pub const GRACE: Duration = Duration::from_secs(120);

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
    /// Closes when the session is dropped.
    pub alive: watch::Receiver<()>,
}

#[derive(Debug)]
struct Entry {
    session_id: Uuid,
    provider: Arc<Provider>,
    socket: Option<u64>,
    /// Closes the socket that holds the session when another one resumes it.
    supersede: Option<oneshot::Sender<()>>,
    /// Counts attachments, so a stale grace timer leaves a resumed session alone.
    generation: u64,
    alive: watch::Sender<()>,
}

#[derive(Clone, Debug, Default)]
pub struct Agents(Arc<Mutex<HashMap<Uuid, Entry>>>);

impl Agents {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Entry>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new session for the socket, replacing the one it held.
    pub fn start(
        &self,
        socket: u64,
        principal: &Principal,
        provider: Provider,
        supersede: oneshot::Sender<()>,
    ) -> Uuid {
        let id = Uuid::now_v7();
        let mut map = self.lock();
        map.retain(|_, e| e.socket != Some(socket));
        let entry = Entry {
            session_id: principal.session_id,
            provider: Arc::new(provider),
            socket: Some(socket),
            supersede: Some(supersede),
            generation: 0,
            alive: watch::channel(()).0,
        };
        map.insert(id, entry);
        id
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
            alive: e.alive.subscribe(),
        })
    }

    /// The socket closed: its session waits [`GRACE`] for a resume, or ends
    /// now when `revoked`, or as soon as its auth session is revoked. When
    /// revocations may have been missed (a lag, a store error), it ends too.
    pub fn detach(&self, socket: u64, revoked: bool, store: &Store) {
        let mut map = self.lock();
        let Some((&id, entry)) = map.iter_mut().find(|(_, e)| e.socket == Some(socket)) else { return };
        if revoked {
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
                agents.end(id, generation);
                return;
            }
            let grace = tokio::time::sleep(GRACE);
            tokio::pin!(grace);
            loop {
                tokio::select! {
                    () = &mut grace => break,
                    revoked = revocations.recv() => match revoked {
                        Ok(s) if s == session => break,
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if !matches!(store.is_revoked(session).await, Ok(false)) {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                }
            }
            agents.end(id, generation);
        });
    }

    /// Drops a detached session unless a resume attached it again meanwhile.
    fn end(&self, id: Uuid, generation: u64) {
        self.lock().retain(|key, e| !(*key == id && e.socket.is_none() && e.generation == generation));
    }
}
