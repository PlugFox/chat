/**
 * Permission requests of the agent's tools (docs/protocol.md, "Permissions
 * and the access log"; D-099): the auth session's waiting requests, each
 * shown from this client's own data and answered once. Approving a register
 * read decrypts those days here and sends them as the tool result. A request
 * for a register this client does not know is refused without asking, and a
 * history read is answered without asking (D-100). An entry the agent proposes
 * is shown as opened here and written here on approval (D-106).
 * Framework-free so it can be tested without a DOM.
 */

import type { Decision, Metric, PermissionRequest, RegisterInfo } from "../protocol/generated/protocol";
import { checkValue, deviceOffset } from "../registers/catalog";
import { COMMENT_MAX, type EntryValue } from "../registers/records";
import type { OpenedEntry, Request } from "../registers/registers";
import { TransportError } from "../transport/socket";

/** Matches the server's `RESULT_MAX`. */
export const RESULT_MAX = 64 * 1024;
/** Match the server's `HISTORY_COUNT` and `HISTORY_TURN_MAX` (D-100). */
const HISTORY_COUNT = 50;
const HISTORY_TURN_MAX = 128 * 1024;
/** File keys a turn gets at most: as many as its tool calls (`CALLS_MAX` on the server). */
export const FILES_PER_TURN = 8;
/** How long a history request waits for the answer naming its turn. */
const TURN_WAIT_MS = 5000;
/** A UTC offset reaches 14 hours either way. */
const MARGIN = 14 * 3600;
const utf8 = new TextEncoder();

/** The widest UTC range in seconds (`to` excluded) that holds entries of these local days. */
export function daySpan(from?: string, to?: string): { from?: number; to?: number } {
  const start = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
  const span: { from?: number; to?: number } = {};
  if (from) span.from = start(from) - MARGIN;
  if (to) span.to = start(to) + 86_400 + MARGIN;
  return span;
}

/** An entry's time where it was recorded, with that offset: `2026-03-01T12:00:00+01:00`. */
export function localTime(occurredAt: number, tz: number): string {
  const wall = new Date((occurredAt + tz * 60) * 1000).toISOString().slice(0, 19);
  const sign = tz < 0 ? "-" : "+";
  const minutes = Math.abs(tz);
  const offset = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `${wall}${sign}${offset}`;
}

function dayOfEntry(occurredAt: number, tz: number): string {
  return new Date((occurredAt + tz * 60) * 1000).toISOString().slice(0, 10);
}

/**
 * The result of an approved `read_register`: the entries of those days by
 * their own offsets, newest first, the oldest left out (and `truncated`)
 * past what a result holds. Entries that do not open are left out.
 */
export function registerResult(
  metric: Metric,
  read: { entries: OpenedEntry[]; more: boolean },
  from?: string,
  to?: string,
): string {
  const items: Record<string, unknown>[] = [];
  for (const { info, value } of read.entries) {
    if (value.kind !== "value") continue;
    const day = dayOfEntry(info.occurred_at, value.tz);
    if ((from && day < from) || (to && day > to)) continue;
    const item: Record<string, unknown> = { at: localTime(info.occurred_at, value.tz), value: value.value };
    if (value.comment !== "") item["comment"] = value.comment;
    items.push(item);
  }
  const head = { metric: metric.key, unit: metric.unit, aggregate: metric.aggregate };
  let truncated = read.more;
  // Room for the brackets, commas and the flag; each entry counted once.
  let room = RESULT_MAX - utf8.encode(JSON.stringify({ ...head, entries: [], truncated: true })).length;
  let kept = 0;
  for (const item of items) {
    const size = utf8.encode(JSON.stringify(item)).length + 1;
    if (size > room) {
      truncated = true;
      break;
    }
    room -= size;
    kept += 1;
  }
  const entries = items.slice(0, kept);
  return JSON.stringify(truncated ? { ...head, entries, truncated } : { ...head, entries });
}

/** An entry the agent proposes: what an `add_measurement` request's sealed record holds. */
export interface Proposal {
  reason: string;
  value: number;
  /** `YYYY-MM-DD`; absent means today. */
  day?: string;
  comment: string;
}

/** The record's text as a proposal, or `null`: such a request is never shown (docs/crypto.md, "Record contents"). */
export function readProposal(text: string): Proposal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { reason = "", value, day, comment = "" } = raw as Record<string, unknown>;
  if (typeof reason !== "string" || typeof comment !== "string") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (day !== undefined && (typeof day !== "string" || !isDay(day))) return null;
  return { reason, value, comment, ...(day === undefined ? {} : { day }) };
}

