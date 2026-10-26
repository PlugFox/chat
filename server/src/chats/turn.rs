//! A running turn (docs/protocol.md, "Streaming"): streams the provider's
//! reply as deltas, stores a sealed snapshot every couple of seconds, renews
//! the turn's lease on the chat row (D-083) and ends the reply as complete,
//! cancelled or failed. The turn's text and context live in this task only.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use chat_crypto::{record, scope::ScopePublicKey};
use chat_document::Document;
use chat_protocol::{
    chat::{
        Effort, MessageContent, MessageDelta, MessageState, MessageUpdated, RECORD_MAX, Role, TEXT_MAX, TurnContext,
        TurnDone, TurnError, TurnErrorCode,
    },
    redact::Secret,
};
use sqlx::PgPool;
use tokio::sync::{Notify, broadcast, watch};
use uuid::Uuid;

use super::{bump, error_code, load_chat, load_message, seal_content, state_code};
use crate::{
    agent::Agent,
    app::AppState,
    auth::store::Store,
    bus::{Bus, Note, Target},
    keys::KeysError,
    providers::{ChatRequest, Event, EventStream, Message, ProviderError},
};

/// How often a turn renews its lease and stores a snapshot.
const RENEW: Duration = Duration::from_secs(2);
/// The lease a renewal sets (`interval '30 seconds'` in the queries): a turn
/// that could not renew for this long may have been taken over (D-083).
const LEASE: Duration = Duration::from_secs(30);
const MAX_TOKENS: u32 = 8192;

/// Turns running on this replica, so shutdown can wait for them to write their end.
#[derive(Clone, Debug, Default)]
pub struct Turns {
    running: Arc<AtomicUsize>,
    idle: Arc<Notify>,
}

impl Turns {
    /// Waits until every turn has ended, at most `limit`.
    pub async fn wait_idle(&self, limit: Duration) {
        let _ = tokio::time::timeout(limit, async {
            loop {
                let idle = self.idle.notified();
                if self.running.load(Ordering::SeqCst) == 0 {
                    return;
                }
                idle.await;
            }
        })
        .await;
    }
}

/// Decrements the running count when a turn task ends, however it ends.
struct Running(Turns);

impl Drop for Running {
    fn drop(&mut self) {
        if self.0.running.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

pub struct Plan {
    pub user_id: Uuid,
    /// The auth session that sent the message: revoking it stops the turn.
    pub session_id: Uuid,
    pub chat_id: Uuid,
    pub turn_id: Uuid,
    /// The reply, created streaming and empty before the turn starts (D-090).
    pub reply_id: u32,
    /// An assistant reply or a summary (docs/protocol.md, "Compaction").
    pub author: record::Author,
    pub key: ScopePublicKey,
    pub agent: Agent,
    pub request: ChatRequest,
}

/// Ids only: the request holds the turn's plaintext.
impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plan").field("chat_id", &self.chat_id).field("turn_id", &self.turn_id).finish_non_exhaustive()
    }
}

/// How a reply is written: the client shows it as a document (docs/crypto.md, "Message documents").
const FORMAT: &str = "Write replies in Markdown: CommonMark with GFM tables, task lists and alerts \
(> [!NOTE]). To draw a chart, write a fenced code block of the language chart holding one JSON object: \
{\"kind\": \"line\" | \"area\" | \"bar\" | \"pie\", \"title\"?: string, \"x\"?: x axis title, \"y\"?: y axis \
title, \"labels\": [the points along x, or a pie's slices], \"series\": [{\"name\": string, \"values\": [a number \
or null per label]}]}, with 1 to 8 series (a pie exactly one, with at most 8 labels and no negative values) and 1 to 1000 labels. \
Draw a chart when it shows data better than words or a table do.";

/// The provider request for a turn: the client's context, then the user's message.
pub fn request(context: TurnContext, text: Secret, effort: Option<Effort>) -> ChatRequest {
    let system = Some(match context.summary {
        Some(s) => format!("{FORMAT}\n\nA summary of the conversation so far:\n\n{}", s.0),
        None => FORMAT.to_owned(),
    });
    let mut messages: Vec<Message> = context
        .messages
        .into_iter()
        .map(|m| match m.role {
            Role::User => Message::User(m.text.0),
            Role::Assistant => Message::Assistant { text: m.text.0, tool_calls: Vec::new() },
        })
        .collect();
    messages.push(Message::User(text.0));
    ChatRequest { system, messages, tools: Vec::new(), max_tokens: MAX_TOKENS, effort }
}

