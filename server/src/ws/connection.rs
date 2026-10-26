//! One socket: authenticate, then serve requests until it closes.

use std::{sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket},
};
use chat_protocol::{
    EVENT_ID, Empty, Event, InFrame, Request, SUPPORTED_VERSIONS,
    agent::{AgentRetire, AgentStart, AgentStarted, AgentStop, RETIRE_MAX},
    chat::{
        ChatArchive, ChatConfigure, ChatDelete, ChatList, ChatPin, ChatRename, MessageChunks, MessageDelete,
        MessageEdit, MessageSend, Revision, SyncReset, TurnCancel, TurnRetry,
    },
    close::CloseCode,
    connection::{Auth, AuthOk, AuthRenew, Ping, Pong},
    error::{ErrorCode, ErrorPayload},
    keys::{KeysGet, KeysRecoveryRotate, KeysSetup, KeysWrapAdd, KeysWrapRemove, ScopeKeyList, ScopeKeys},
    link::{LinkCreate, LinkGet, LinkInfo, LinkPost, LinkState},
    settings::{SettingsGet, SettingsPut},
};
use serde::Serialize;
use time::OffsetDateTime;
use tokio::{
    sync::{
        broadcast::{self, error::RecvError},
        oneshot,
    },
    time::Instant,
};

use super::Slot;
use super::rate::Bucket;
use crate::{
    agent,
    app::AppState,
    auth::{Principal, VerifyError, accounts, client::ClientInfo},
    bus::{Note, Target},
    chats,
    keys::{self, KeysError},
    link,
    providers::Provider,
    settings,
};

