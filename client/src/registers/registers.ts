/**
 * Registers (docs/protocol.md, "Registers"; D-097): the metric catalog, the
 * account's registers, each metric's entries paged newest first with their
 * values opened in the worker, and the latest day of each metric for the
 * overview. Kept current by `register.updated` and `register.deleted`;
 * saving creates the metric's scope first when the account has none.
 * Framework-free so it can be tested without a DOM.
 */

import type { Unreadable } from "../chats/records";
import { precheck } from "../notes/records";
import type {
  Metric,
  MetricCategory,
  RegisterCursor,
  RegisterEntry,
  RegisterInfo,
  Requests,
} from "../protocol/generated/protocol";
import { type RequestOptions, type RequestType, TransportError } from "../transport/socket";
import { uuidBytes } from "../vault/bytes";
import type { RegisterKind } from "../vault/keys";
import { byDay, type Day, KNOWN_REGISTERS } from "./catalog";
import { decodeValue, type EntryValue, encodeValue, VALUE_RECORD_MAX } from "./records";

export type Request = <T extends RequestType>(
  type: T,
  payload: Requests[T]["request"],
  options?: RequestOptions<T>,
) => Promise<Requests[T]["response"]>;

/** What registers need of the keys (`KeyVault`). */
export interface RegisterKeys {
  createRegister(scopeId: string): Promise<{ publicKey: Uint8Array; wrappedPrivateKey: Uint8Array }>;
  sealRegister(scopeId: string, kind: RegisterKind, plaintext: Uint8Array): Promise<Uint8Array>;
  openRegister(scopeId: string, kind: RegisterKind, record: Uint8Array): Promise<Uint8Array>;
}

export type Value =
  | ({ kind: "value"; raw: Record<string, unknown> } & EntryValue)
  | { kind: "unreadable"; reason: Unreadable };

export interface OpenedEntry {
  info: RegisterEntry;
  value: Value;
}

export type LoadState = { kind: "loading" } | { kind: "failed" } | { kind: "ready" };

/** The latest day of a metric, for the overview; `null` without entries. */
export type Latest = { kind: "loading" } | { kind: "ready"; day: Day | null };

/** `register.conflict`: another device changed the entry first, and its version stays. */
export class Conflict extends Error {}

const resend = { retry: "resend" } as const;
/** A day is at most 50 hours of UTC wide, offsets included. */
const DAY_SPAN = 50 * 3600;

function kind(info: { entry_id: string; occurred_at: number }): RegisterKind {
  return {
    kind: "register.value",
    entryId: uuidBytes(info.entry_id),
    periodStart: info.occurred_at,
    granularity: "instant",
  };
}

function newestFirst(a: OpenedEntry, b: OpenedEntry): number {
  return b.info.occurred_at - a.info.occurred_at || (b.info.entry_id < a.info.entry_id ? -1 : 1);
}

/** One metric's entries, newest first, loaded a page at a time. */
export class History {
  private readonly entries = new Map<string, OpenedEntry>();
  private next: RegisterCursor | null = null;
  private status: LoadState = { kind: "loading" };
  private generation = 0;

  constructor(
    readonly metric: string,
    private readonly owner: Registers,
  ) {}

  get state(): LoadState {
    return this.status;
  }

  get list(): OpenedEntry[] {
    return [...this.entries.values()].sort(newestFirst);
  }

  get hasMore(): boolean {
    return this.next !== null;
  }

  /** The newest page, starting over. */
  async load(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.status = { kind: "loading" };
    this.owner.changed();
    try {
      const page = await this.owner.page(this.metric, undefined);
      if (generation !== this.generation) return;
      this.entries.clear();
      for (const e of page.entries) this.entries.set(e.info.entry_id, e);
      this.next = page.next;
      this.status = { kind: "ready" };
    } catch (e) {
      if (generation !== this.generation) return;
      this.status = { kind: "failed" };
      throw e;
    } finally {
      this.owner.changed();
    }
  }

  async more(): Promise<void> {
    if (this.next === null) return;
    const generation = this.generation;
    const page = await this.owner.page(this.metric, this.next);
    if (generation !== this.generation) return;
    for (const e of page.entries) if (!this.entries.has(e.info.entry_id)) this.entries.set(e.info.entry_id, e);
    this.next = page.next;
    this.owner.changed();
  }

  /** A stored or changed entry: a newer revision replaces the one shown. */
  put(entry: OpenedEntry): void {
    const known = this.entries.get(entry.info.entry_id);
    if (known && known.info.rev >= entry.info.rev) return;
    // Past the loaded pages it would fill a gap wrongly; a later page brings it.
    const oldest = this.next;
    if (!known && oldest && entry.info.occurred_at < oldest.occurred_at) return;
    this.entries.set(entry.info.entry_id, entry);
    this.owner.changed();
  }

