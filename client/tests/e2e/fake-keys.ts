/**
 * The WebSocket as the test build sees it: there is no server behind `vite
 * preview`, so `/ws` is answered from memory with the keys messages
 * (docs/protocol.md, "Keys"). Wraps are stored as they come; their method is
 * read from the second byte, as the server reads it with chat-crypto. Pages
 * installed on one `FakeKeys` share the account, like two devices of a user,
 * so a link posted by one reaches the other.
 */
import { readFileSync } from "node:fs";
import type { Page, WebSocketRoute } from "@playwright/test";
import init, { Vault } from "../../src/crypto/wasm/chat_crypto.js";
import type { AccountKeys, AccountScopeKind, Requests } from "../../src/protocol/generated/protocol";
import { decodeFrame, encodeFrame } from "../../src/transport/codec";

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

/** An account made by the real chat-crypto, as a first setup would upload it, and its recovery words. */
export async function seededAccount(): Promise<{ account: AccountKeys; words: string }> {
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
    return {
      words: setup.recoveryWords,
      account: {
        commitment: setup.commitment,
        writer_public_key: setup.writerPublicKey,
        wraps: [{ wrap: setup.recoveryWrap, created_at: Date.now() - 86_400_000 }],
        scopes: SCOPES.map((kind) => ({ scope_id: crypto.randomUUID(), kind })),
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
  readonly requests: string[] = [];
  readonly links = new Map<string, FakeLink>();

  async install(page: Page): Promise<void> {
    await page.routeWebSocket("**/ws", (ws) => this.serve(ws));
  }

  private serve(ws: WebSocketRoute): void {
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
        case "auth":
          return ok({ session_id: SESSION_ID, heartbeat_ms: 20_000, server_time: Date.now() });
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
        case "scope.keys":
          return ok({ keys: [] });
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
        default:
          return error("protocol.unknown_type");
      }
    });
  }
}
