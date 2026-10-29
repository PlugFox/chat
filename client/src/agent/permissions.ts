/**
 * Permission requests of the agent's tools (docs/protocol.md, "Permissions
 * and the access log"; D-099): the auth session's waiting requests, each
 * shown from this client's own data and answered once. Approving a register
 * read decrypts those days here and sends them as the tool result. A request
 * for a register this client does not know is refused without asking.
 * Framework-free so it can be tested without a DOM.
 */

import type { Metric, PermissionRequest, RegisterInfo } from "../protocol/generated/protocol";
import type { OpenedEntry, Request } from "../registers/registers";
import { TransportError } from "../transport/socket";

/** Matches the server's `RESULT_MAX`. */
export const RESULT_MAX = 64 * 1024;
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

/** What answering needs of the registers (`Registers`, loaded). */
export interface RegisterSource {
  metric(key: string): Metric | undefined;
  register(key: string): RegisterInfo | undefined;
  read(metric: string, from?: number, to?: number): Promise<{ entries: OpenedEntry[]; more: boolean }>;
}

export interface PermissionDeps {
  request: Request;
  /** Opens a request's `audit.reason` record. */
  openReason(requestId: string, record: Uint8Array): Promise<string>;
  /** The registers, their catalog loaded. */
  registers(): Promise<RegisterSource>;
}

export interface Asked {
  request: PermissionRequest;
  /** The model's reason; `null` when its record does not open. */
  reason: string | null;
}

/** The answer did not reach the server; the request still waits. */
export class AnswerFailed extends Error {}

export class Permissions {
  private readonly asked = new Map<string, Asked>();
  /** Requests that ended, so a late copy of one is not shown again. */
  private readonly ended = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: PermissionDeps) {}

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
    const { requests } = await this.deps.request("permission.pending", {}, { retry: "resend" });
    await Promise.all(requests.map((r) => this.receive(r)));
  }

  /** `permission.request`. */
  async receive(request: PermissionRequest): Promise<void> {
    const id = request.request_id;
    if (this.asked.has(id) || this.ended.has(id)) return;
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

  /** `permission.resolved`: answered here or in another tab, timed out or cancelled. */
  resolved(requestId: string): void {
    this.ended.add(requestId);
    if (this.asked.delete(requestId)) this.changed();
  }

  async approve(requestId: string): Promise<void> {
    const asked = this.asked.get(requestId);
    if (!asked) return;
    const grant = asked.request.grant;
    let result: string | undefined;
    if (grant.tool === "read_register") {
      const registers = await this.deps.registers();
      const metric = registers.metric(grant.metric);
      if (!metric) return this.answer(requestId, "refuse");
      const span = daySpan(grant.from, grant.to);
      result = registerResult(metric, await registers.read(grant.metric, span.from, span.to), grant.from, grant.to);
    }
    return this.answer(requestId, "approve", result);
  }

  deny(requestId: string): Promise<void> {
    return this.answer(requestId, "deny");
  }

  private async answer(requestId: string, decision: "approve" | "deny" | "refuse", result?: string): Promise<void> {
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