  remove(entryId: string): void {
    if (this.entries.delete(entryId)) this.owner.changed();
  }
}

export class Registers {
  private readonly listeners = new Set<() => void>();
  private status: LoadState = { kind: "loading" };
  private catalog: { categories: MetricCategory[]; metrics: Metric[] } = { categories: [], metrics: [] };
  private readonly mine = new Map<string, RegisterInfo>();
  private readonly histories = new Map<string, History>();
  private readonly latestDays = new Map<string, Latest>();
  private readonly settingUp = new Map<string, Promise<string>>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly request: Request,
    private readonly keys: RegisterKeys,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  get state(): LoadState {
    return this.status;
  }

  get categories(): MetricCategory[] {
    return this.catalog.categories;
  }

  /** The metrics this client can show, in the catalog's order. */
  get metrics(): Metric[] {
    return this.catalog.metrics.filter((m) => KNOWN_REGISTERS.has(m.register));
  }

  metric(key: string): Metric | undefined {
    return this.metrics.find((m) => m.key === key);
  }

  register(metric: string): RegisterInfo | undefined {
    return this.mine.get(metric);
  }

  /** The catalog and the account's registers, starting over (a connect, `sync.reset`). */
  load(): Promise<void> {
    const loading = this.loadCatalog();
    this.loading = loading.catch(() => undefined);
    return loading;
  }

  private async loadCatalog(): Promise<void> {
    if (this.status.kind !== "ready") {
      this.status = { kind: "loading" };
      this.changed();
    }
    try {
      const catalog = await this.request("metric.list", {}, resend);
      this.catalog = { categories: catalog.categories, metrics: catalog.metrics };
      const before = new Map(this.mine);
      this.mine.clear();
      for (const r of catalog.registers) this.mine.set(r.metric, r);
      this.status = { kind: "ready" };
      // The latest day of a metric whose newest entry or count moved is stale.
      for (const [metric, latest] of this.latestDays) {
        const was = before.get(metric);
        const now = this.mine.get(metric);
        if (latest.kind === "loading" || was?.latest_at !== now?.latest_at || was?.entries !== now?.entries) {
          this.latestDays.delete(metric);
        }
      }
    } catch (e) {
      if (this.status.kind !== "ready") this.status = { kind: "failed" };
      throw e;
    } finally {
      this.changed();
    }
  }

  /** The metric's entries; loaded on the first call. */
  history(metric: string): History {
    let history = this.histories.get(metric);
    if (!history) {
      history = new History(metric, this);
      this.histories.set(metric, history);
      void history.load().catch(() => undefined);
    }
    return history;
  }

  /** Reloads every history open so far (a reconnect, `sync.reset`). */
  reloadHistories(): void {
    for (const history of this.histories.values()) void history.load().catch(() => undefined);
  }

  /** The latest day of the metric; fetched on the first call after it changed. */
  latest(metric: string): Latest {
    const known = this.latestDays.get(metric);
    if (known) return known;
    const info = this.mine.get(metric);
    const definition = this.metric(metric);
    if (!info?.latest_at || !definition) return { kind: "ready", day: null };
    const loading: Latest = { kind: "loading" };
    this.latestDays.set(metric, loading);
    const from = info.latest_at - DAY_SPAN;
    void this.page(metric, undefined, from).then(
      ({ entries }) => {
        if (this.latestDays.get(metric) !== loading) return;
        const days = byDay(
          entries.flatMap((e) =>
            e.value.kind === "value" ? [{ occurredAt: e.info.occurred_at, tz: e.value.tz, value: e.value.value }] : [],
          ),
          definition.aggregate,
        );
        this.latestDays.set(metric, { kind: "ready", day: days.at(-1) ?? null });
        this.changed();
      },
      () => {
        if (this.latestDays.get(metric) === loading) this.latestDays.delete(metric);
      },
    );
    return loading;
  }

  /** A page of the metric's entries, opened. */
  async page(
    metric: string,
    before: RegisterCursor | undefined,
    from?: number,
  ): Promise<{ entries: OpenedEntry[]; next: RegisterCursor | null }> {
    const parts = new Map<string, RegisterEntry>();
    const done = await this.request(
      "register.entries",
      { metric, ...(before ? { before } : {}), ...(from !== undefined ? { from } : {}) },
      {
        ...resend,
        onPart: (part) => {
          for (const e of part.entries) parts.set(e.entry_id, e);
        },
      },
    );
    for (const e of done.entries) parts.set(e.entry_id, e);
    if (parts.size > 0 && !this.mine.get(metric) && this.loading) await this.loading;
    const entries = await Promise.all([...parts.values()].map((e) => this.open(e)));
    return { entries, next: done.next ?? null };
  }

