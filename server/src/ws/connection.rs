//! One socket: authenticate, then serve requests until it closes.

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use chat_protocol::{
    Empty, InFrame, OutFrame, Request, SUPPORTED_VERSIONS,
    close::CloseCode,
    connection::{Auth, AuthOk, AuthRenew, Ping, Pong},
    error::{ErrorCode, ErrorPayload},
};
use serde::Serialize;
use time::OffsetDateTime;
use tokio::{sync::broadcast::error::RecvError, time::Instant};

use super::Slot;
use super::rate::Bucket;
use crate::{
    app::AppState,
    auth::{Principal, VerifyError, accounts, client::ClientInfo},
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

fn text<T: Serialize>(frame: &OutFrame<'_, T>) -> Message {
    // Serializing our own protocol types cannot fail; an empty frame would be a bug the client reports.
    Message::Text(serde_json::to_string(frame).unwrap_or_default().into())
}

fn error(id: Option<u32>, code: ErrorCode, message: &str) -> Message {
    let payload = ErrorPayload::new(code, message);
    text(&OutFrame { v: chat_protocol::PROTOCOL_VERSION, id, kind: "error", payload })
}

struct Socket {
    ws: WebSocket,
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

/// A text frame parsed into an envelope, or the reason it cannot be served.
enum Incoming {
    Frame(InFrame),
    Malformed,
    Close(Close),
    Ignore,
}

fn classify(message: Message) -> Incoming {
    match message {
        Message::Text(t) => match serde_json::from_str::<InFrame>(t.as_str()) {
            Ok(frame) if !SUPPORTED_VERSIONS.contains(&frame.v) => {
                Incoming::Close(Close(CloseCode::UnsupportedVersion, "unsupported protocol version"))
            }
            Ok(frame) => Incoming::Frame(frame),
            Err(_) => Incoming::Malformed,
        },
        Message::Binary(_) => Incoming::Close(Close(CloseCode::PolicyViolation, "binary frames are not accepted")),
        Message::Close(_) => Incoming::Close(Close(CloseCode::Normal, "closed by client")),
        Message::Ping(_) | Message::Pong(_) => Incoming::Ignore,
    }
}

pub(super) async fn run(ws: WebSocket, state: AppState, client: ClientInfo, slot: Option<Slot>) {
    let mut socket = Socket { ws };
    let authenticated = authenticate(&mut socket, &state).await;
    drop(slot);
    let principal = match authenticated {
        Ok(p) => p,
        Err(close) => return socket.close(close).await,
    };
    tracing::debug!(session = %principal.session_id, "websocket authenticated");
    // In the background: a slow database must not delay serving the socket.
    let (db, session_id) = (state.db.clone(), principal.session_id);
    tokio::spawn(async move {
        if let Err(e) = accounts::touch(&db, session_id, &client).await {
            tracing::warn!(error = %e, "cannot record session activity");
        }
    });
    let close = serve(&mut socket, &state, principal).await.err().unwrap_or(Close(CloseCode::Normal, "bye"));
    tracing::debug!(code = close.0.code(), reason = close.1, "websocket closed");
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

async fn authenticate(socket: &mut Socket, state: &AppState) -> Result<Principal, Close> {
    let timeout = Close(CloseCode::AuthTimeout, "no auth frame in time");
    let deadline = Instant::now() + state.ws.auth_timeout;
    loop {
        let message = match tokio::time::timeout_at(deadline, socket.ws.recv()).await {
            Err(_) => return Err(timeout),
            Ok(None) => return Err(Close(CloseCode::Normal, "closed before auth")),
            Ok(Some(Err(_))) => return Err(Close(CloseCode::PolicyViolation, "frame too large or invalid")),
            Ok(Some(Ok(m))) => m,
        };
        let frame = match classify(message) {
            Incoming::Ignore => continue,
            Incoming::Close(close) => return Err(close),
            Incoming::Malformed => return Err(Close(CloseCode::AuthFailed, "malformed auth frame")),
            Incoming::Frame(frame) => frame,
        };
        let (Some(id), Auth::TYPE) = (frame.id, frame.kind.as_str()) else {
            return Err(Close(CloseCode::AuthFailed, "the first frame must be auth"));
        };
        let auth: Auth = frame.payload().map_err(|_| Close(CloseCode::AuthFailed, "malformed auth frame"))?;
        let principal = verify(state, &auth.access_token.0).await.map_err(|code| match code {
            ErrorCode::AuthUnavailable => Close(CloseCode::ServerError, "try again shortly"),
            _ => Close(CloseCode::AuthFailed, "invalid token"),
        })?;
        let ok = AuthOk {
            session_id: principal.session_id,
            heartbeat_ms: u32::try_from(state.ws.heartbeat.as_millis()).unwrap_or(u32::MAX),
            server_time: now_ms(),
        };
        socket.send(text(&OutFrame::ok(id, ok))).await?;
        return Ok(principal);
    }
}

async fn serve(socket: &mut Socket, state: &AppState, mut principal: Principal) -> Result<(), Close> {
    let mut revoked = state.auth.store.subscribe();
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
                let frame = match classify(message) {
                    Incoming::Ignore => continue,
                    Incoming::Close(close) => return Err(close),
                    Incoming::Malformed => {
                        socket.send(error(None, ErrorCode::Malformed, "not a valid frame")).await?;
                        continue;
                    }
                    Incoming::Frame(frame) => frame,
                };
                let Some(id) = frame.id else {
                    socket.send(error(None, ErrorCode::MissingId, "requests need an id")).await?;
                    continue;
                };
                if !bucket.take() {
                    socket.send(error(Some(id), ErrorCode::RateLimited, "too many requests")).await?;
                    continue;
                }
                let reply = dispatch(state, &mut principal, id, &frame).await;
                if let Some(expires_at) = reply.renewed {
                    expiry.as_mut().reset(deadline(expires_at));
                }
                socket.send(reply.message).await?;
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
            _ = shutdown.changed() => return Err(Close(CloseCode::GoingAway, "server restarting")),
        }
    }
}

struct Reply {
    message: Message,
    renewed: Option<OffsetDateTime>,
}

impl Reply {
    fn ok<T: Serialize>(id: u32, payload: T) -> Self {
        Self { message: text(&OutFrame::ok(id, payload)), renewed: None }
    }

    fn error(id: u32, code: ErrorCode, message: &str) -> Self {
        Self { message: error(Some(id), code, message), renewed: None }
    }
}

async fn dispatch(state: &AppState, principal: &mut Principal, id: u32, frame: &InFrame) -> Reply {
    let malformed = || Reply::error(id, ErrorCode::Malformed, "invalid payload");
    match frame.kind.as_str() {
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
