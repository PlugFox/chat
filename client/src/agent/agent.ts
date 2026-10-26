/**
 * The provider settings and the agent session of this tab
 * (docs/protocol.md, "Settings" and "Agent sessions"): the `providers`
 * setting decrypted, changed with a retry on conflict, and the agent session
 * started with its active provider. Framework-free so it can be tested
 * without a DOM.
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import type {
  ProviderKind,
  ProvidersValue,
  Requests,
  SettingsUpdated,
  StoredProvider,
} from "../protocol/generated/protocol";
import { type RequestOptions, type RequestType, type SocketState, TransportError } from "../transport/socket";

export const PROVIDERS_KEY = "providers";

const KINDS: readonly ProviderKind[] = ["openai_compatible", "anthropic"];
/** Attempts of one change when other devices keep changing the setting. */
const ATTEMPTS = 3;

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();

type Request = <T extends RequestType>(
  type: T,
  payload: Requests[T]["request"],
  options?: RequestOptions<T>,
) => Promise<Requests[T]["response"]>;

export interface AgentDeps {
  request: Request;
  /** Seals and opens the `providers` record (`KeyVault.sealSetting` / `openSetting`). */
  seal: (plaintext: Uint8Array) => Promise<Uint8Array>;
  open: (record: Uint8Array) => Promise<Uint8Array>;
}

export type ProvidersState =
  | { kind: "loading" }
  | { kind: "failed" }
  /** `rev` is absent while the setting was never stored. */
  | { kind: "ready"; value: ProvidersValue; rev?: number };

export type AgentState =
  | { kind: "idle" }
  /** No active provider: turns cannot run. */
  | { kind: "none" }
  | { kind: "starting" }
  | { kind: "ready" }
  /** The server refused the active provider (`agent.invalid_provider`). */
  | { kind: "refused" }
  | { kind: "failed" };

function text(v: unknown): v is string {
  return typeof v === "string";
}

/** The setting as it was stored, for writing back what this client cannot read. */
type Raw = Record<string, unknown>;

function rawEntries(raw: Raw): Raw[] {
  return Array.isArray(raw["providers"]) ? (raw["providers"] as Raw[]) : [];
}

/**
 * The provider list from a record's plaintext, and the map it came in. The
 * record is authenticated, but an older or newer client may have written it:
 * unknown fields are ignored, and entries this client cannot use are left
 * out (and kept when writing back, see `encodeProviders`). `active` stays
 * when it names any stored entry, so this client never picks another one in
 * its place.
 */
export function decodeProviders(plaintext: Uint8Array): { value: ProvidersValue; raw: Raw } {
  const decoded: unknown = decoder.decode(plaintext);
  const raw: Raw = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Raw) : {};
  const providers: StoredProvider[] = [];
  for (const entry of rawEntries(raw)) {
    const { id, name, kind, base_url, api_key, model } = entry ?? {};
    if (!(text(id) && text(name) && text(base_url) && text(api_key) && text(model))) continue;
    if (!KINDS.includes(kind as ProviderKind) || providers.some((p) => p.id === id)) continue;
    providers.push({ id, name, kind: kind as ProviderKind, base_url, api_key, model });
  }
  const active = raw["active"];
  const named = text(active) && rawEntries(raw).some((e) => e?.["id"] === active);
  return { value: named ? { providers, active } : { providers }, raw };
}

/**
 * The plaintext of `next`, a change of `base`. What `base` came with and this
 * client does not know survives: unknown fields of the map and of each entry,
 * and entries it could not read.
 */
export function encodeProviders(next: ProvidersValue, base?: { value: ProvidersValue; raw: Raw }): Uint8Array {
  const raw = base?.raw ?? {};
  const readable = new Set(base?.value.providers.map((p) => p.id));
  const providers: unknown[] = [];
  const written = new Set<string>();
  for (const entry of rawEntries(raw)) {
    const id = entry?.["id"];
    const changed = next.providers.find((p) => p.id === id);
    if (changed && !written.has(changed.id)) {
      providers.push({ ...entry, ...changed });
      written.add(changed.id);
    } else if (!(text(id) && readable.has(id))) {
      providers.push(entry);
    }
  }
  for (const p of next.providers) if (!written.has(p.id)) providers.push(p);
  return encoder.encode({ ...raw, providers, active: next.active });
}

export function activeProvider(state: ProvidersState): StoredProvider | undefined {
  if (state.kind !== "ready") return undefined;
  return state.value.providers.find((p) => p.id === state.value.active);
}

function same(a: StoredProvider, b: StoredProvider): boolean {
  return a.kind === b.kind && a.base_url === b.base_url && a.api_key === b.api_key && a.model === b.model;
}

export class Agent {
  private providersState: ProvidersState = { kind: "loading" };
  /** What the value in `providersState` was decoded from. */
  private raw: Raw = {};
  private agentState: AgentState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  /**
   * The agent session this tab holds, the provider it was started with, and
   * the socket opening that holds it (a later one holds it once it resumed).
   */
  private session: { id: string; provider: StoredProvider; connection: SocketState } | null = null;
  /** A sync is running; `again` asks it to run once more when it ends. */
  private syncing = false;
  private again = false;
  private connection: SocketState | null = null;