/// The instruction of a compaction turn.
const SUMMARIZE: &str = "You compact a conversation between a user and an AI assistant so that it can go on \
without its earlier messages. You get the summary of what came before, if there is one, and the messages \
since, as a transcript. Write one summary that replaces both: the user's goals, what is known about the user \
and their preferences, decisions made, figures, names, dates, code, and open questions and tasks, in enough \
detail that the assistant can carry on as if it had read everything. Keep what the earlier summary holds \
unless the newer messages change it. Write in the language of the conversation, as plain prose and short \
lists, without a preamble. Do not answer or continue the conversation. Begin with a line \
<title>…</title> holding a title for the whole conversation of at most six words in its language, then the \
summary.";

/// The provider request for a summary: the client's context as one transcript,
/// so the model reads the conversation instead of continuing it.
pub fn summary_request(context: TurnContext, effort: Option<Effort>) -> ChatRequest {
    ChatRequest {
        system: Some(SUMMARIZE.to_owned()),
        messages: vec![Message::User(transcript(context))],
        tools: Vec::new(),
        max_tokens: MAX_TOKENS,
        effort,
    }
}

/// The context as tagged text: `<summary>`, then `<user>` and `<assistant>` in order.
pub fn transcript(context: TurnContext) -> String {
    let mut transcript = String::with_capacity(context.bytes() + 64 * (context.messages.len() + 1));
    if let Some(summary) = context.summary {
        transcript.push_str(&format!("<summary>\n{}\n</summary>\n\n", summary.0));
    }
    for message in context.messages {
        let tag = match message.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        transcript.push_str(&format!("<{tag}>\n{}\n</{tag}>\n\n", message.text.0));
    }
    transcript
}

pub fn spawn(state: &AppState, plan: Plan) {
    state.turns.running.fetch_add(1, Ordering::SeqCst);
    let running = Running(state.turns.clone());
    let env = Env {
        db: state.db.clone(),
        bus: state.bus.clone(),
        store: state.auth.store.clone(),
        limit: state.ws.turn_limit,
    };
    // Subscribed before the turn starts, so no note or revocation falls in between.
    let watch = Watch {
        notes: state.bus.subscribe(),
        revocations: state.auth.store.subscribe(),
        shutdown: state.shutdown.clone(),
    };
    tokio::spawn(async move {
        let _running = running;
        run(env, plan, watch).await;
    });
}

struct Env {
    db: PgPool,
    bus: Bus,
    store: Store,
    /// How long a turn may run (D-088).
    limit: Duration,
}

/// The reply so far.
#[derive(Default)]
struct Reply {
    text: String,
    /// The last delta sent, and the last one a stored snapshot includes.
    seq: u32,
    stored: u32,
}

enum End {
    Complete,
    Cancelled,
    Failed(TurnErrorCode),
}

/// Why a write of the turn did not happen.
enum Stop {
    /// The chat is gone, or another turn took the lease: nothing more to write.
    Gone,
    /// The database failed (or sealing did); the turn may try again.
    Broken,
}

impl From<sqlx::Error> for Stop {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "turn cannot write");
        Self::Broken
    }
}

impl From<KeysError> for Stop {
    fn from(e: KeysError) -> Self {
        tracing::error!(error = %e, "turn cannot seal");
        Self::Broken
    }
}

/// Attempts at storing how a turn ended before giving up on the database.
const FINISH_ATTEMPTS: u32 = 3;

fn failure(e: &ProviderError) -> TurnErrorCode {
    match e {
        ProviderError::Blocked => TurnErrorCode::ProviderBlocked,
        ProviderError::Network => TurnErrorCode::ProviderUnreachable,
        ProviderError::Status { .. } => TurnErrorCode::ProviderRefused,
        ProviderError::InvalidConfig(_) | ProviderError::Protocol(_) | ProviderError::TooLarge => {
            TurnErrorCode::ProviderInvalid
        }
    }
}

