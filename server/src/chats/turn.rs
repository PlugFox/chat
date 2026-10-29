//! A running turn (docs/protocol.md, "Streaming"): streams the provider's
//! reply as deltas, stores a sealed snapshot every couple of seconds, renews
//! the turn's lease on the chat row (D-083) and ends the reply as complete,
//! cancelled or failed. The turn's text and context live in this task only.

use std::{
    collections::{HashSet, VecDeque},
    pin::Pin,
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
        Effort, MessageContent, MessageDelta, MessageState, MessageUpdated, RECORD_MAX, Role, TEXT_MAX, ToolUse,
        TurnContext, TurnDone, TurnError, TurnErrorCode,
    },
    files::{FILE_MAX, TURN_IMAGES_MAX},
    permissions::{Grant, HISTORY_MAX, HISTORY_TURN_MAX, Outcome},
    redact::Secret,
};
use sqlx::PgPool;
use tokio::{
    sync::{Notify, broadcast, watch},
    task::JoinSet,
};
use uuid::Uuid;

pub use super::attachments::TurnFile;
use super::{
    attachments::{self, Content, Describe, NoRoom},
    bump, error_code, load_chat, load_message, seal_content, state_code,
    tools::{self, CALLS_MAX, Call},
};
use crate::{
    agent::Agent,
    app::AppState,
    auth::store::Store,
    bus::{Bus, Note, Target},
    files::{self, FileStore, store::Room},
    keys::KeysError,
    permissions::{self, Answer, Ask},
    providers::{ChatRequest, Event, EventStream, FilePart, Message, Provider, ProviderError, ToolCall},
    registers,
};

/// How often a turn renews its lease and stores a snapshot.
const RENEW: Duration = Duration::from_secs(2);
/// The lease a renewal sets (`interval '30 seconds'` in the queries): a turn
/// that could not renew for this long may have been taken over (D-083).
const LEASE: Duration = Duration::from_secs(30);
const MAX_TOKENS: u32 = 8192;
/// How long a permission request waits for the user (docs/protocol.md,
/// "Permissions and the access log").
const REQUEST_WAIT: Duration = Duration::from_secs(5 * 60);
/// What a request leaves of the turn's own limit, for the reply after it.
const REPLY_TIME: Duration = Duration::from_secs(30);
/// How long a turn waits for an answer that was stored but did not arrive.
const LOST_WAIT: Duration = Duration::from_secs(5);
/// How long a `read_history` request waits: the client answers it unasked (D-100).
const HISTORY_WAIT: Duration = Duration::from_secs(30);
/// How long descriptions may run on after their turn's reply ended.
const DESCRIBE_AFTER: Duration = Duration::from_secs(60);

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
    /// The first message of the context: `read_history` reads before it; 0 when nothing is before it.
    pub history: u32,
    /// The files of the message the turn answers, given to the model.
    pub files: Vec<TurnFile>,
    /// The chat has other files, which `read_file` opens.
    pub read_files: bool,
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

/// The first message a turn's context holds, or the message it answers (`reply_id − 1`).
pub fn first_of(context: &TurnContext, reply_id: u32) -> u32 {
    context.messages.first().map_or(reply_id.saturating_sub(1), |m| m.id.min(reply_id.saturating_sub(1)))
}

/// The provider request for a turn: the client's context, then the user's
/// message; `history` is [`first_of`] the context, `files` whether the chat
/// has files `read_file` may open. The message's own files join it in the turn.
pub fn request(context: TurnContext, text: Secret, effort: Option<Effort>, history: u32, files: bool) -> ChatRequest {
    let mut guide = match history {
        0 => tools::GUIDE.to_owned(),
        first => format!("{} {}", tools::GUIDE, tools::history_guide(first)),
    };
    if files {
        guide = format!("{guide} {}", tools::FILES_GUIDE);
    }
    let system = Some(match context.summary {
        Some(s) => format!("{FORMAT}\n\n{guide}\n\nA summary of the conversation so far:\n\n{}", s.0),
        None => format!("{FORMAT}\n\n{guide}"),
    });
    let mut messages: Vec<Message> = context
        .messages
        .into_iter()
        .map(|m| match m.role {
            Role::User => Message::User(attachments::context_text(&m)),
            Role::Assistant => Message::Assistant { text: m.text.0, tool_calls: Vec::new() },
        })
        .collect();
    messages.push(Message::User(text.0));
    ChatRequest { system, messages, tools: tools::specs(history > 0, files), max_tokens: MAX_TOKENS, effort }
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
        files: state.files.clone(),
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
    files: Option<FileStore>,
}