  /**
   * The metric's newest entries between two moments (seconds, `to` excluded),
   * opened: one page of at most 1000; `more` when older ones are left.
   */
  async read(metric: string, from?: number, to?: number): Promise<{ entries: OpenedEntry[]; more: boolean }> {
    const parts = new Map<string, RegisterEntry>();
    const done = await this.request(
      "register.entries",
      { metric, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) },
      {
        ...resend,
        onPart: (part) => {
          for (const e of part.entries) parts.set(e.entry_id, e);
        },
      },
    );
    for (const e of done.entries) parts.set(e.entry_id, e);
    const entries = await Promise.all([...parts.values()].map((e) => this.open(e)));
    return { entries: entries.sort(newestFirst), more: done.next !== undefined };
  }

  private async open(info: RegisterEntry): Promise<OpenedEntry> {
    const early = precheck(info.value, VALUE_RECORD_MAX);
    if (early) return { info, value: { kind: "unreadable", reason: early } };
    const scopeId = this.mine.get(info.metric)?.scope_id;
    if (!scopeId) return { info, value: { kind: "unreadable", reason: "decrypt" } };
    try {
      const read = decodeValue(await this.keys.openRegister(scopeId, kind(info), info.value));
      return read.ok
        ? { info, value: { kind: "value", value: read.value, tz: read.tz, comment: read.comment, raw: read.raw } }
        : { info, value: { kind: "unreadable", reason: read.reason } };
    } catch {
      return { info, value: { kind: "unreadable", reason: "decrypt" } };
    }
  }

  /** The metric's register scope, created when the account has none. */
  private async scope(metric: string): Promise<string> {
    const known = this.mine.get(metric)?.scope_id;
    if (known) return known;
    let setup = this.settingUp.get(metric);
    if (!setup) {
      setup = (async () => {
        const mine = crypto.randomUUID();
        const keys = await this.keys.createRegister(mine);
        const { scope_id } = await this.request(
          "register.setup",
          { metric, scope_id: mine, public_key: keys.publicKey, wrapped_private_key: keys.wrappedPrivateKey },
          resend,
        );
        // Another device may have been first: its scope is the register.
        if (!this.mine.has(metric)) this.mine.set(metric, { metric, scope_id, entries: 0 });
        return scope_id;
      })().finally(() => this.settingUp.delete(metric));
      this.settingUp.set(metric, setup);
    }
    return setup;
  }

  private async seal(
    metric: string,
    entryId: string,
    occurredAt: number,
    value: EntryValue,
    raw?: Record<string, unknown>,
  ): Promise<Uint8Array> {
    const scopeId = await this.scope(metric);
    return this.keys.sealRegister(
      scopeId,
      kind({ entry_id: entryId, occurred_at: occurredAt }),
      encodeValue(value, raw),
    );
  }

  /** Stores a new entry at `occurredAt` (seconds); `entryId` makes a repeat find the first (`register.exists`). */
  async create(
    metric: string,
    occurredAt: number,
    value: EntryValue,
    entryId: string = crypto.randomUUID(),
  ): Promise<OpenedEntry> {
    const record = await this.seal(metric, entryId, occurredAt, value);
    const { entry } = await this.request(
      "register.create",
      { entry_id: entryId, metric, occurred_at: occurredAt, value: record },
      resend,
    );
    return this.stored(entry);
  }

  /** Replaces an entry's moment and value; another device's change made first stays ([`Conflict`]). */
  async update(entry: OpenedEntry, occurredAt: number, value: EntryValue): Promise<OpenedEntry> {
    const raw = entry.value.kind === "value" ? entry.value.raw : undefined;
    const record = await this.seal(entry.info.metric, entry.info.entry_id, occurredAt, value, raw);
    try {
      const { entry: stored } = await this.request(
        "register.update",
        { entry_id: entry.info.entry_id, rev: entry.info.rev, occurred_at: occurredAt, value: record },
        resend,
      );
      return this.stored(stored);
    } catch (e) {
      if (e instanceof TransportError && e.code === "register.conflict") throw new Conflict("changed elsewhere");
      throw e;
    }
  }

  async delete(entry: OpenedEntry): Promise<void> {
    await this.request("register.delete", { entry_id: entry.info.entry_id }, resend);
    this.histories.get(entry.info.metric)?.remove(entry.info.entry_id);
  }

  private async stored(info: RegisterEntry): Promise<OpenedEntry> {
    const opened = await this.open(info);
    // Counts and the latest day follow the change's event, which reaches this socket too.
    this.histories.get(info.metric)?.put(opened);
    return opened;
  }

  /** `register.updated`. */
  updated(info: RegisterEntry): void {
    const history = this.histories.get(info.metric);
    if (history) void this.open(info).then((opened) => history.put(opened));
    void this.load().catch(() => undefined);
  }

  /** `register.deleted`. */
  deleted(entryId: string, metric: string): void {
    this.histories.get(metric)?.remove(entryId);
    void this.load().catch(() => undefined);
  }
}