/// What can end a turn from outside.
struct Watch {
    notes: broadcast::Receiver<Note>,
    revocations: broadcast::Receiver<Uuid>,
    shutdown: watch::Receiver<()>,
}

async fn run(env: Env, plan: Plan, watch: Watch) {
    let mut reply = Reply::default();
    let Ok(end) = drive(&env, &plan, &mut reply, watch).await else { return };
    for attempt in 1..=FINISH_ATTEMPTS {
        match finish(&env, &plan, &reply, &end).await {
            Ok(()) | Err(Stop::Gone) => return,
            Err(Stop::Broken) if attempt < FINISH_ATTEMPTS => tokio::time::sleep(Duration::from_secs(1)).await,
            Err(Stop::Broken) => {}
        }
    }
    // The reply stays streaming until its lease runs out (D-083); the
    // client still learns that the turn ended.
    let (chat_id, turn_id) = (plan.chat_id, plan.turn_id);
    let error = TurnError { chat_id, turn_id, code: TurnErrorCode::Interrupted };
    env.bus.publish(Note::event(Target::User(plan.user_id), &error)).await;
}

async fn next(stream: &mut Option<EventStream>) -> Option<Result<Event, ProviderError>> {
    stream.as_mut()?.recv().await
}

/// How the note ends this chat's turn, if it does. A gap in the notes is
/// ignored: the user can cancel again, and a lost retirement leaves the turn
/// to its time limit.
fn ends(note: Result<Note, broadcast::error::RecvError>, plan: &Plan) -> Option<End> {
    match note {
        Ok(Note::Cancel { chat_id, turn_id }) if chat_id == plan.chat_id && turn_id == plan.turn_id => {
            Some(End::Cancelled)
        }
        Ok(Note::Retire { user_id, fingerprints })
            if user_id == plan.user_id && fingerprints.contains(&plan.agent.fingerprint) =>
        {
            Some(End::Failed(TurnErrorCode::Interrupted))
        }
        _ => None,
    }
}

/// Whether the auth session is revoked or may be; a turn that cannot tell
/// stops, as a detached agent session does.
async fn revoked(env: &Env, plan: &Plan) -> bool {
    !matches!(env.store.is_revoked(plan.session_id).await, Ok(false))
}

async fn drive(env: &Env, plan: &Plan, reply: &mut Reply, watch: Watch) -> Result<End, Stop> {
    let Watch { mut notes, mut revocations, mut shutdown } = watch;
    // The session may have been revoked since the send was authorized.
    if revoked(env, plan).await {
        return Ok(End::Failed(TurnErrorCode::Interrupted));
    }
    let mut interrupted = plan.agent.interrupted.clone();
    let deadline = tokio::time::sleep(env.limit);
    tokio::pin!(deadline);
    let provider = plan.agent.provider.clone();
    let connect = provider.stream(&plan.request);
    tokio::pin!(connect);
    let mut stream: Option<EventStream> = None;
    let mut tick = tokio::time::interval(RENEW);
    tick.tick().await;
    let mut renewed = tokio::time::Instant::now();
    loop {
        tokio::select! {
            started = &mut connect, if stream.is_none() => match started {
                Ok(s) => stream = Some(s),
                Err(e) => return Ok(End::Failed(failure(&e))),
            },
            event = next(&mut stream), if stream.is_some() => match event {
                Some(Ok(Event::Text(text))) => {
                    if reply.text.len() + text.len() > TEXT_MAX {
                        return Ok(End::Failed(TurnErrorCode::TooLong));
                    }
                    reply.text.push_str(&text);
                    reply.seq += 1;
                    let delta =
                        MessageDelta { chat_id: plan.chat_id, message_id: plan.reply_id, seq: reply.seq, text: Secret(text) };
                    env.bus.publish(Note::event(Target::User(plan.user_id), &delta)).await;
                }
                // No tools are offered yet (docs/roadmap.md, "Agent tools").
                Some(Ok(Event::ToolCall(_))) => {}
                Some(Ok(Event::Done(_))) => return Ok(End::Complete),
                Some(Err(e)) => return Ok(End::Failed(failure(&e))),
                None => return Ok(End::Failed(TurnErrorCode::ProviderInvalid)),
            },
            // A failed write is tried again on the next tick; the lease
            // outlasts a few of them.
            _ = tick.tick() => {
                match renew(env, plan).await {
                    Ok(()) => renewed = tokio::time::Instant::now(),
                    Err(Stop::Gone) => return Err(Stop::Gone),
                    // Past its lease another send or retry may run the reply
                    // again: this one stops writing to it, deltas included.
                    Err(Stop::Broken) if renewed.elapsed() >= LEASE => {
                        return Ok(End::Failed(TurnErrorCode::Interrupted));
                    }
                    Err(Stop::Broken) => {}
                }
                if reply.seq != reply.stored
                    && let Err(Stop::Gone) = snapshot(env, plan, reply).await
                {
                    return Err(Stop::Gone);
                }
            }
            note = notes.recv() => if let Some(end) = ends(note, plan) {
                return Ok(end);
            },
            revocation = revocations.recv() => match revocation {
                Ok(session) if session == plan.session_id => return Ok(End::Failed(TurnErrorCode::Interrupted)),
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => if revoked(env, plan).await {
                    return Ok(End::Failed(TurnErrorCode::Interrupted));
                },
                Err(broadcast::error::RecvError::Closed) => return Ok(End::Failed(TurnErrorCode::Interrupted)),
            },
            () = &mut deadline => return Ok(End::Failed(TurnErrorCode::TimedOut)),
            _ = interrupted.changed() => return Ok(End::Failed(TurnErrorCode::Interrupted)),
            _ = shutdown.changed() => return Ok(End::Failed(TurnErrorCode::Interrupted)),
        }
    }
}