/// The reply so far.
#[derive(Default)]
struct Reply {
    text: String,
    /// The last delta sent, and the last one a stored snapshot includes.
    seq: u32,
    stored: u32,
    /// The turn's tool calls, as the record keeps them (D-099).
    tools: Vec<ToolUse>,
    /// A change to `tools` no snapshot holds yet.
    dirty: bool,
    /// The permission request the turn waits on, and its call in `tools`.
    waiting: Option<(Uuid, usize)>,
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
    let mut describing = JoinSet::new();
    let driven = drive(&env, &plan, &mut reply, watch, &mut describing).await;
    // Descriptions run beside the reply and may outlast it a little; an
    // interrupted turn (a retired provider, a revoked session) stops them.
    if matches!(driven, Ok(End::Failed(TurnErrorCode::Interrupted)) | Err(_)) {
        describing.abort_all();
    }
    let described = async { while describing.join_next().await.is_some() {} };
    let finishing = finish_all(&env, &plan, &mut reply, driven);
    let ((), ()) = tokio::join!(finishing, async {
        let _ = tokio::time::timeout(DESCRIBE_AFTER, described).await;
    });
}

async fn finish_all(env: &Env, plan: &Plan, reply: &mut Reply, driven: Result<End, Stop>) {
    // The turn ended while the user had not answered: the dialog closes.
    if let Some((request_id, index)) = reply.waiting.take() {
        // An answer stored first keeps its outcome, in the log and in the reply.
        let outcome = match permissions::close(&env.db, &env.bus, request_id, Outcome::Cancelled).await {
            Ok(true) => Some(Outcome::Cancelled),
            Ok(false) => permissions::outcome(&env.db, request_id).await.ok().flatten(),
            Err(e) => {
                tracing::error!(error = %e, "cannot close a permission request");
                None
            }
        };
        if let Some(call) = reply.tools.get_mut(index) {
            call.outcome = Some(outcome.unwrap_or(Outcome::Cancelled));
        }
    }
    let Ok(end) = driven else { return };
    for attempt in 1..=FINISH_ATTEMPTS {
        match finish(env, plan, reply, &end).await {
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

/// What the turn waits for besides its lease, notes and limits.
enum Phase {
    Connecting(Pin<Box<dyn Future<Output = Result<EventStream, ProviderError>> + Send>>),
    Streaming(EventStream),
    /// A permission request (docs/protocol.md, "Permissions and the access log").
    Waiting(Waiting),
    /// Between two steps; never waited on.
    Idle,
}

struct Waiting {
    request_id: Uuid,
    call: Call,
    /// When the request times out.
    expires: tokio::time::Instant,
    /// When the turn looks next: `expires`, or sooner to look the outcome up.
    until: tokio::time::Instant,
    /// The answer may have been missed on the bus: the database tells.
    lost: bool,
}

enum Progress {
    Connected(Result<EventStream, ProviderError>),
    Event(Option<Result<Event, ProviderError>>),
    Expired,
}

async fn progress(phase: &mut Phase) -> Progress {
    match phase {
        Phase::Connecting(connect) => Progress::Connected(connect.await),
        Phase::Streaming(stream) => Progress::Event(stream.recv().await),
        Phase::Waiting(waiting) => {
            tokio::time::sleep_until(waiting.until).await;
            Progress::Expired
        }
        Phase::Idle => std::future::pending().await,
    }
}

fn connect(provider: Arc<Provider>, request: ChatRequest) -> Phase {
    Phase::Connecting(Box::pin(async move { provider.stream(&request).await }))
}

/// One provider request and the tool calls it ended with.
#[derive(Default)]
struct Round {
    text: String,
    calls: Vec<ToolCall>,
    /// Calls not run yet, and the answers of those run, in order.
    queue: VecDeque<ToolCall>,
    results: Vec<Message>,
    /// Files `read_file` opened, given to the model after the results.
    files: Vec<FilePart>,
    /// The call waiting for the user.
    current: Option<ToolCall>,
}

/// The turn's conversation with the provider, round after round.
struct Run<'a> {
    request: ChatRequest,
    round: Round,
    /// Tool calls so far, against [`CALLS_MAX`].
    calls: usize,
    /// Grants the user denied (or the client refused) in this turn, by tool and metric.
    denied: Vec<((&'static str, Option<String>), Outcome)>,
    /// Bytes of history read in this turn, against [`HISTORY_TURN_MAX`].
    history: usize,
    /// Files given to the model so far: their ids, bytes and images, against
    /// [`FILE_MAX`] and [`TURN_IMAGES_MAX`].
    opened: HashSet<Uuid>,
    file_bytes: u64,
    images: usize,
    /// The files' room in the memory budget, held as long as the request holds them.
    rooms: Vec<Room>,
    /// Descriptions of the files given, running beside the reply.
    describing: &'a mut JoinSet<()>,
    /// The next round's first text starts a new paragraph of the reply.
    gap: bool,
    started: tokio::time::Instant,
}

fn grant_key(call: &Call) -> (&'static str, Option<String>) {
    match call {
        Call::ListMetrics => (tools::LIST_METRICS, None),
        Call::ReadRegister { metric, .. } => (tools::READ_REGISTER, Some(metric.clone())),
        Call::SessionContext { .. } => (tools::SESSION_CONTEXT, None),
        Call::ReadHistory { .. } => (tools::READ_HISTORY, None),
        Call::ReadFile { file_id, .. } => (tools::READ_FILE, Some(file_id.to_string())),
    }
}

fn tool_use(name: &str, call: Option<&Call>, outcome: Option<Outcome>) -> ToolUse {
    match call {
        Some(Call::ReadRegister { metric, from, to, .. }) => ToolUse {
            tool: name.to_owned(),
            metric: Some(metric.clone()),
            from: from.map(tools::day),
            to: to.map(tools::day),
            count: None,
            outcome,
        },
        // The count asked for; an answer replaces it with the messages read.
        Some(Call::ReadHistory { count, .. }) => ToolUse {
            tool: name.to_owned(),
            metric: None,
            from: None,
            to: None,
            count: (outcome != Some(Outcome::Answered)).then_some(*count),
            outcome,
        },
        _ => ToolUse { tool: name.to_owned(), metric: None, from: None, to: None, count: None, outcome },
    }
}

/// What the server tells the model about a call it answers itself, or why
/// it asks the user; `None` asks.
async fn answer_locally(env: &Env, plan: &Plan, run: &Run<'_>, call: &Call) -> Option<(String, Outcome)> {
    let key = grant_key(call);
    if let Some((_, outcome)) = run.denied.iter().find(|(k, _)| *k == key) {
        let text = match outcome {
            Outcome::Refused => "The user's app could not read this data earlier in this turn.",
            _ => "The user denied this request earlier in this turn.",
        };
        return Some((text.into(), *outcome));
    }
    if let Call::ReadFile { file_id, .. } = call {
        if run.opened.contains(file_id) {
            return Some(("This file is attached above in this turn.".into(), Outcome::Answered));
        }
        let size = match files::attached_size(&env.db, plan.chat_id, *file_id).await {
            Ok(size) => size,
            Err(e) => {
                tracing::error!(error = %e, "cannot look up a file for a turn");
                return Some((tools::error("the file could not be looked up; try again later"), Outcome::Answered));
            }
        };
        let Some(size) = size.filter(|_| env.files.is_some()) else {
            return Some((tools::error("this chat has no file with that id"), Outcome::Answered));
        };
        if run.file_bytes + u64::from(size) > u64::from(FILE_MAX) || run.images >= TURN_IMAGES_MAX {
            let text = "this turn has given the model as many files as it may; answer with what you have";
            return Some((tools::error(text), Outcome::Answered));
        }
        return None;
    }
    if let Call::ReadHistory { .. } = call {
        if plan.history == 0 {
            return Some((serde_json::json!({ "messages": [] }).to_string(), Outcome::Answered));
        }
        if run.history + HISTORY_MAX > HISTORY_TURN_MAX {
            let text = "this turn has read as much history as it may; answer with what you have";
            return Some((tools::error(text), Outcome::Answered));
        }
        return None;
    }
    let Call::ReadRegister { metric, from, to, .. } = call else {
        if let Call::ListMetrics = call {
            return Some(match registers::catalog_of(&env.db, plan.user_id).await {
                Ok(catalog) => (tools::metrics(&catalog), Outcome::Answered),
                Err(e) => {
                    tracing::error!(error = %e, "cannot list metrics for a turn");
                    (tools::error("the metrics could not be read; try again later"), Outcome::Answered)
                }
            });
        }
        return None;
    };
    let failed = |e: sqlx::Error| {
        tracing::error!(error = %e, "cannot look up a register for a turn");
        Some((tools::error("the register could not be read; try again later"), Outcome::Answered))
    };
    let catalog = match registers::catalog_of(&env.db, plan.user_id).await {
        Ok(catalog) => catalog,
        Err(e) => return failed(e),
    };
    if !catalog.metrics.iter().any(|m| &m.key == metric) {
        return Some((tools::error("no such metric; list_metrics tells the keys"), Outcome::Answered));
    }
    let none = || Some((serde_json::json!({ "metric": metric, "entries": [] }).to_string(), Outcome::Answered));
    let Some(register) = catalog.registers.iter().find(|r| &r.metric == metric) else { return none() };
    let (start, end) = tools::span(*from, *to);
    match registers::count_between(&env.db, register.scope_id, start, end).await {
        Ok(0) => none(),
        Ok(_) => None,
        Err(e) => failed(e),
    }
}

/// Runs the round's calls in order until one needs the user, then the next round.
async fn advance(env: &Env, plan: &Plan, reply: &mut Reply, run: &mut Run<'_>, phase: &mut Phase) -> Result<(), Stop> {
    while let Some(call) = run.round.queue.pop_front() {
        run.calls += 1;
        let parsed = tools::parse(&call);
        let answered = |content: String, outcome: Option<Outcome>| (content, outcome);
        let (content, outcome) = match &parsed {
            _ if run.calls > CALLS_MAX => answered(
                tools::error("this turn made too many tool calls; answer with what you have"),
                Some(Outcome::Answered),
            ),
            Err(e) => answered(tools::error(e), Some(Outcome::Answered)),
            Ok(c) => match answer_locally(env, plan, run, c).await {
                Some((content, outcome)) => answered(content, Some(outcome)),
                None => {
                    ask(env, plan, reply, run, phase, call, c.clone()).await?;
                    return Ok(());
                }
            },
        };
        reply.tools.push(tool_use(&call.name, parsed.as_ref().ok(), outcome));
        reply.dirty = true;
        run.round.results.push(Message::Tool { call_id: call.id, content });
    }
    // Past the limit the model is offered no tools, so it has to reply.
    if run.calls >= CALLS_MAX {
        run.request.tools.clear();
    }
    let round = std::mem::take(&mut run.round);
    run.request.messages.push(Message::Assistant { text: round.text, tool_calls: round.calls });
    run.request.messages.extend(round.results);
    // After every result: tool messages must follow the call that made them.
    if !round.files.is_empty() {
        run.request.messages.push(Message::Files(round.files));
    }
    run.gap = !reply.text.is_empty();
    *phase = connect(plan.agent.provider.clone(), run.request.clone());
    Ok(())
}

/// Writes the request, tells the auth session and waits.
async fn ask(
    env: &Env,
    plan: &Plan,
    reply: &mut Reply,
    run: &mut Run<'_>,
    phase: &mut Phase,
    call: ToolCall,
    parsed: Call,
) -> Result<(), Stop> {
    let (grant, reason) = match &parsed {
        Call::ReadRegister { metric, from, to, reason } => {
            let scope_id = match registers::catalog_of(&env.db, plan.user_id).await {
                Ok(catalog) => catalog.registers.iter().find(|r| &r.metric == metric).map(|r| r.scope_id),
                Err(e) => {
                    tracing::error!(error = %e, "cannot look up a register for a turn");
                    None
                }
            };
            // Gone since it was counted, or the database failed.
            let Some(scope_id) = scope_id else { return unasked(env, plan, reply, run, phase, call, &parsed).await };
            let grant = Grant::ReadRegister {
                metric: metric.clone(),
                scope_id,
                from: from.map(tools::day),
                to: to.map(tools::day),
            };
            (grant, reason.as_str())
        }
        Call::SessionContext { reason } => (Grant::SessionContext {}, reason.as_str()),
        Call::ReadHistory { before, count, reason } => {
            // Within the chat's messages before the context: those in it the model has.
            let before = before.map_or(plan.history, |b| b.min(plan.history));
            (Grant::ReadHistory { before, count: *count }, reason.as_str())
        }
        Call::ReadFile { file_id, reason } => (Grant::ReadFile { file_id: *file_id }, reason.as_str()),
        Call::ListMetrics => return unasked(env, plan, reply, run, phase, call, &parsed).await,
    };
    let most =
        if matches!(parsed, Call::ReadHistory { .. } | Call::ReadFile { .. }) { HISTORY_WAIT } else { REQUEST_WAIT };
    // A request ends early enough for the model to reply within the turn's limit.
    let wait = most.min(env.limit.saturating_sub(run.started.elapsed()).saturating_sub(REPLY_TIME));
    let asked = permissions::ask(
        &env.db,
        Ask {
            user_id: plan.user_id,
            session_id: plan.session_id,
            chat_id: plan.chat_id,
            turn_id: plan.turn_id,
            provider_id: plan.agent.provider_id,
            grant: &grant,
            reason,
            wait,
        },
    )
    .await;
    let request = match asked {
        Ok(request) => request,
        Err(e) => {
            tracing::error!(error = %e, "cannot write a permission request");
            return unasked(env, plan, reply, run, phase, call, &parsed).await;
        }
    };
    env.bus.publish(Note::event(Target::Session(plan.session_id), &request)).await;
    reply.waiting = Some((request.request_id, reply.tools.len()));
    reply.tools.push(tool_use(&call.name, Some(&parsed), None));
    reply.dirty = true;
    run.round.current = Some(call);
    *phase = Phase::Waiting(Waiting {
        request_id: request.request_id,
        call: parsed,
        expires: tokio::time::Instant::now() + wait,
        until: tokio::time::Instant::now() + wait,
        lost: false,
    });
    // The call shows in the reply at once; a failed write is the next tick's.
    match snapshot(env, plan, reply).await {
        Err(Stop::Gone) => Err(Stop::Gone),
        _ => Ok(()),
    }
}

/// A request that could not be made: the model hears so and the round goes on.
async fn unasked(
    env: &Env,
    plan: &Plan,
    reply: &mut Reply,
    run: &mut Run<'_>,
    phase: &mut Phase,
    call: ToolCall,
    parsed: &Call,
) -> Result<(), Stop> {
    reply.tools.push(tool_use(&call.name, Some(parsed), Some(Outcome::Answered)));
    reply.dirty = true;
    let content = tools::error("the request could not be made; try again later");
    run.round.results.push(Message::Tool { call_id: call.id, content });
    Box::pin(advance(env, plan, reply, run, phase)).await
}

/// The waiting request ended: the model gets its answer and the round goes on.
async fn resolve(
    env: &Env,
    plan: &Plan,
    reply: &mut Reply,
    run: &mut Run<'_>,
    phase: &mut Phase,
    answer: Answer,
    lost: bool,
) -> Result<(), Stop> {
    let Phase::Waiting(waiting) = std::mem::replace(phase, Phase::Idle) else { return Ok(()) };
    // A waiting phase always has its call.
    let Some(call) = run.round.current.take() else { return Ok(()) };
    let history = matches!(waiting.call, Call::ReadHistory { .. });
    let reading = matches!(waiting.call, Call::ReadFile { .. });
    let content = match answer.outcome {
        _ if lost && history => tools::error("the app's answer was lost on the way; read_history may be called again"),
        _ if lost && reading => tools::error("the app's answer was lost on the way; read_file may be called again"),
        Outcome::Answered if reading => read_file(env, plan, run, &waiting.call, answer.result.as_ref()).await,
        _ if lost => tools::error("the user's answer was lost on the way; they may ask again"),
        Outcome::Approved => match &waiting.call {
            Call::ReadRegister { .. } => answer.result.map_or_else(|| tools::error("no result"), |r| r.0),
            _ => match permissions::session_context(&env.db, plan.session_id).await {
                Ok(context) => context.to_string(),
                Err(e) => {
                    tracing::error!(error = %e, "cannot read the session for a turn");
                    tools::error("the session could not be read; try again later")
                }
            },
        },
        Outcome::Answered if history => answer.result.map_or_else(|| tools::error("no result"), |r| r.0),
        Outcome::Denied => "The user denied this request. Answer without this data.".into(),
        Outcome::Refused => "The user's app could not read this data.".into(),
        Outcome::Timeout => "The user did not answer the request in time.".into(),
        Outcome::Cancelled | Outcome::Answered => "The request ended without an answer.".into(),
    };
    if matches!(answer.outcome, Outcome::Denied | Outcome::Refused) {
        run.denied.push((grant_key(&waiting.call), answer.outcome));
    }
    let read = history && answer.outcome == Outcome::Answered && !lost;
    if read {
        run.history += content.len();
    }
    if let Some((_, index)) = reply.waiting.take()
        && let Some(used) = reply.tools.get_mut(index)
    {
        used.outcome = Some(answer.outcome);
        if history && answer.outcome == Outcome::Answered {
            used.count = read.then(|| tools::history_count(&content));
        }
    }
    reply.dirty = true;
    run.round.results.push(Message::Tool { call_id: call.id, content });
    advance(env, plan, reply, run, phase).await
}

/// Opens the file a `read_file` answer gave the key of; the model gets it
/// after the round's results, and this text as the call's result.
async fn read_file(env: &Env, plan: &Plan, run: &mut Run<'_>, call: &Call, result: Option<&Secret>) -> String {
    let (Call::ReadFile { file_id, .. }, Some(store)) = (call, env.files.as_ref()) else {
        return tools::error("no result");
    };
    let Some(key) = result.and_then(|r| permissions::content_key(&r.0)) else { return tools::error("no result") };
    let key = zeroize::Zeroizing::new(key);
    let size = match files::attached_size(&env.db, plan.chat_id, *file_id).await {
        Ok(Some(size)) => size,
        Ok(None) => return tools::error("this chat has no file with that id"),
        Err(e) => {
            tracing::error!(error = %e, "cannot look up a file for a turn");
            return tools::error("the file could not be looked up; try again later");
        }
    };
    let Some(room) = store.room(size).await else {
        return tools::error("the server has no room to open the file now; try again later");
    };
    match files::open(store, plan.user_id, *file_id, key.as_slice(), size).await {
        Ok(data) => {
            let bytes = u64::try_from(data.len()).unwrap_or(u64::MAX);
            let (parts, content) = attachments::parts(*file_id, "", data);
            if matches!(content, Content::Image(_)) && run.images >= TURN_IMAGES_MAX {
                return tools::error("this turn has given the model as many images as it may");
            }
            run.images += usize::from(matches!(content, Content::Image(_)));
            run.file_bytes += bytes;
            run.opened.insert(*file_id);
            // A file a crash or a failed try left undescribed gets another try.
            describe(env, plan, run, *file_id, &parts, &room);
            run.round.files.extend(parts);
            run.rooms.push(room);
            "The file is attached after these results.".into()
        }
        Err(_) => tools::error("the file could not be opened"),
    }
}

/// The request's time ran out: it times out, unless an answer was stored
/// first and is still on its way.
async fn expired(env: &Env, plan: &Plan, reply: &mut Reply, run: &mut Run<'_>, phase: &mut Phase) -> Result<(), Stop> {
    let Phase::Waiting(waiting) = phase else { return Ok(()) };
    let request_id = waiting.request_id;
    // A database that fails is asked again shortly; the turn's limit still holds.
    let retry = |waiting: &mut Waiting, e: sqlx::Error| {
        tracing::error!(error = %e, "cannot end a permission request");
        waiting.until = tokio::time::Instant::now() + RENEW;
    };
    if waiting.lost {
        let outcome = match permissions::outcome(&env.db, request_id).await {
            Ok(outcome) => outcome,
            Err(e) => {
                retry(waiting, e);
                return Ok(());
            }
        };
        let Some(outcome) = outcome else {
            // Nothing was missed: the request still waits for the user.
            waiting.lost = false;
            waiting.until = waiting.expires;
            return Ok(());
        };
        // Only a register read's or history's result travels with the answer; the rest the server knows.
        let lost = match waiting.call {
            Call::ReadRegister { .. } => outcome == Outcome::Approved,
            Call::ReadHistory { .. } | Call::ReadFile { .. } => outcome == Outcome::Answered,
            _ => false,
        };
        let answer = Answer { request_id, outcome, result: None };
        return resolve(env, plan, reply, run, phase, answer, lost).await;
    }
    if tokio::time::Instant::now() < waiting.expires {
        return Ok(());
    }
    match permissions::close(&env.db, &env.bus, request_id, Outcome::Timeout).await {
        Ok(true) => {
            let answer = Answer { request_id, outcome: Outcome::Timeout, result: None };
            resolve(env, plan, reply, run, phase, answer, false).await
        }
        Ok(false) => {
            waiting.lost = true;
            waiting.until = tokio::time::Instant::now() + LOST_WAIT;
            Ok(())
        }
        Err(e) => {
            retry(waiting, e);
            Ok(())
        }
    }
}

/// How a tool step that could not go on ends the turn: nothing more is
/// written to a chat that is gone; anything else still stores the reply.
fn halt(stop: Stop) -> Result<End, Stop> {
    match stop {
        Stop::Gone => Err(Stop::Gone),
        Stop::Broken => Ok(End::Failed(TurnErrorCode::Interrupted)),
    }
}

/// Gives the model the files of the message the turn answers, before its
/// text, and asks for a description of each that has none.
async fn give_files(env: &Env, plan: &Plan, run: &mut Run<'_>) -> Result<(), NoRoom> {
    let Some(store) = env.files.as_ref().filter(|_| !plan.files.is_empty()) else { return Ok(()) };
    let mut parts = Vec::new();
    for opened in attachments::open_all(store, plan.user_id, &plan.files).await? {
        if opened.content != Content::Unreadable {
            run.opened.insert(opened.file_id);
            run.images += usize::from(matches!(opened.content, Content::Image(_)));
            run.file_bytes += opened.parts.iter().map(attachments::part_bytes).sum::<u64>();
            describe(env, plan, run, opened.file_id, &opened.parts, &opened.room);
        }
        parts.extend(opened.parts);
        run.rooms.push(opened.room);
    }
    // The files come before the message's text, which is the request's last.
    let at = run.request.messages.len().saturating_sub(1);
    run.request.messages.insert(at, Message::Files(parts));
    Ok(())
}

/// Asks for a file's description beside the reply, if it still needs one
/// and has tries left; the try sees to both.
fn describe(env: &Env, plan: &Plan, run: &mut Run<'_>, file_id: Uuid, parts: &[FilePart], room: &Room) {
    run.describing.spawn(
        Describe {
            db: env.db.clone(),
            bus: env.bus.clone(),
            provider: plan.agent.provider.clone(),
            user_id: plan.user_id,
            chat_id: plan.chat_id,
            key: plan.key.clone(),
            file_id,
            parts: parts.to_vec(),
            room: room.clone(),
        }
        .run(),
    );
}

async fn drive(
    env: &Env,
    plan: &Plan,
    reply: &mut Reply,
    watch: Watch,
    describing: &mut JoinSet<()>,
) -> Result<End, Stop> {
    let Watch { mut notes, mut revocations, mut shutdown } = watch;
    // The session may have been revoked since the send was authorized.
    if revoked(env, plan).await {
        return Ok(End::Failed(TurnErrorCode::Interrupted));
    }
    let mut interrupted = plan.agent.interrupted.clone();
    let deadline = tokio::time::sleep(env.limit);
    tokio::pin!(deadline);
    let mut run = Run {
        request: plan.request.clone(),
        round: Round::default(),
        calls: 0,
        denied: Vec::new(),
        history: 0,
        opened: HashSet::new(),
        file_bytes: 0,
        images: 0,
        rooms: Vec::new(),
        describing,
        gap: false,
        started: tokio::time::Instant::now(),
    };
    if give_files(env, plan, &mut run).await.is_err() {
        return Ok(End::Failed(TurnErrorCode::FilesBusy));
    }
    let mut phase = connect(plan.agent.provider.clone(), run.request.clone());
    let mut tick = tokio::time::interval(RENEW);
    tick.tick().await;
    let mut renewed = tokio::time::Instant::now();
    loop {
        tokio::select! {
            progress = progress(&mut phase) => match progress {
                Progress::Connected(Ok(stream)) => phase = Phase::Streaming(stream),
                Progress::Connected(Err(e)) => return Ok(End::Failed(failure(&e))),
                Progress::Event(Some(Ok(Event::Text(mut text)))) => {
                    run.round.text.push_str(&text);
                    if std::mem::take(&mut run.gap) {
                        text.insert_str(0, "\n\n");
                    }
                    if reply.text.len() + text.len() > TEXT_MAX {
                        return Ok(End::Failed(TurnErrorCode::TooLong));
                    }
                    reply.text.push_str(&text);
                    reply.seq += 1;
                    let delta =
                        MessageDelta { chat_id: plan.chat_id, message_id: plan.reply_id, seq: reply.seq, text: Secret(text) };
                    env.bus.publish(Note::event(Target::User(plan.user_id), &delta)).await;
                }
                Progress::Event(Some(Ok(Event::ToolCall(call)))) => run.round.calls.push(call),
                Progress::Event(Some(Ok(Event::Done(_)))) => {
                    if run.round.calls.is_empty() {
                        return Ok(End::Complete);
                    }
                    run.round.queue = run.round.calls.iter().cloned().collect();
                    phase = Phase::Idle;
                    if let Err(stop) = advance(env, plan, reply, &mut run, &mut phase).await {
                        return halt(stop);
                    }
                }
                Progress::Event(Some(Err(e))) => return Ok(End::Failed(failure(&e))),
                Progress::Event(None) => return Ok(End::Failed(TurnErrorCode::ProviderInvalid)),
                Progress::Expired => if let Err(stop) = expired(env, plan, reply, &mut run, &mut phase).await {
                    return halt(stop);
                },
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
                if (reply.seq != reply.stored || reply.dirty)
                    && let Err(Stop::Gone) = snapshot(env, plan, reply).await
                {
                    return Err(Stop::Gone);
                }
            }
            note = notes.recv() => match note {
                Ok(Note::Answer(answer))
                    if matches!(&phase, Phase::Waiting(w) if w.request_id == answer.request_id) =>
                {
                    if let Err(stop) = resolve(env, plan, reply, &mut run, &mut phase, answer, false).await {
                        return halt(stop);
                    }
                }
                // An answer may have been among the lost notes: look it up soon.
                note @ (Ok(Note::Reset) | Err(broadcast::error::RecvError::Lagged(_))) => {
                    if let Phase::Waiting(waiting) = &mut phase {
                        waiting.lost = true;
                        waiting.until = tokio::time::Instant::now() + LOST_WAIT;
                    }
                    if let Some(end) = ends(note, plan) {
                        return Ok(end);
                    }
                }
                note => if let Some(end) = ends(note, plan) {
                    return Ok(end);
                },
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
    let mut content =
        MessageContent { text: reply.text.clone(), doc: None, tools: reply.tools.clone(), files: Vec::new() };
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
    reply.dirty = false;
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
    use chat_protocol::{
        chat::{ContextMessage, Role, TurnContext},
        redact::Secret,
    };

    use super::{FORMAT, first_of, request, without_title};

    #[test]
    fn a_turn_tells_the_model_the_format_then_the_summary() {
        let bare = request(TurnContext::default(), Secret("Hi".into()), None, 0, false);
        assert!(bare.system.as_deref().is_some_and(|s| s.starts_with(FORMAT) && s.ends_with(super::tools::GUIDE)));
        assert_eq!(bare.tools.len(), 3);
        let context = TurnContext { summary: Some(Secret("Ann likes tea.".into())), messages: Vec::new() };
        let system = request(context, Secret("Hi".into()), None, 0, false).system.unwrap_or_default();
        assert!(system.starts_with(FORMAT) && system.ends_with("so far:\n\nAnn likes tea."));
    }

    #[test]
    fn history_is_offered_only_before_the_context() {
        let message = |id| ContextMessage { id, role: Role::User, text: Secret("x".into()), files: Vec::new() };
        let context = TurnContext { summary: None, messages: vec![message(40), message(41)] };
        assert_eq!(first_of(&context, 43), 40);
        assert_eq!(first_of(&TurnContext::default(), 43), 42);
        assert_eq!(first_of(&TurnContext { summary: None, messages: vec![message(0)] }, 3), 0);
        let read = request(context, Secret("Hi".into()), None, 40, false);
        assert!(read.system.as_deref().is_some_and(|s| s.contains("start at message 40")));
        assert!(read.tools.iter().any(|t| t.name == super::tools::READ_HISTORY));
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