function isDay(day: string): boolean {
  // Before 1900 no entry can be stored (docs/protocol.md, "Registers").
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < "1900-01-01") return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === day;
}

/** Today on this device. */
function today(now: Date): string {
  return dayOfEntry(Math.floor(now.getTime() / 1000), deviceOffset(now));
}

/**
 * When a proposed entry happens: now for today, noon of an earlier day on this
 * device; `null` for a day still to come.
 */
export function proposedMoment(day: string | undefined, now: Date): { occurredAt: number; tz: number } | null {
  const current = today(now);
  if (day === undefined || day === current) {
    return { occurredAt: Math.floor(now.getTime() / 1000), tz: deviceOffset(now) };
  }
  if (day > current) return null;
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const noon = new Date(year, month - 1, date, 12);
  return { occurredAt: Math.floor(noon.getTime() / 1000), tz: deviceOffset(noon) };
}

/** The result of an approved `add_measurement`: the day, not the device's clock and offset (D-041). */
export function addedResult(metric: Metric, value: number, day: string): string {
  return JSON.stringify({ recorded: true, metric: metric.key, unit: metric.unit, value, day });
}

/** What a `web_fetch` request's sealed record holds. */
export interface WebRequest {
  reason: string;
  url: string;
  host: string;
}

function sealedJson(text: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The record as a web request, or `null`: only `https://`, its host read here, not told. */
export function readWebRequest(text: string): WebRequest | null {
  const raw = sealedJson(text);
  if (!raw || typeof raw["url"] !== "string") return null;
  try {
    const url = new URL(raw["url"]);
    if (url.protocol !== "https:") return null;
    return { reason: typeof raw["reason"] === "string" ? raw["reason"] : "", url: raw["url"], host: url.hostname };
  } catch {
    return null;
  }
}

/** The record of a `get_weather` request: the place the session's IP points to, or `null`. */
export function readWeatherRequest(text: string): { reason: string; city: string; country: string } | null {
  const raw = sealedJson(text);
  if (!raw || typeof raw["city"] !== "string" || raw["city"] === "") return null;
  return {
    reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
    city: raw["city"],
    country: typeof raw["country"] === "string" ? raw["country"] : "",
  };
}

/** What a `run_code` request's sealed record holds. */
export interface CodeRequest {
  reason: string;
  code: string;
  files: string[];
  registers: string[];
}

export function readCodeRequest(text: string): CodeRequest | null {
  const raw = sealedJson(text);
  if (!raw || typeof raw["code"] !== "string") return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
    code: raw["code"],
    files: list(raw["files"]),
    registers: list(raw["registers"]),
  };
}

/** An approved entry that could not be saved, for trying again. */
export interface Unstored {
  metric: string;
  occurredAt: number;
  value: EntryValue;
  entryId: string;
}

/** What answering needs of the registers (`Registers`, loaded). */
export interface RegisterSource {
  metric(key: string): Metric | undefined;
  register(key: string): RegisterInfo | undefined;
  read(metric: string, from?: number, to?: number): Promise<{ entries: OpenedEntry[]; more: boolean }>;
  create(metric: string, occurredAt: number, value: EntryValue, entryId: string): Promise<OpenedEntry>;
}

export interface PermissionDeps {
  request: Request;
  /** Opens a request's `audit.reason` record. */
  openReason(requestId: string, record: Uint8Array): Promise<string>;
  /** The registers, their catalog loaded. */
  registers(): Promise<RegisterSource>;
  /** A `read_history` result (`readHistory`); `null` when the chat does not open here. */
  history(chatId: string, before: number, count: number): Promise<string | null>;
  /** The chat of a turn this tab started (`OwnTurns.chatOf`). */
  turnChat(turnId: string, ms: number): Promise<string | undefined>;
  /** A file's content key in base64url, if the file is of that chat and opens here (D-101). */
  fileKey(chatId: string, fileId: string): Promise<string | null>;
  /**
   * The answer of a `run_code` (D-115), `registers` being what this tab already
   * got approved in the turn; `null` when an input is not this chat's to give.
   */
  runCode(chatId: string, code: CodeRequest, registers: Record<string, unknown>): Promise<string | null>;
}

export interface Asked {
  request: PermissionRequest;
  /** The model's reason; `null` when its record does not open. */
  reason: string | null;
  /** What an `add_measurement` proposes, and how many entries its day already has. */
  proposal?: { value: number; day: string; comment: string; sameDay: number };
  /** The address a `web_fetch` would read. */
  web?: { url: string; host: string };
  /** The place a `get_weather` would use. */
  place?: { city: string; country: string };
}

/** The answer did not reach the server; the request still waits. */
export class AnswerFailed extends Error {}

