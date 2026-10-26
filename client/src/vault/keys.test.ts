import { describe, expect, it, vi } from "vitest";
import type { WrapInfo } from "../crypto/protocol";
import type { AccountKeys, Requests } from "../protocol/generated/protocol";
import { TransportError } from "../transport/socket";
import { bytesUuid, uuidBytes } from "./bytes";
import { type KeysDeps, KeyVault, type VaultLike } from "./keys";

const USER = "0190d2c4-8b7e-7000-8000-000000000001";
const DEVICE = "0190d2c4-8b7e-7000-8000-0000000000d1";
const LINK = "0190d2c4-8b7e-7000-8000-0000000000e1";
const WORDS = "one two three four five six seven eight nine ten eleven twelve";

/** A wrap as bytes: [method code, 16 id bytes]; the fake worker "describes" it from that. */
function wrapBytes(method: 1 | 2 | 4, id: string = crypto.randomUUID()): Uint8Array {
  return new Uint8Array([method, ...uuidBytes(id)]);
}

function describe_(wrap: Uint8Array): WrapInfo {
  const wrapId = wrap.slice(1, 17);
  if (wrap[0] === 1) return { method: "passkey", wrapId, credentialId: wrapId, prfSalt: new Uint8Array(32) };
  if (wrap[0] === 4) return { method: "device", wrapId, deviceId: uuidBytes(DEVICE) };
  return { method: "recovery", wrapId };
}

/** Server and worker in memory, with what each call did. */
function fixture(options: { account?: AccountKeys; remembered?: boolean; known?: boolean } = {}) {
  let account = options.account;
  let linkMessage: Uint8Array | undefined;
  const offered: Uint8Array[] = [];
  let remembered = options.remembered ?? false;
  const calls: string[] = [];
  const vault: VaultLike = {
    open: async () => undefined,
    call: async (method, ...args) => {
      calls.push(`vault.${method}`);
      if (method === "setup") {
        return {
          recoveryWords: WORDS,
          recoveryWrap: wrapBytes(2),
          commitment: new Uint8Array(32),
          writerPublicKey: new Uint8Array(32),
        };
      }
      if (method === "createScope") return { publicKey: new Uint8Array(32), wrappedPrivateKey: new Uint8Array(73) };
      if (method === "passkeyWrap") return wrapBytes(1, bytesUuid(args[0] as Uint8Array));
      if (method === "rotateRecovery") return { recoveryWords: WORDS, recoveryWrap: wrapBytes(2) };
      if (method === "unlockWithRecovery" && args[0] !== WORDS) throw new Error("decryption failed");
      if (method === "linkOffer") {
        const secret = new Uint8Array(32).fill(5);
        offered.push(secret);
        return { publicKey: new Uint8Array(32).fill(4), secret };
      }
      // A message the fake worker opens: one that starts with 1.
      if (method === "linkReceive" && (args[2] as Uint8Array)[0] !== 1) throw new Error("decryption failed");
      return undefined;
    },
    describe: async (wrap) => describe_(wrap),
    complete: async () => [],
    remember: async (wrapId) => {
      calls.push("vault.remember");
      remembered = true;
      return wrapBytes(4, bytesUuid(wrapId));
    },
    unlockWithDevice: async () => {
      calls.push("vault.unlockWithDevice");
    },
    remembered: async () => (remembered ? uuidBytes(DEVICE) : null),
    forget: async () => {
      calls.push("vault.forget");
      remembered = false;
    },
    close: async () => undefined,
  };
  const request = vi.fn(async (type: string, payload: unknown): Promise<unknown> => {
    calls.push(type);
    const now = Date.now();
    switch (type) {
      case "keys.get":
        return account ? { keys: account } : {};
      case "keys.setup": {
        if (account) throw new TransportError("keys.exists", "exists");
        const p = payload as Requests["keys.setup"]["request"];
        account = {
          commitment: p.commitment,
          writer_public_key: p.writer_public_key,
          wraps: p.wraps.map((wrap) => ({ wrap, created_at: now })),
          scopes: p.scopes.map((s) => ({ scope_id: s.scope_id, kind: s.kind })),
        };
        return {};
      }
      case "keys.wrap_add":
        account?.wraps.push({ wrap: (payload as { wrap: Uint8Array }).wrap, created_at: now });
        return {};
      case "keys.wrap_remove":
        if (account) {
          const id = (payload as { wrap_id: string }).wrap_id;
          account.wraps = account.wraps.filter((w) => bytesUuid(w.wrap.slice(1, 17)) !== id);
        }
        return {};
      case "keys.recovery_rotate":
        if (account) {
          account.wraps = [
            ...account.wraps.filter((w) => w.wrap[0] !== 2),
            { wrap: (payload as { wrap: Uint8Array }).wrap, created_at: now },
          ];
        }
        return {};
      case "link.create":
        return { sid: LINK, expires_in_ms: 120_000 };
      case "link.get":
        return linkMessage ? { message: linkMessage } : {};
      default:
        throw new Error(type);
    }
  });
  let known = options.known ?? false;
  const deps: KeysDeps = {
    userId: USER,
    deviceId: () => DEVICE,
    vault,
    request: request as unknown as KeysDeps["request"],
    passkeys: {
      available: async () => true,
      create: async () => ({ credentialId: new Uint8Array(16), output: new Uint8Array(32).fill(9) }),
      evaluate: async (list) => ({
        credentialId: list[0]?.credentialId ?? new Uint8Array(),
        output: new Uint8Array(32),
      }),
    },
    known: { get: () => known, set: () => (known = true) },
    passkeyName: () => "Vault Chat",
  };
  return {
    keys: new KeyVault(deps),
    calls,
    account: () => account,
    setAccount: (a: AccountKeys) => {
      account = a;
    },
    isKnown: () => known,
    offered,
    post: (message: Uint8Array) => {
      linkMessage = message;
    },
  };
}

