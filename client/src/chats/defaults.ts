/**
 * The account's chat defaults, the `chat` setting (docs/crypto.md, "Record
 * contents"): how much history a chat carries when it chose none (D-091).
 * Read after every connect and `sync.reset`, followed by `settings.updated`,
 * changed with a retry on conflict. Framework-free so it can be tested
 * without a DOM.
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import type { History, Requests, SettingsUpdated } from "../protocol/generated/protocol";
import { type RequestOptions, type RequestType, TransportError } from "../transport/socket";

export const CHAT_KEY = "chat";
/** Attempts of one change when other devices keep changing the setting. */
const ATTEMPTS = 3;

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();

type Request = <T extends RequestType>(
  type: T,
  payload: Requests[T]["request"],
  options?: RequestOptions<T>,
) => Promise<Requests[T]["response"]>;

export interface ChatDefaultsValue {
  history?: History;
}

type Raw = Record<string, unknown>;

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** A `history` this client can use, else none; the record is authenticated, but a newer client may have written it. */
function history(v: unknown): History | undefined {
  if (!v || typeof v !== "object") return undefined;
  const h = v as Raw;
  if (h["mode"] === "recent" && positive(h["messages"])) return { mode: "recent", messages: h["messages"] };
  if (h["mode"] !== "compact") return undefined;
  const auto = typeof h["auto"] === "boolean" ? h["auto"] : undefined;
  const threshold = positive(h["threshold"]) ? h["threshold"] : undefined;
  return {
    mode: "compact",
    ...(auto === undefined ? {} : { auto }),
    ...(threshold === undefined ? {} : { threshold }),
  };
}

export function decodeDefaults(plaintext: Uint8Array): { value: ChatDefaultsValue; raw: Raw } {
  const decoded: unknown = decoder.decode(plaintext);
  const raw: Raw = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Raw) : {};
  const h = history(raw["history"]);
  return { value: h ? { history: h } : {}, raw };
}

/** The plaintext of `next`; fields this client does not know survive. */
export function encodeDefaults(next: ChatDefaultsValue, raw: Raw = {}): Uint8Array {
  const { history: _, ...rest } = raw;
  return encoder.encode(next.history ? { ...rest, history: next.history } : rest);
}

export interface DefaultsDeps {
  request: Request;
  seal: (plaintext: Uint8Array) => Promise<Uint8Array>;
  open: (record: Uint8Array) => Promise<Uint8Array>;
}

export class ChatDefaults {
  private current: ChatDefaultsValue = {};
  private raw: Raw = {};
  /** Absent while the setting was never stored or not read yet. */
  private rev: number | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: DefaultsDeps) {}

  get value(): ChatDefaultsValue {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private accept(value: ChatDefaultsValue, raw: Raw, rev: number | undefined): void {
    if (this.rev !== undefined && (rev === undefined || rev < this.rev)) return;
    this.current = value;
    this.raw = raw;
    this.rev = rev;
    for (const listener of this.listeners) listener();
  }

  private async receiveRecord(record: Uint8Array, rev: number): Promise<void> {
    let decoded: ReturnType<typeof decodeDefaults>;
    try {
      decoded = decodeDefaults(await this.deps.open(record));
    } catch {
      // Not readable here: the built-in defaults hold.
      return;
    }
    this.accept(decoded.value, decoded.raw, rev);
  }

  /** Reads the setting; a failure keeps what is known. */
  async load(): Promise<void> {
    const state = await this.deps
      .request("settings.get", { key: CHAT_KEY }, { retry: "resend" })
      .catch(() => undefined);
    if (state?.value) await this.receiveRecord(state.value.record, state.value.rev);
  }

  /** The `settings.updated` event. */
  async receive(event: SettingsUpdated): Promise<void> {
    if (event.key !== CHAT_KEY || (this.rev !== undefined && event.rev <= this.rev)) return;
    await this.receiveRecord(event.record, event.rev);
  }

  /** Stores the new defaults; when another device stored first, reads its value and stores again. */
  async update(next: ChatDefaultsValue): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const plaintext = encodeDefaults(next, this.raw);
      const record = await this.deps.seal(plaintext);
      const rev = this.rev;
      try {
        const stored = await this.deps.request(
          "settings.put",
          rev === undefined ? { key: CHAT_KEY, record } : { key: CHAT_KEY, record, rev },
          { retry: "resend" },
        );
        const written = decodeDefaults(plaintext);
        this.accept(written.value, written.raw, stored.rev);
        return;
      } catch (e) {
        if (!(e instanceof TransportError && e.code === "settings.conflict") || attempt >= ATTEMPTS) throw e;
        await this.load();
      }
    }
  }
}
