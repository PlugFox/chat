/**
 * The WebSocket as the test build sees it: there is no server behind `vite
 * preview`, so `/ws` is answered from memory with the keys messages
 * (docs/protocol.md, "Keys"). Wraps are stored as they come; their method is
 * read from the second byte, as the server reads it with chat-crypto. Pages
 * installed on one `FakeKeys` share the account, like two devices of a user,
 * so a link posted by one reaches the other. Settings (docs/protocol.md,
 * "Settings") are stored as they come and sent to every page as events;
 * `agent.start` is answered and recorded; `agent.stop` and `agent.retire` are answered.
 * Chats are `FakeChats`, notes `FakeNotes`, registers `FakeRegisters`.
 */
import { readFileSync } from "node:fs";
import type { Page, WebSocketRoute } from "@playwright/test";
import init, { Vault } from "../../src/crypto/wasm/chat_crypto.js";
import type {
  AccountKeys,
  AccountScopeKind,
  ProviderSettings,
  Requests,
  ScopeKey,
} from "../../src/protocol/generated/protocol";
import { decodeFrame, encodeFrame } from "../../src/transport/codec";
import { FakeChats, Refused } from "./fake-chats";
import { FakeNotes } from "./fake-notes";
import { FakeRegisters } from "./fake-registers";

export const USER_ID = "0190d2c4-8b7e-7000-8000-000000000001";
const SESSION_ID = "0190d2c4-8b7e-7000-8000-00000000000a";
const SCOPES: AccountScopeKind[] = ["settings", "audit", "profile:basics", "profile:medical", "profile:lifestyle"];

function uuidBytes(uuid: string): Uint8Array {
  return new Uint8Array(
    uuid
      .replace(/-/g, "")
      .match(/../g)
      ?.map((b) => Number.parseInt(b, 16)) ?? [],
  );
}

function wrapId(wrap: Uint8Array): string {
  return Array.from(wrap.slice(2, 18), (b) => b.toString(16).padStart(2, "0")).join("");
}

let wasm: Promise<unknown> | null = null;

export interface SeededAccount {
  account: AccountKeys;
  scopeKeys: ScopeKey[];
  words: string;
}

/** An account made by the real chat-crypto, as a first setup would upload it, and its recovery words. */
export async function seededAccount(): Promise<SeededAccount> {
  wasm ??= init({
    module_or_path: readFileSync(new URL("../../src/crypto/wasm/chat_crypto_bg.wasm", import.meta.url)),
  });
  await wasm;
  const vault = new Vault(uuidBytes(USER_ID));
  try {
    const setup = vault.setup(uuidBytes(crypto.randomUUID())) as {
      recoveryWords: string;
      recoveryWrap: Uint8Array;
      commitment: Uint8Array;
      writerPublicKey: Uint8Array;
    };
    const scopes = SCOPES.map((kind) => ({ scope_id: crypto.randomUUID(), kind }));
    const scopeKeys = scopes.map(({ scope_id }) => {
      const key = vault.createScope(uuidBytes(scope_id)) as { publicKey: Uint8Array; wrappedPrivateKey: Uint8Array };
      return { scope_id, key_version: 1, public_key: key.publicKey, wrapped_private_key: key.wrappedPrivateKey };
    });
    return {
      words: setup.recoveryWords,
      scopeKeys,
      account: {
        commitment: setup.commitment,
        writer_public_key: setup.writerPublicKey,
        wraps: [{ wrap: setup.recoveryWrap, created_at: Date.now() - 86_400_000 }],
        scopes,
      },
    };
  } finally {
    vault.free();
  }
}

interface FakeLink {
  creator: WebSocketRoute;
  createdAt: number;
  message?: Uint8Array;
}

export class FakeKeys {
  account: AccountKeys | null = null;
  scopeKeys: ScopeKey[] = [];
  readonly requests: string[] = [];
  readonly links = new Map<string, FakeLink>();
  readonly settings = new Map<string, { record: Uint8Array; rev: number }>();
  /** The active provider of every `agent.start`, in order. */
  readonly agentStarts: ProviderSettings[] = [];
  private readonly sockets = new Set<WebSocketRoute>();
  /** Agent sessions a reconnect may resume. */
  private readonly agentSessions = new Set<string>();
  readonly chats = new FakeChats(USER_ID, this, (type, payload) => this.broadcast(type, payload));
  readonly notes = new FakeNotes(this, (type, payload) => this.broadcast(type, payload));
  readonly registers = new FakeRegisters(this, (type, payload) => this.broadcast(type, payload));

  constructor() {
    this.chats.scopeOf = (metric) => this.registers.scopes.get(metric);
  }

  private broadcast(type: string, payload: unknown): void {
    for (const socket of this.sockets) socket.send(Buffer.from(encodeFrame(type, 0, payload)));
  }

  /** Closes every socket, as a server restart would; the pages reconnect. */
  dropSockets(): void {
    for (const socket of this.sockets) void socket.close({ code: 1012 });
  }

  async install(page: Page): Promise<void> {
    await page.routeWebSocket("**/ws", (ws) => this.serve(ws));
  }