function existing(...wraps: Uint8Array[]): AccountKeys {
  return {
    commitment: new Uint8Array(32),
    writer_public_key: new Uint8Array(32),
    wraps: wraps.map((wrap) => ({ wrap, created_at: 1 })),
    scopes: [],
  };
}

describe("KeyVault", () => {
  it("sets up: nothing is uploaded before the words are confirmed, then everything at once", async () => {
    const f = fixture();
    await f.keys.load();
    expect(f.keys.current).toEqual({ kind: "new", known: false });

    expect(await f.keys.beginSetup()).toHaveLength(12);
    await f.keys.setupPasskey();
    expect(f.calls.filter((c) => c.startsWith("keys."))).toEqual(["keys.get"]);

    await f.keys.finishSetup(true);
    expect(f.keys.current.kind).toBe("unlocked");
    const methods = f.account()?.wraps.map((w) => w.wrap[0]);
    expect(methods).toEqual([2, 1, 4]);
    expect(f.account()?.scopes.map((s) => s.kind)).toEqual([
      "settings",
      "audit",
      "profile:basics",
      "profile:medical",
      "profile:lifestyle",
    ]);
    expect(f.isKnown()).toBe(true);
  });

  it("warns when the server forgets keys this browser has seen", async () => {
    const f = fixture({ known: true });
    await f.keys.load();
    expect(f.keys.current).toEqual({ kind: "new", known: true });
  });

  it("keeps a setup in progress across a reconnect, and gives way to another device's", async () => {
    const f = fixture();
    await f.keys.load();
    await f.keys.beginSetup();
    await f.keys.load();
    expect(f.keys.current.kind).toBe("new");
    expect(f.calls).not.toContain("vault.lock");
  });

  it("unlocks with the recovery key and reports a wrong one", async () => {
    const f = fixture({ account: existing(wrapBytes(2)) });
    await f.keys.load();
    expect(f.keys.current.kind).toBe("locked");
    await expect(f.keys.unlockWithRecovery("wrong words", false)).rejects.toThrow("decryption failed");
    expect(f.keys.current.kind).toBe("locked");
    await f.keys.unlockWithRecovery(WORDS, false);
    expect(f.keys.current.kind).toBe("unlocked");
  });

  it("unlocks a remembered device by itself", async () => {
    const f = fixture({ account: existing(wrapBytes(2), wrapBytes(4)), remembered: true });
    await f.keys.load();
    expect(f.calls).toContain("vault.unlockWithDevice");
    expect(f.keys.current.kind).toBe("unlocked");
  });

  it("drops the local half when the server no longer holds the device wrap", async () => {
    const f = fixture({ account: existing(wrapBytes(2)), remembered: true });
    await f.keys.load();
    expect(f.calls).toContain("vault.forget");
    expect(f.keys.current).toMatchObject({ kind: "locked", device: false });
  });

  it("forgets the device on both sides", async () => {
    const f = fixture({ account: existing(wrapBytes(2)) });
    await f.keys.load();
    await f.keys.unlockWithRecovery(WORDS, true);
    expect(f.account()?.wraps.some((w) => w.wrap[0] === 4)).toBe(true);
    await f.keys.forgetDevice();
    expect(f.account()?.wraps.some((w) => w.wrap[0] === 4)).toBe(false);
    expect(f.calls).toContain("vault.forget");
  });

  it("rotates the recovery key only when finished", async () => {
    const recovery = wrapBytes(2);
    const f = fixture({ account: existing(recovery) });
    await f.keys.load();
    await f.keys.unlockWithRecovery(WORDS, false);
    await f.keys.beginRotation();
    expect(f.account()?.wraps[0]?.wrap).toBe(recovery);
    await f.keys.finishRotation();
    expect(f.account()?.wraps[0]?.wrap).not.toBe(recovery);
    expect(f.keys.current.kind === "unlocked" && f.keys.current.keys.wraps).toHaveLength(1);
  });

  it("gives up a setup that lost the race to another device", async () => {
    const f = fixture();
    await f.keys.load();
    await f.keys.beginSetup();
    f.setAccount(existing(wrapBytes(2)));
    await expect(f.keys.finishSetup(false)).rejects.toMatchObject({ code: "keys.exists" });
    await f.keys.abandonSetup();
    await f.keys.load();
    expect(f.keys.current.kind).toBe("locked");
  });

  it("finds out about another device's setup on reconnect", async () => {
    const f = fixture();
    await f.keys.load();
    await f.keys.beginSetup();
    f.setAccount(existing(wrapBytes(2)));
    await f.keys.load();
    expect(f.keys.current.kind).toBe("locked");
    expect(f.calls).toContain("vault.lock");
  });

  it("links: the QR carries the session, and the posted message unlocks and remembers", async () => {
    const f = fixture({ account: existing(wrapBytes(2)) });
    await f.keys.load();
    const shown = await f.keys.beginLink("https://chat.example");
    expect(shown?.url).toMatch(/^https:\/\/chat\.example\/link#1\./);
    f.keys.linkRemember(true);
    await f.keys.receiveLink("0190d2c4-8b7e-7000-8000-0000000000e2", new Uint8Array([1]));
    expect(f.keys.current.kind).toBe("locked");
    await f.keys.receiveLink(LINK, new Uint8Array([1]));
    expect(f.keys.current.kind).toBe("unlocked");
    expect(f.account()?.wraps.some((w) => w.wrap[0] === 4)).toBe(true);
    // The secret is wiped once used.
    expect(f.offered[0]?.every((b) => b === 0)).toBe(true);
  });

  it("links: a message posted while offline is collected on reconnect", async () => {
    const f = fixture({ account: existing(wrapBytes(2)) });
    await f.keys.load();
    await f.keys.beginLink("https://chat.example");
    f.post(new Uint8Array([1]));
    await f.keys.load();
    expect(f.keys.current.kind).toBe("unlocked");
  });

  it("links: a message that does not open says so and waits for a new code", async () => {
    const f = fixture({ account: existing(wrapBytes(2)) });
    await f.keys.load();
    await f.keys.beginLink("https://chat.example");
    await f.keys.receiveLink(LINK, new Uint8Array([2]));
    expect(f.keys.current).toMatchObject({ kind: "locked", linkFailed: true });
    await f.keys.beginLink("https://chat.example");
    expect(f.keys.current).toMatchObject({ kind: "locked", linkFailed: false });
  });
});