/// Extends the lease while this turn still holds it.
async fn renew(env: &Env, plan: &Plan) -> Result<(), Stop> {
    let renewed =
        sqlx::query("UPDATE chats SET turn_expires_at = now() + interval '30 seconds' WHERE id = $1 AND turn_id = $2")
            .bind(plan.chat_id)
            .bind(plan.turn_id)
            .execute(&env.db)
            .await?
            .rows_affected();
    if renewed == 1 { Ok(()) } else { Err(Stop::Gone) }
}

/// Locks the chat row while this turn holds it.
async fn hold(conn: &mut sqlx::PgConnection, plan: &Plan) -> Result<(), Stop> {
    let held: Option<i32> = sqlx::query_scalar("SELECT 1 FROM chats WHERE id = $1 AND turn_id = $2 FOR UPDATE")
        .bind(plan.chat_id)
        .bind(plan.turn_id)
        .fetch_optional(conn)
        .await?;
    held.map(|_| ()).ok_or(Stop::Gone)
}

/// Stores the reply so far in the message's record; `state` ends it unless
/// streaming, and a failed one carries its code.
async fn store(
    conn: &mut sqlx::PgConnection,
    plan: &Plan,
    reply: &Reply,
    state: MessageState,
    error: Option<TurnErrorCode>,
) -> Result<chat_protocol::chat::ChatMessage, Stop> {
    let id = plan.reply_id;
    // Snapshots carry the text only: the document is made once, from the whole
    // reply, and left out when the record cannot hold both.
    let mut content = MessageContent { text: reply.text.clone(), doc: None };
    if state != MessageState::Streaming {
        content.doc = document(plan.author, &reply.text);
    }
    let mut record = seal_content(plan.user_id, plan.chat_id, id, plan.author, &plan.key, &content)?;
    if record.len() > RECORD_MAX && content.doc.take().is_some() {
        record = seal_content(plan.user_id, plan.chat_id, id, plan.author, &plan.key, &content)?;
    }
    let rev = bump(conn, plan.chat_id).await?;
    sqlx::query(
        "UPDATE messages SET record = $3, seq = $4, state = $5, rev = $6, error = $7 WHERE chat_id = $1 AND id = $2",
    )
    .bind(plan.chat_id)
    .bind(i64::from(id))
    .bind(&record)
    .bind(i32::try_from(reply.seq).unwrap_or(i32::MAX))
    .bind(state_code(state))
    .bind(rev)
    .bind(error.map(error_code))
    .execute(&mut *conn)
    .await?;
    Ok(load_message(conn, plan.chat_id, id).await?)
}