  private serve(ws: WebSocketRoute): void {
    this.sockets.add(ws);
    ws.onClose(() => this.sockets.delete(ws));
    ws.onMessage((message) => {
      if (typeof message === "string") return;
      const frame = decodeFrame(new Uint8Array(message));
      if (!frame) return;
      const [type, id, payload] = frame;
      this.requests.push(type);
      const ok = (body: unknown) => ws.send(Buffer.from(encodeFrame("ok", id, body)));
      const error = (code: string) =>
        ws.send(Buffer.from(encodeFrame("error", id, { code, message: code, retry: false })));
      switch (type) {
        case "auth": {
          const resume = (payload as Requests["auth"]["request"]).resume?.agent_session_id;
          const resumed = resume && this.agentSessions.has(resume) ? { agent_session_id: resume } : {};
          return ok({ session_id: SESSION_ID, heartbeat_ms: 20_000, server_time: Date.now(), ...resumed });
        }
        case "ping":
          return ok({ server_time: Date.now() });
        case "keys.get":
          return ok(this.account ? { keys: this.account } : {});
        case "keys.setup": {
          if (this.account) return error("keys.exists");
          const p = payload as Requests["keys.setup"]["request"];
          this.account = {
            commitment: p.commitment,
            writer_public_key: p.writer_public_key,
            wraps: p.wraps.map((wrap) => ({ wrap, created_at: Date.now() })),
            scopes: p.scopes.map((s) => ({ scope_id: s.scope_id, kind: s.kind })),
          };
          this.scopeKeys = p.scopes.map((s) => ({
            scope_id: s.scope_id,
            key_version: 1,
            public_key: s.public_key,
            wrapped_private_key: s.wrapped_private_key,
          }));
          return ok({});
        }
        case "keys.wrap_add": {
          if (!this.account) return error("keys.not_set_up");
          const { wrap } = payload as Requests["keys.wrap_add"]["request"];
          // One device wrap per session.
          if (wrap[1] === 4) this.account.wraps = this.account.wraps.filter((w) => w.wrap[1] !== 4);
          this.account.wraps.push({ wrap, created_at: Date.now() });
          return ok({});
        }
        case "keys.wrap_remove": {
          const id = (payload as Requests["keys.wrap_remove"]["request"]).wrap_id.replace(/-/g, "");
          if (this.account) this.account.wraps = this.account.wraps.filter((w) => wrapId(w.wrap) !== id);
          return ok({});
        }
        case "keys.recovery_rotate": {
          if (!this.account) return error("keys.not_set_up");
          const { wrap } = payload as Requests["keys.recovery_rotate"]["request"];
          this.account.wraps = [...this.account.wraps.filter((w) => w.wrap[1] !== 2), { wrap, created_at: Date.now() }];
          return ok({});
        }
        case "scope.keys": {
          const { scope_ids } = payload as Requests["scope.keys"]["request"];
          return ok({ keys: this.scopeKeys.filter((k) => scope_ids.includes(k.scope_id)) });
        }
        case "settings.get": {
          const value = this.settings.get((payload as Requests["settings.get"]["request"]).key);
          return ok(value ? { value } : {});
        }
        case "settings.put": {
          if (!this.account) return error("keys.not_set_up");
          const { key, record, rev } = payload as Requests["settings.put"]["request"];
          const stored = this.settings.get(key);
          if (stored?.rev !== rev) return error("settings.conflict");
          const next = { record, rev: (stored?.rev ?? 0) + 1 };
          this.settings.set(key, next);
          for (const socket of this.sockets) {
            socket.send(Buffer.from(encodeFrame("settings.updated", 0, { key, ...next })));
          }
          return ok({ rev: next.rev });
        }
        case "agent.start": {
          const start = payload as Requests["agent.start"]["request"];
          const active = start.providers.find((p) => p.id === start.active);
          if (active) {
            const { id, ...settings } = active;
            this.agentStarts.push(settings);
            this.chats.providerId = id;
          }
          const agent_session_id = crypto.randomUUID();
          this.agentSessions.add(agent_session_id);
          return ok({ agent_session_id });
        }
        case "agent.stop":
        case "agent.retire":
          return ok({});
        case "link.create": {
          if (!this.account) return error("keys.not_set_up");
          const sid = crypto.randomUUID();
          this.links.set(sid, { creator: ws, createdAt: Date.now() });
          return ok({ sid, expires_in_ms: 120_000 });
        }
        case "link.info": {
          const link = this.links.get((payload as Requests["link.info"]["request"]).sid);
          if (!link) return error("link.not_found");
          return ok({
            created_at: link.createdAt,
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131.0",
            country: "DE",
          });
        }
        case "link.post": {
          const { sid, message } = payload as Requests["link.post"]["request"];
          const link = this.links.get(sid);
          if (!link) return error("link.not_found");
          if (link.message && Buffer.compare(Buffer.from(link.message), Buffer.from(message)) !== 0) {
            return error("link.used");
          }
          link.message = message;
          link.creator.send(Buffer.from(encodeFrame("link.message", 0, { sid, message })));
          return ok({});
        }
        case "link.get": {
          const link = this.links.get((payload as Requests["link.get"]["request"]).sid);
          if (!link || link.creator !== ws) return error("link.not_found");
          return ok(link.message ? { message: link.message } : {});
        }
        default: {
          let answer: Promise<unknown> | undefined;
          try {
            answer =
              this.chats.handle(type, payload) ??
              this.notes.handle(type, payload) ??
              this.registers.handle(type, payload);
          } catch (e) {
            return error(e instanceof Refused ? e.code : "internal");
          }
          if (!answer) return error("protocol.unknown_type");
          return void answer.then(ok, (e: unknown) => error(e instanceof Refused ? e.code : "internal"));
        }
      }
    });
  }
}