/// Why the loop ended; becomes the close frame.
#[derive(Debug)]
struct Close(CloseCode, &'static str);

fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// When the token expires, as a tokio deadline.
fn deadline(expires_at: OffsetDateTime) -> Instant {
    let left = expires_at - OffsetDateTime::now_utc();
    Instant::now() + Duration::try_from(left).unwrap_or(Duration::ZERO)
}

fn binary(frame: Vec<u8>) -> Message {
    Message::Binary(frame.into())
}

fn ok<T: Serialize>(id: u32, payload: &T) -> Message {
    binary(chat_protocol::encode("ok", id, payload))
}

fn error(id: u32, code: ErrorCode, message: &str) -> Message {
    binary(chat_protocol::encode("error", id, &ErrorPayload::new(code, message)))
}

struct Socket {
    ws: WebSocket,
}

/// What a socket listens to besides its client.
struct Feeds {
    revoked: broadcast::Receiver<uuid::Uuid>,
    notes: broadcast::Receiver<Note>,
}

/// This socket's hold on an agent session (docs/protocol.md, "Agent sessions").
struct Hold {
    socket: u64,
    /// Fires when another socket resumes the session this one holds.
    superseded: Option<oneshot::Receiver<()>>,
}

impl Hold {
    fn channel(&mut self) -> oneshot::Sender<()> {
        let (tx, rx) = oneshot::channel();
        self.superseded = Some(rx);
        tx
    }
}

async fn superseded(hold: &mut Hold) {
    match hold.superseded.as_mut() {
        Some(rx) => {
            if rx.await.is_err() {
                // The session was replaced or dropped without a resume elsewhere.
                hold.superseded = None;
                std::future::pending::<()>().await;
            }
        }
        None => std::future::pending().await,
    }
}

impl Socket {
    async fn send(&mut self, message: Message) -> Result<(), Close> {
        self.ws.send(message).await.map_err(|_| Close(CloseCode::Normal, "send failed"))
    }

    async fn close(mut self, Close(code, reason): Close) {
        let frame = CloseFrame { code: code.code(), reason: Utf8Bytes::from_static(reason) };
        let _ = self.ws.send(Message::Close(Some(frame))).await;
    }
}

/// A binary frame still to be parsed, or the reason it cannot be served.
enum Incoming {
    Frame(Bytes),
    Close(Close),
    Ignore,
}

fn classify(message: Message) -> Incoming {
    match message {
        Message::Binary(bytes) => Incoming::Frame(bytes),
        Message::Text(_) => Incoming::Close(Close(CloseCode::PolicyViolation, "text frames are not accepted")),
        Message::Close(_) => Incoming::Close(Close(CloseCode::Normal, "closed by client")),
        Message::Ping(_) | Message::Pong(_) => Incoming::Ignore,
    }
}

pub(super) async fn run(ws: WebSocket, state: AppState, client: ClientInfo, slot: Option<Slot>) {
    let mut socket = Socket { ws };
    let mut hold = Hold { socket: agent::socket_id(), superseded: None };
    // Subscribed before `auth.ok`, so no event of the new socket falls in between.
    let feeds = Feeds { revoked: state.auth.store.subscribe(), notes: state.bus.subscribe() };
    let authenticated = authenticate(&mut socket, &state, &mut hold).await;
    drop(slot);
    let principal = match authenticated {
        Ok(p) => p,
        Err(close) => {
            // A resume may have attached the session before `auth.ok` failed to go out.
            state.agents.detach(hold.socket, false, &state.auth.store, state.ws.agent_grace);
            return socket.close(close).await;
        }
    };
    tracing::debug!(session = %principal.session_id, "websocket authenticated");
    // In the background: a slow database must not delay serving the socket.
    let (db, session_id, touched) = (state.db.clone(), principal.session_id, client.clone());
    tokio::spawn(async move {
        if let Err(e) = accounts::touch(&db, session_id, &touched).await {
            tracing::warn!(error = %e, "cannot record session activity");
        }
    });
    let close = serve(&mut socket, &state, &client, principal, &mut hold, feeds)
        .await
        .err()
        .unwrap_or(Close(CloseCode::Normal, "bye"));
    tracing::debug!(code = close.0.code(), reason = close.1, "websocket closed");
    if close.0 != CloseCode::Superseded {
        state.agents.detach(hold.socket, close.0 == CloseCode::SessionRevoked, &state.auth.store, state.ws.agent_grace);
    }
    socket.close(close).await;
}

async fn verify(state: &AppState, token: &str) -> Result<Principal, ErrorCode> {
    match state.auth.verify(token).await {
        Ok(p) => Ok(p),
        Err(VerifyError::Token(_) | VerifyError::Revoked) => Err(ErrorCode::InvalidToken),
        Err(VerifyError::Unavailable(e)) => {
            tracing::error!(error = %e, "revocation store error");
            Err(ErrorCode::AuthUnavailable)
        }
    }
}

async fn authenticate(socket: &mut Socket, state: &AppState, hold: &mut Hold) -> Result<Principal, Close> {
    let timeout = Close(CloseCode::AuthTimeout, "no auth frame in time");
    let deadline = Instant::now() + state.ws.auth_timeout;
    loop {
        let message = match tokio::time::timeout_at(deadline, socket.ws.recv()).await {
            Err(_) => return Err(timeout),
            Ok(None) => return Err(Close(CloseCode::Normal, "closed before auth")),
            Ok(Some(Err(_))) => return Err(Close(CloseCode::PolicyViolation, "frame too large or invalid")),
            Ok(Some(Ok(m))) => m,
        };
        let bytes = match classify(message) {
            Incoming::Ignore => continue,
            Incoming::Close(close) => return Err(close),
            Incoming::Frame(bytes) => bytes,
        };
        let malformed = || Close(CloseCode::AuthFailed, "malformed auth frame");
        let frame = InFrame::parse(&bytes).map_err(|_| malformed())?;
        if frame.kind != Auth::TYPE || frame.id == EVENT_ID {
            return Err(Close(CloseCode::AuthFailed, "the first frame must be auth"));
        }
        let auth: Auth = frame.payload().map_err(|_| malformed())?;
        if !SUPPORTED_VERSIONS.contains(&auth.v) {
            return Err(Close(CloseCode::UnsupportedVersion, "unsupported protocol version"));
        }
        let principal = verify(state, &auth.access_token.0).await.map_err(|code| match code {
            ErrorCode::AuthUnavailable => Close(CloseCode::ServerError, "try again shortly"),
            _ => Close(CloseCode::AuthFailed, "invalid token"),
        })?;
        let resumed = auth.resume.map(|r| r.agent_session_id).filter(|&id| {
            let supersede = hold.channel();
            state.agents.resume(id, &principal, hold.socket, supersede)
        });
        if resumed.is_none() {
            hold.superseded = None;
        }
        let ok = AuthOk {
            session_id: principal.session_id,
            heartbeat_ms: u32::try_from(state.ws.heartbeat.as_millis()).unwrap_or(u32::MAX),
            server_time: now_ms(),
            agent_session_id: resumed,
        };
        socket.send(self::ok(frame.id, &ok)).await?;
        return Ok(principal);
    }
}

async fn serve(
    socket: &mut Socket,
    state: &AppState,
    client: &ClientInfo,
    mut principal: Principal,
    hold: &mut Hold,
    feeds: Feeds,
) -> Result<(), Close> {
    let Feeds { mut revoked, mut notes } = feeds;
    let mut shutdown = state.shutdown.clone();
    let mut bucket = Bucket::new(state.ws.rate_burst, state.ws.rate_per_second);
    let idle_after = state.ws.heartbeat * 3;
    let expiry = tokio::time::sleep_until(deadline(principal.expires_at));
    let idle = tokio::time::sleep(idle_after);
    tokio::pin!(expiry, idle);

    loop {
        tokio::select! {
            message = socket.ws.recv() => {
                let message = match message {
                    None => return Ok(()),
                    // Oversized frames and protocol violations surface as read errors.
                    Some(Err(_)) => return Err(Close(CloseCode::PolicyViolation, "frame too large or invalid")),
                    Some(Ok(message)) => message,
                };
                idle.as_mut().reset(Instant::now() + idle_after);
                let bytes = match classify(message) {
                    Incoming::Ignore => continue,
                    Incoming::Close(close) => return Err(close),
                    Incoming::Frame(bytes) => bytes,
                };
                let Ok(frame) = InFrame::parse(&bytes) else {
                    socket.send(error(EVENT_ID, ErrorCode::Malformed, "not a valid frame")).await?;
                    continue;
                };
                if frame.id == EVENT_ID {
                    socket.send(error(EVENT_ID, ErrorCode::MissingId, "requests need an id")).await?;
                    continue;
                }
                if !bucket.take() {
                    socket.send(error(frame.id, ErrorCode::RateLimited, "too many requests")).await?;
                    continue;
                }
                let reply = dispatch(state, client, &mut principal, hold, &frame).await;
                if let Some(expires_at) = reply.renewed {
                    expiry.as_mut().reset(deadline(expires_at));
                }
                // Parts go out one by one, so frames of other tasks can pass between them.
                for message in reply.messages {
                    socket.send(message).await?;
                }
            }
            () = &mut expiry => return Err(Close(CloseCode::TokenExpired, "access token expired")),
            () = &mut idle => return Err(Close(CloseCode::Normal, "idle")),
            id = revoked.recv() => match id {
                Ok(id) if id == principal.session_id => return Err(Close(CloseCode::SessionRevoked, "session revoked")),
                // Missed messages: ask the store; if it cannot answer, do not keep serving.
                Err(RecvError::Lagged(_)) => match state.auth.store.is_revoked(principal.session_id).await {
                    Ok(false) => {}
                    Ok(true) => return Err(Close(CloseCode::SessionRevoked, "session revoked")),
                    Err(_) => return Err(Close(CloseCode::ServerError, "try again shortly")),
                },
                Ok(_) => {}
                Err(RecvError::Closed) => return Err(Close(CloseCode::GoingAway, "shutting down")),
            },
            note = notes.recv() => match note {
                Ok(Note::Frame { target, frame }) => {
                    let ours = match target {
                        Target::User(id) => id == principal.user_id,
                        Target::Session(id) => id == principal.session_id,
                    };
                    if ours {
                        socket.send(Message::Binary(frame.to_vec().into())).await?;
                    }
                }
                Ok(Note::Cancel { .. } | Note::Retire { .. }) => {}
                // Events were lost: the client reloads what it shows (docs/protocol.md, "Event delivery").
                Ok(Note::Reset) | Err(RecvError::Lagged(_)) => {
                    socket.send(binary(chat_protocol::encode(SyncReset::TYPE, EVENT_ID, &SyncReset {}))).await?;
                }
                Err(RecvError::Closed) => return Err(Close(CloseCode::GoingAway, "shutting down")),
            },
            () = superseded(hold) => return Err(Close(CloseCode::Superseded, "agent session resumed elsewhere")),
            _ = shutdown.changed() => return Err(Close(CloseCode::GoingAway, "server restarting")),
        }
    }
}

struct Reply {
    /// One `ok` or `error`, or `more` parts and a final `ok`.
    messages: Vec<Message>,
    renewed: Option<OffsetDateTime>,
}

impl Reply {
    fn ok<T: Serialize>(id: u32, payload: T) -> Self {
        Self { messages: vec![ok(id, &payload)], renewed: None }
    }

    fn error(id: u32, code: ErrorCode, message: &str) -> Self {
        Self { messages: vec![error(id, code, message)], renewed: None }
    }

    /// A response in parts (docs/protocol.md, "Envelope").
    fn frames(frames: Vec<Vec<u8>>) -> Self {
        Self { messages: frames.into_iter().map(binary).collect(), renewed: None }
    }
}

/// The reply to a request that may be refused; database errors are logged, never sent.
fn keys_reply<T: Serialize>(id: u32, result: Result<T, KeysError>) -> Reply {
    match result {
        Ok(payload) => Reply::ok(id, payload),
        Err(KeysError::Refused(code)) => Reply::error(id, code, "refused"),
        Err(KeysError::Db(e)) => {
            tracing::error!(error = %e, "request failed");
            Reply::error(id, ErrorCode::Internal, "internal error")
        }
    }
}

fn empty(result: Result<(), KeysError>) -> Result<Empty, KeysError> {
    result.map(|()| Empty {})
}

async fn dispatch(
    state: &AppState,
    client: &ClientInfo,
    principal: &mut Principal,
    hold: &mut Hold,
    frame: &InFrame<'_>,
) -> Reply {
    let id = frame.id;
    let malformed = || Reply::error(id, ErrorCode::Malformed, "invalid payload");
    let db = &state.db;
    match frame.kind {
        KeysGet::TYPE => match frame.payload::<KeysGet>() {
            Ok(_) => keys_reply(id, keys::get(db, principal).await),
            Err(_) => malformed(),
        },
        KeysSetup::TYPE => match frame.payload::<KeysSetup>() {
            Ok(setup) => keys_reply(id, keys::setup(db, principal, client, &setup).await.map(|()| Empty {})),
            Err(_) => malformed(),
        },
        KeysWrapAdd::TYPE => match frame.payload::<KeysWrapAdd>() {
            Ok(add) => keys_reply(id, keys::add_wrap(db, principal, client, &add.wrap).await.map(|()| Empty {})),
            Err(_) => malformed(),
        },
        KeysWrapRemove::TYPE => match frame.payload::<KeysWrapRemove>() {
            Ok(remove) => {
                keys_reply(id, keys::remove_wrap(db, principal, client, remove.wrap_id).await.map(|()| Empty {}))
            }
            Err(_) => malformed(),
        },
        KeysRecoveryRotate::TYPE => match frame.payload::<KeysRecoveryRotate>() {
            Ok(rotate) => {
                keys_reply(id, keys::rotate_recovery(db, principal, client, &rotate.wrap).await.map(|()| Empty {}))
            }
            Err(_) => malformed(),
        },
        ScopeKeys::TYPE => match frame.payload::<ScopeKeys>() {
            Ok(request) => keys_reply(
                id,
                keys::scope_keys(db, principal, &request.scope_ids).await.map(|keys| ScopeKeyList { keys }),
            ),
            Err(_) => malformed(),
        },
        LinkCreate::TYPE => match frame.payload::<LinkCreate>() {
            Ok(_) => keys_reply(id, link::create(db, principal).await),
            Err(_) => malformed(),
        },
        LinkInfo::TYPE => match frame.payload::<LinkInfo>() {
            Ok(request) => keys_reply(id, link::info(db, principal, request.sid).await),
            Err(_) => malformed(),
        },
        LinkPost::TYPE => match frame.payload::<LinkPost>() {
            Ok(post) => keys_reply(
                id,
                link::post(db, &state.bus, principal, client, post.sid, &post.message).await.map(|()| Empty {}),
            ),
            Err(_) => malformed(),
        },
        LinkGet::TYPE => match frame.payload::<LinkGet>() {
            Ok(request) => {
                keys_reply(id, link::get(db, principal, request.sid).await.map(|message| LinkState { message }))
            }
            Err(_) => malformed(),
        },
        AgentStart::TYPE => match frame.payload::<AgentStart>() {
            Ok(start) if start.valid() => {
                let active = start.active;
                // A refused config other than the active one is left out: its
                // chats run with the active provider, as if it were removed.
                let held: Vec<agent::Held> = start
                    .providers
                    .into_iter()
                    .filter_map(|entry| {
                        let (provider_id, settings) = entry.into_settings();
                        let fingerprint = agent::fingerprint(principal.user_id, &settings);
                        let provider = Provider::new(settings.into(), state.providers.clone()).ok()?;
                        Some(agent::Held { id: provider_id, provider: Arc::new(provider), fingerprint })
                    })
                    .collect();
                if held.iter().any(|h| h.id == active) {
                    let supersede = hold.channel();
                    let agent_session_id = state.agents.start(hold.socket, principal, held, active, supersede);
                    Reply::ok(id, AgentStarted { agent_session_id })
                } else {
                    Reply::error(id, ErrorCode::AgentInvalidProvider, "provider refused")
                }
            }
            _ => malformed(),
        },
        AgentStop::TYPE => match frame.payload::<AgentStop>() {
            Ok(_) => {
                state.agents.stop(hold.socket);
                Reply::ok(id, Empty {})
            }
            Err(_) => malformed(),
        },
        AgentRetire::TYPE => match frame.payload::<AgentRetire>() {
            Ok(retire) if retire.fingerprints.len() <= RETIRE_MAX => {
                let fingerprints: Option<Arc<[agent::Fingerprint]>> =
                    retire.fingerprints.iter().map(|f| f.0.as_slice().try_into().ok()).collect();
                match fingerprints {
                    Some(fingerprints) => {
                        state.bus.publish(Note::Retire { user_id: principal.user_id, fingerprints }).await;
                        Reply::ok(id, Empty {})
                    }
                    None => malformed(),
                }
            }
            _ => malformed(),
        },
        SettingsGet::TYPE => match frame.payload::<SettingsGet>() {
            Ok(get) => keys_reply(id, settings::get(db, principal, &get.key).await),
            Err(_) => malformed(),
        },
        SettingsPut::TYPE => match frame.payload::<SettingsPut>() {
            Ok(put) => keys_reply(id, settings::put(state, principal, &put).await),
            Err(_) => malformed(),
        },
        ChatList::TYPE => match frame.payload::<ChatList>() {
            Ok(list) => {
                keys_reply(id, chats::list(state, principal, list.archived.unwrap_or(false), list.before).await)
            }
            Err(_) => malformed(),
        },
        ChatRename::TYPE => match frame.payload::<ChatRename>() {
            Ok(rename) => keys_reply(id, empty(chats::rename(state, principal, rename.chat_id, &rename.title).await)),
            Err(_) => malformed(),
        },
        ChatPin::TYPE => match frame.payload::<ChatPin>() {
            Ok(pin) => keys_reply(id, empty(chats::pin(state, principal, pin.chat_id, pin.position).await)),
            Err(_) => malformed(),
        },
        ChatArchive::TYPE => match frame.payload::<ChatArchive>() {
            Ok(a) => keys_reply(id, empty(chats::archive(state, principal, client, a.chat_id, a.archived).await)),
            Err(_) => malformed(),
        },
        ChatConfigure::TYPE => match frame.payload::<ChatConfigure>() {
            Ok(c) => keys_reply(id, empty(chats::configure(state, principal, c.chat_id, &c.settings).await)),
            Err(_) => malformed(),
        },
        ChatDelete::TYPE => match frame.payload::<ChatDelete>() {
            Ok(delete) => keys_reply(id, empty(chats::delete(state, principal, client, delete.chat_id).await)),
            Err(_) => malformed(),
        },
        MessageSend::TYPE => match frame.payload::<MessageSend>() {
            Ok(send) => {
                let agent = state.agents.of_socket(hold.socket);
                keys_reply(id, chats::send(state, principal, client, agent, send).await)
            }
            Err(_) => malformed(),
        },
        MessageChunks::TYPE => match frame.payload::<MessageChunks>() {
            Ok(request) => match chats::chunks(state, principal, request.chat_id, &request.chunks).await {
                Ok(chunks) => Reply::frames(chats::chunk_frames(id, request.chat_id, chunks)),
                Err(e) => keys_reply::<Empty>(id, Err(e)),
            },
            Err(_) => malformed(),
        },
        MessageEdit::TYPE => match frame.payload::<MessageEdit>() {
            Ok(edit) => keys_reply(
                id,
                chats::edit(state, principal, edit.chat_id, edit.message_id, &edit.record)
                    .await
                    .map(|rev| Revision { rev }),
            ),
            Err(_) => malformed(),
        },
        MessageDelete::TYPE => match frame.payload::<MessageDelete>() {
            Ok(delete) => keys_reply(
                id,
                chats::delete_message(state, principal, delete.chat_id, delete.message_id)
                    .await
                    .map(|rev| Revision { rev }),
            ),
            Err(_) => malformed(),
        },
        TurnCancel::TYPE => match frame.payload::<TurnCancel>() {
            Ok(cancel) => keys_reply(id, empty(chats::cancel(state, principal, cancel.chat_id).await)),
            Err(_) => malformed(),
        },
        TurnRetry::TYPE => match frame.payload::<TurnRetry>() {
            Ok(retry) => {
                let agent = state.agents.of_socket(hold.socket);
                keys_reply(id, chats::retry(state, principal, client, agent, retry).await)
            }
            Err(_) => malformed(),
        },
        Ping::TYPE => match frame.payload::<Ping>() {
            Ok(_) => Reply::ok(id, Pong { server_time: now_ms() }),
            Err(_) => malformed(),
        },
        AuthRenew::TYPE => {
            let Ok(renew) = frame.payload::<AuthRenew>() else { return malformed() };
            match verify(state, &renew.access_token.0).await {
                Ok(fresh) if fresh.session_id == principal.session_id && fresh.user_id == principal.user_id => {
                    let expires_at = fresh.expires_at;
                    *principal = fresh;
                    Reply { renewed: Some(expires_at), ..Reply::ok(id, Empty {}) }
                }
                Ok(_) => Reply::error(id, ErrorCode::SessionMismatch, "token of another session"),
                Err(code) => Reply::error(id, code, "invalid token"),
            }
        }
        Auth::TYPE => Reply::error(id, ErrorCode::AlreadyAuthenticated, "socket is already authenticated"),
        _ => Reply::error(id, ErrorCode::UnknownType, "unknown message type"),
    }
}