/// The reply as a document (docs/crypto.md, "Message documents"); a summary's
/// leaves out its title line, as the client does (docs/protocol.md, "Titles").
fn document(author: record::Author, text: &str) -> Option<Document> {
    let body = match author {
        record::Author::Summary => without_title(text),
        _ => text,
    };
    if body.trim().is_empty() {
        return None;
    }
    Some(chat_document::from_markdown(body))
}

fn without_title(text: &str) -> &str {
    const OPEN: &str = "<title>";
    const CLOSE: &str = "</title>";
    let Some(rest) = text.trim_start().strip_prefix(OPEN) else { return text };
    let newline = rest.find('\n');
    match rest.find(CLOSE) {
        Some(close) if newline.is_none_or(|n| close < n) => rest[close + CLOSE.len()..].trim_start(),
        _ => newline.map_or("", |n| rest[n + 1..].trim_start()),
    }
}

async fn snapshot(env: &Env, plan: &Plan, reply: &mut Reply) -> Result<(), Stop> {
    let mut tx = env.db.begin().await?;
    hold(&mut tx, plan).await?;
    let message = store(&mut tx, plan, reply, MessageState::Streaming, None).await?;
    tx.commit().await?;
    reply.stored = reply.seq;
    env.bus.publish(Note::event(Target::User(plan.user_id), &MessageUpdated { chat_id: plan.chat_id, message })).await;
    Ok(())
}

async fn finish(env: &Env, plan: &Plan, reply: &Reply, end: &End) -> Result<(), Stop> {
    let mut tx = env.db.begin().await?;
    hold(&mut tx, plan).await?;
    let (state, error) = match end {
        End::Complete => (MessageState::Complete, None),
        End::Cancelled => (MessageState::Cancelled, None),
        End::Failed(code) => (MessageState::Failed, Some(*code)),
    };
    let message = store(&mut tx, plan, reply, state, error).await?;
    sqlx::query("UPDATE chats SET turn_id = NULL, turn_expires_at = NULL, rev = rev + 1 WHERE id = $1")
        .bind(plan.chat_id)
        .execute(&mut *tx)
        .await?;
    let chat = load_chat(&mut tx, plan.chat_id).await?;
    tx.commit().await?;
    let (target, chat_id, turn_id) = (Target::User(plan.user_id), plan.chat_id, plan.turn_id);
    env.bus.publish(Note::event(target, &MessageUpdated { chat_id, message })).await;
    env.bus.publish(Note::event(target, &chat_protocol::chat::ChatUpdated { chat })).await;
    let ended = match end {
        End::Failed(code) => Note::event(target, &TurnError { chat_id, turn_id, code: *code }),
        End::Complete | End::Cancelled => Note::event(target, &TurnDone { chat_id, turn_id }),
    };
    env.bus.publish(ended).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chat_protocol::{chat::TurnContext, redact::Secret};

    use super::{FORMAT, request, without_title};

    #[test]
    fn a_turn_tells_the_model_the_format_then_the_summary() {
        let bare = request(TurnContext::default(), Secret("Hi".into()), None);
        assert_eq!(bare.system.as_deref(), Some(FORMAT));
        let context = TurnContext { summary: Some(Secret("Ann likes tea.".into())), messages: Vec::new() };
        let system = request(context, Secret("Hi".into()), None).system.unwrap_or_default();
        assert!(system.starts_with(FORMAT) && system.ends_with("so far:\n\nAnn likes tea."));
    }

    #[test]
    fn a_summary_loses_its_title_line_as_the_client_splits_it() {
        assert_eq!(without_title("<title>Trip</title>\nBody"), "Body");
        assert_eq!(without_title("  <title>Trip</title> Body"), "Body");
        // A tag left open ends at the line's end.
        assert_eq!(without_title("<title>Trip\nBody"), "Body");
        assert_eq!(without_title("<title>Trip"), "");
        assert_eq!(without_title("Body <title>x</title>"), "Body <title>x</title>");
    }
}