export class Permissions {
  private readonly asked = new Map<string, Asked>();
  /** Requests that ended, so a late copy of one is not shown again. */
  private readonly ended = new Set<string>();
  /** History reads being answered, so the event and `permission.pending` answer once. */
  private readonly answering = new Set<string>();
  /** History bytes sent per turn: a server that asks for more is refused. */
  private readonly historySent = new Map<string, number>();
  /** File keys given per turn, against the turn's tool calls. */
  private readonly filesSent = new Map<string, number>();
  /**
   * What the user approved per turn, by metric: `run_code` may use it, as the
   * model was already given it. Nothing else opens a register without a dialog.
   */
  private readonly approved = new Map<string, Record<string, unknown>>();
  /**
   * The answers of each turn, one after another: a limit read before an
   * await and written after it would let parallel requests all pass it.
   */
  private readonly turnQueue = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  /** Entries whose approval was sent at least once, in case its answer was lost. */
  private readonly tried = new Set<string>();
  private failedEntry: Unstored | null = null;

  constructor(
    private readonly deps: PermissionDeps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Waiting requests, oldest first. */
  get list(): Asked[] {
    return [...this.asked.values()].sort((a, b) => (a.request.request_id < b.request.request_id ? -1 : 1));
  }

  /** The auth session's waiting requests (every connect: a reload asks again). */
  async load(): Promise<void> {
    const before = [...this.asked.keys()];
    const { requests } = await this.deps.request("permission.pending", {}, { retry: "resend" });
    // `permission.resolved` is not replayed: what was shown and is not waiting any more ended while away.
    const waiting = new Set(requests.map((r) => r.request_id));
    for (const id of before) if (!waiting.has(id)) this.resolved(id);
    await Promise.all(requests.map((r) => this.receive(r)));
  }

  /** `permission.request`. */
  async receive(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (this.asked.has(id) || this.ended.has(id)) return;
    if (request.grant.tool === "read_history") return this.history(request);
    if (request.grant.tool === "read_file") return this.file(request);
    if (request.grant.tool === "add_measurement") return this.proposed(request);
    if (request.grant.tool === "run_code") return this.code(request);
    if (request.grant.tool === "web_fetch") return this.web(request);
    if (request.grant.tool === "get_weather") return this.weather(request);
    if (request.grant.tool === "read_register") {
      const grant = request.grant;
      const registers = await this.deps.registers();
      const known = registers.metric(grant.metric) && registers.register(grant.metric)?.scope_id === grant.scope_id;
      if (!known) {
        await this.answer(id, "refuse").catch(() => undefined);
        return;
      }
    }
    let reason: string | null;
    try {
      reason = await this.deps.openReason(id, request.reason);
    } catch {
      reason = null;
    }
    if (this.ended.has(id)) return;
    this.asked.set(id, { request, reason });
    this.changed();
  }

  /** Shows a site the agent asks to read, or refuses a record that names none. */
  private async web(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    let web: WebRequest | null;
    try {
      web = readWebRequest(await this.deps.openReason(id, request.reason));
    } catch {
      web = null;
    }
    if (!web) {
      await this.answer(id, "refuse").catch(() => undefined);
      return;
    }
    if (this.ended.has(id)) return;
    this.asked.set(id, { request, reason: web.reason, web: { url: web.url, host: web.host } });
    this.changed();
  }

  /** Shows the place found by IP, or refuses a record that names none. */
  private async weather(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    let read: ReturnType<typeof readWeatherRequest>;
    try {
      read = readWeatherRequest(await this.deps.openReason(id, request.reason));
    } catch {
      read = null;
    }
    if (!read) {
      await this.answer(id, "refuse").catch(() => undefined);
      return;
    }
    if (this.ended.has(id)) return;
    this.asked.set(id, { request, reason: read.reason, place: { city: read.city, country: read.country } });
    this.changed();
  }

  /** Runs code for a turn this tab started, bound as history is; no one is asked. */
  private code(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (this.answering.has(id)) return Promise.resolve();
    this.answering.add(id);
    return this.serial(request.turn_id, () => this.answerCode(request));
  }

  private async answerCode(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    try {
      const chatId = await this.deps.turnChat(request.turn_id, TURN_WAIT_MS);
      if (chatId !== request.chat_id) return;
      let result: string | null = null;
      try {
        const code = readCodeRequest(await this.deps.openReason(id, request.reason));
        if (code) result = await this.deps.runCode(chatId, code, this.approved.get(request.turn_id) ?? {});
      } catch {
        result = null;
      }
      if (result === null) await this.answer(id, "refuse").catch(() => undefined);
      else await this.answer(id, "answer", result).catch(() => undefined);
    } finally {
      this.answering.delete(id);
    }
  }

  /** Shows a proposed entry, or refuses one this client would not store. */
  private async proposed(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (request.grant.tool !== "add_measurement" || this.answering.has(id)) return;
    this.answering.add(id);
    try {
      const refuse = () => this.answer(id, "refuse").catch(() => undefined);
      let proposal: Proposal | null;
      try {
        proposal = readProposal(await this.deps.openReason(id, request.reason));
      } catch {
        proposal = null;
      }
      const registers = await this.deps.registers();
      const metric = registers.metric(request.grant.metric);
      const moment = proposal && proposedMoment(proposal.day, this.now());
      if (
        !proposal ||
        !metric ||
        !moment ||
        checkValue(metric, proposal.value) !== null ||
        utf8.encode(proposal.comment).length > COMMENT_MAX
      ) {
        await refuse();
        return;
      }
      const day = dayOfEntry(moment.occurredAt, moment.tz);
      let sameDay = 0;
      if (registers.register(metric.key)) {
        const span = daySpan(day, day);
        try {
          const { entries } = await registers.read(metric.key, span.from, span.to);
          sameDay = entries.filter(
            (e) => e.value.kind === "value" && dayOfEntry(e.info.occurred_at, e.value.tz) === day,
          ).length;
        } catch {
          // Only a hint: the request is shown without it.
        }
      }
      if (this.ended.has(id)) return;
      this.asked.set(id, {
        request,
        reason: proposal.reason,
        proposal: { value: proposal.value, day, comment: proposal.comment, sameDay },
      });
      this.changed();
    } finally {
      this.answering.delete(id);
    }
  }

  /**
   * The server takes the approval first, so a request that ended (denied in
   * another tab, expired while this one slept) writes nothing. The entry's id
   * is the request's, so a second save stores nothing new.
   */
  private async approveAdd(asked: Asked): Promise<void> {
    const { request, proposal } = asked;
    const id = request.request_id;
    if (request.grant.tool !== "add_measurement" || !proposal) return;
    const registers = await this.deps.registers();
    const metric = registers.metric(request.grant.metric);
    const moment = proposedMoment(proposal.day === today(this.now()) ? undefined : proposal.day, this.now());
    if (!metric || !moment) return this.answer(id, "refuse");
    const again = this.tried.has(id);
    this.tried.add(id);
    let approved = true;
    try {
      await this.deps.request("permission.respond", {
        request_id: id,
        decision: "approve",
        result: addedResult(metric, proposal.value, proposal.day),
      });
    } catch (e) {
      if (!(e instanceof TransportError && e.code === "permission.not_found")) throw new AnswerFailed("not sent");
      // Answered before: the try whose answer never came may be what approved it.
      approved = again && (await this.wasApproved(id));
    }
    this.resolved(id);
    if (!approved) return;
    await this.store({
      metric: metric.key,
      occurredAt: moment.occurredAt,
      value: { value: proposal.value, tz: moment.tz, comment: proposal.comment },
      entryId: id,
    });
  }

  private async wasApproved(id: string): Promise<boolean> {
    try {
      const { entries } = await this.deps.request("access_log.list", {}, { retry: "resend" });
      return entries.some((e) => e.id === id && e.outcome === "approved");
    } catch {
      throw new AnswerFailed("not known");
    }
  }

  private async store(entry: Unstored): Promise<void> {
    const registers = await this.deps.registers();
    try {
      await registers.create(entry.metric, entry.occurredAt, entry.value, entry.entryId);
      if (this.failedEntry?.entryId === entry.entryId) this.failedEntry = null;
    } catch (e) {
      if (e instanceof TransportError && e.code === "register.exists") {
        if (this.failedEntry?.entryId === entry.entryId) this.failedEntry = null;
      } else {
        this.failedEntry = entry;
      }
    }
    this.changed();
  }

  /** An approved entry that was not saved: the model was told it was. */
  get unstored(): Unstored | null {
    return this.failedEntry;
  }

  retryStore(): Promise<void> {
    return this.failedEntry ? this.store(this.failedEntry) : Promise.resolve();
  }

  dismissUnstored(): void {
    this.failedEntry = null;
    this.changed();
  }

  /** `permission.resolved`: answered here or in another tab, timed out or cancelled. */
  resolved(requestId: string): void {
    this.ended.add(requestId);
    if (this.asked.delete(requestId)) this.changed();
  }

  async approve(requestId: string): Promise<void> {
    const asked = this.asked.get(requestId);
    if (!asked) return;
    const grant = asked.request.grant;
    if (grant.tool === "add_measurement") return this.approveAdd(asked);
    let result: string | undefined;
    if (grant.tool === "read_register") {
      const registers = await this.deps.registers();
      const metric = registers.metric(grant.metric);
      if (!metric) return this.answer(requestId, "refuse");
      const span = daySpan(grant.from, grant.to);
      result = registerResult(metric, await registers.read(grant.metric, span.from, span.to), grant.from, grant.to);
      const turn = asked.request.turn_id;
      // Opened data stays no longer than its turn is the latest.
      if (!this.approved.has(turn)) this.approved.clear();
      this.approved.set(turn, { ...this.approved.get(turn), [grant.metric]: JSON.parse(result) });
    }
    return this.answer(requestId, "approve", result);
  }

  /** Runs a turn's answer after the ones before it. */
  private serial(turnId: string, task: () => Promise<void>): Promise<void> {
    const before = this.turnQueue.get(turnId) ?? Promise.resolve();
    const done = before.then(task, task);
    const settled = done.catch(() => undefined);
    this.turnQueue.set(turnId, settled);
    void settled.then(() => {
      if (this.turnQueue.get(turnId) === settled) this.turnQueue.delete(turnId);
    });
    return done;
  }

  private history(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (request.grant.tool !== "read_history" || this.answering.has(id)) return Promise.resolve();
    this.answering.add(id);
    return this.serial(request.turn_id, () => this.answerHistory(request));
  }

  private async answerHistory(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (request.grant.tool !== "read_history") return;
    try {
      // Only a turn this tab started, in its own chat: the server cannot make
      // this tab read a chat it is not talking in. Another tab is the sender.
      const chatId = await this.deps.turnChat(request.turn_id, TURN_WAIT_MS);
      if (chatId !== request.chat_id) return;
      const { before, count } = request.grant;
      const sent = this.historySent.get(request.turn_id) ?? 0;
      let result: string | null = null;
      if (count >= 1 && count <= HISTORY_COUNT && before >= 1 && sent < HISTORY_TURN_MAX) {
        try {
          result = await this.deps.history(chatId, before, count);
        } catch (e) {
          // A dropped connection leaves the request to time out; a chat gone is refused.
          const dropped = ["disconnected", "closed", "timeout"];
          if (!(e instanceof TransportError) || e.retry || dropped.includes(e.code)) return;
        }
      }
      if (result !== null && sent + utf8.encode(result).length > HISTORY_TURN_MAX) result = null;
      if (result === null) {
        await this.answer(id, "refuse").catch(() => undefined);
        return;
      }
      this.historySent.set(request.turn_id, sent + utf8.encode(result).length);
      await this.answer(id, "answer", result).catch(() => undefined);
    } finally {
      this.answering.delete(id);
    }
  }

  /**
   * Answers `read_file` with the file's key, bound as history is: only for a
   * turn this tab started, and only with a key that opens under its chat.
   */
  private file(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (request.grant.tool !== "read_file" || this.answering.has(id)) return Promise.resolve();
    this.answering.add(id);
    return this.serial(request.turn_id, () => this.answerFile(request));
  }

  private async answerFile(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (request.grant.tool !== "read_file") return;
    try {
      const chatId = await this.deps.turnChat(request.turn_id, TURN_WAIT_MS);
      if (chatId !== request.chat_id) return;
      const sent = this.filesSent.get(request.turn_id) ?? 0;
      let key: string | null = null;
      if (sent < FILES_PER_TURN) {
        try {
          key = await this.deps.fileKey(chatId, request.grant.file_id);
        } catch (e) {
          const dropped = ["disconnected", "closed", "timeout"];
          if (!(e instanceof TransportError) || e.retry || dropped.includes(e.code)) return;
        }
      }
      if (key === null) {
        await this.answer(id, "refuse").catch(() => undefined);
        return;
      }
      this.filesSent.set(request.turn_id, sent + 1);
      await this.answer(id, "answer", key).catch(() => undefined);
    } finally {
      this.answering.delete(id);
    }
  }

  deny(requestId: string): Promise<void> {
    return this.answer(requestId, "deny");
  }

  private async answer(requestId: string, decision: Decision, result?: string): Promise<void> {
    try {
      await this.deps.request("permission.respond", {
        request_id: requestId,
        decision,
        ...(result !== undefined ? { result } : {}),
      });
    } catch (e) {
      // Answered elsewhere, expired or ended: nothing waits any more.
      if (!(e instanceof TransportError && e.code === "permission.not_found")) throw new AnswerFailed("not sent");
    }
    this.resolved(requestId);
  }
}