  constructor(private readonly deps: AgentDeps) {}

  get providers(): ProvidersState {
    return this.providersState;
  }

  get state(): AgentState {
    return this.agentState;
  }

  /** The agent session to resume on reconnect. */
  get sessionId(): string | undefined {
    return this.session?.id;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private setAgent(state: AgentState): void {
    this.agentState = state;
    this.notify();
  }

  /** Takes a value unless a newer revision is already here. */
  private accept(value: ProvidersValue, raw: Raw, rev: number | undefined): void {
    const current = this.providersState;
    if (current.kind === "ready" && current.rev !== undefined && (rev === undefined || rev < current.rev)) return;
    this.raw = raw;
    this.providersState = rev === undefined ? { kind: "ready", value } : { kind: "ready", value, rev };
    this.notify();
    void this.sync();
  }

  /** Reads the setting (after every connect and `sync.reset`). */
  async load(): Promise<void> {
    let state: Requests["settings.get"]["response"];
    try {
      state = await this.deps.request("settings.get", { key: PROVIDERS_KEY }, { retry: "resend" });
    } catch {
      if (this.providersState.kind !== "ready") {
        this.providersState = { kind: "failed" };
        this.notify();
      }
      return;
    }
    if (!state.value) {
      this.accept({ providers: [] }, {}, undefined);
      return;
    }
    await this.receiveRecord(state.value.record, state.value.rev);
  }

  private async receiveRecord(record: Uint8Array, rev: number): Promise<void> {
    let decoded: ReturnType<typeof decodeProviders>;
    try {
      decoded = decodeProviders(await this.deps.open(record));
    } catch {
      // Not written by this account's clients for this key: nothing to use.
      this.providersState = { kind: "failed" };
      this.notify();
      return;
    }
    this.accept(decoded.value, decoded.raw, rev);
  }

  /** The `settings.updated` event. */
  async receive(event: SettingsUpdated): Promise<void> {
    if (event.key !== PROVIDERS_KEY) return;
    const current = this.providersState;
    if (current.kind === "ready" && current.rev !== undefined && event.rev <= current.rev) return;
    await this.receiveRecord(event.record, event.rev);
  }

  /**
   * Applies `change` to the latest value and stores it; when another device
   * stored first, reads its value and applies `change` again.
   */
  async update(change: (value: ProvidersValue) => ProvidersValue): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (this.providersState.kind !== "ready") await this.load();
      const base = this.providersState;
      if (base.kind !== "ready") throw new Error("providers not loaded");
      const next = change(base.value);
      const plaintext = encodeProviders(next, { value: base.value, raw: this.raw });
      const record = await this.deps.seal(plaintext);
      try {
        const stored = await this.deps.request(
          "settings.put",
          base.rev === undefined ? { key: PROVIDERS_KEY, record } : { key: PROVIDERS_KEY, record, rev: base.rev },
          { retry: "resend" },
        );
        const written = decodeProviders(plaintext);
        this.accept(written.value, written.raw, stored.rev);
        return;
      } catch (e) {
        if (!(e instanceof TransportError && e.code === "settings.conflict") || attempt >= ATTEMPTS) throw e;
        await this.load();
      }
    }
  }

  /** The socket's state changed: start or keep the agent session for it. */
  connected(connection: SocketState): void {
    this.connection = connection;
    void this.sync();
  }

  /**
   * Starts the agent session with the active provider, unless the socket
   * resumed the one started with it, and stops it when none is active. Runs
   * one at a time and applies every answer: the server holds whatever the
   * last request asked for.
   */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again);
    } finally {
      this.syncing = false;
    }
  }

  private async syncOnce(): Promise<void> {
    const connection = this.connection;
    if (connection?.kind !== "open" || this.providersState.kind !== "ready") return;
    const provider = activeProvider(this.providersState);
    const session = this.session;
    const held = session !== null && (session.connection === connection || connection.agentSessionId === session.id);
    if (!provider) {
      this.session = null;
      this.setAgent({ kind: "none" });
      // The server would keep the old provider's key and run turns with it.
      if (held) await this.deps.request("agent.stop", {}).catch(() => undefined);
      return;
    }
    if (session && held && same(session.provider, provider)) {
      session.connection = connection;
      this.setAgent({ kind: "ready" });
      return;
    }
    this.setAgent({ kind: "starting" });
    try {
      const { kind, base_url, api_key, model } = provider;
      const started = await this.deps.request("agent.start", { provider: { kind, base_url, api_key, model } });
      this.session = { id: started.agent_session_id, provider, connection };
      this.setAgent({ kind: "ready" });
    } catch (e) {
      this.session = null;
      // A lost connection starts again on the next open.
      if (e instanceof TransportError && e.code === "disconnected") return;
      this.setAgent({
        kind: e instanceof TransportError && e.code === "agent.invalid_provider" ? "refused" : "failed",
      });
      // A refused start leaves the previous session, with the previous provider, on the socket.
      if (held) await this.deps.request("agent.stop", {}).catch(() => undefined);
    }
  }
}
