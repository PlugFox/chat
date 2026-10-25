/**
 * The account's keys in this tab (docs/crypto.md, "Unlock and devices"):
 * first setup, unlock with a passkey, the recovery key or a remembered
 * device, and managing the unlock methods. The keys themselves stay in the
 * crypto worker; this holds only public values and wraps. Framework-free so
 * it can be tested without a DOM.
 */

import type { WrapInfo } from "../crypto/protocol";
import type { AccountKeys, AccountScope, AccountScopeKind, Requests } from "../protocol/generated/protocol";
import type { RequestOptions, RequestType } from "../transport/socket";
import { bytesUuid, uuidBytes } from "./bytes";
import type { Prf } from "./passkey";

/** What this needs from the crypto worker (`VaultClient`). */
export interface VaultLike {
  open(userId: Uint8Array): Promise<void>;
  call(method: string, ...args: unknown[]): Promise<unknown>;
  describe(wrap: Uint8Array): Promise<WrapInfo>;
  complete(prefix: string): Promise<string[]>;
  remember(wrapId: Uint8Array, deviceId: Uint8Array): Promise<Uint8Array>;
  unlockWithDevice(wrap: Uint8Array, commitment: Uint8Array): Promise<void>;
  remembered(): Promise<Uint8Array | null>;
  forget(): Promise<void>;
  close(): Promise<void>;
}

export interface KeysDeps {
  userId: string;
  /** The id this browser reports in `PUT /auth/session`. */
  deviceId: () => string;
  vault: VaultLike;
  request: <T extends RequestType>(
    type: T,
    payload: Requests[T]["request"],
    options?: RequestOptions<T>,
  ) => Promise<Requests[T]["response"]>;
  passkeys: {
    available: () => Promise<boolean>;
    create: (options: { userId: Uint8Array; name: string; exclude: Uint8Array[]; salt: Uint8Array }) => Promise<Prf>;
    evaluate: (passkeys: { credentialId: Uint8Array; salt: Uint8Array }[]) => Promise<Prf>;
  };
  /** Whether this browser has seen the account's keys before (see `KeysState.new`). */
  known: { get: () => boolean; set: () => void };
  /** The name a new passkey gets in the passkey manager. */
  passkeyName: () => string;
}

export type Wrap = WrapInfo & { id: string; wrap: Uint8Array; createdAt: number };

export interface Keys {
  commitment: Uint8Array;
  wraps: Wrap[];
  scopes: AccountScope[];
}

export type KeysState =
  | { kind: "loading" }
  | { kind: "failed" }
  /** No keys on the server. `known`: this browser unlocked them before, so the server may be lying. */
  | { kind: "new"; known: boolean }
  | { kind: "locked"; keys: Keys; device: boolean }
  | { kind: "unlocked"; keys: Keys };

const ACCOUNT_SCOPES: AccountScopeKind[] = [
  "settings",
  "audit",
  "profile:basics",
  "profile:medical",
  "profile:lifestyle",
];

const resend = { retry: "resend" } as const;

function randomId(): Uint8Array<ArrayBuffer> {
  return uuidBytes(crypto.randomUUID());
}

interface PendingSetup {
  words: string[];
  recoveryWrap: Uint8Array;
  commitment: Uint8Array;
  writerPublicKey: Uint8Array;
  passkeys: Uint8Array[];
}

interface PendingRotation {
  words: string[];
  wrap: Uint8Array;
}

export class KeyVault {
  private state: KeysState = { kind: "loading" };
  private readonly listeners = new Set<(state: KeysState) => void>();
  private readonly opened: Promise<void>;
  private setup: PendingSetup | null = null;
  private rotation: PendingRotation | null = null;

  constructor(private readonly deps: KeysDeps) {
    this.opened = deps.vault.open(uuidBytes(deps.userId));
  }

  get current(): KeysState {
    return this.state;
  }

  subscribe(listener: (state: KeysState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: KeysState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private keys(): Keys {
    if (this.state.kind !== "locked" && this.state.kind !== "unlocked") throw new Error("keys not loaded");
    return this.state.keys;
  }

  private requireUnlocked(): Keys {
    if (this.state.kind !== "unlocked") throw new Error("vault is locked");
    return this.state.keys;
  }

  private async describe(account: AccountKeys): Promise<Keys> {
    const wraps = await Promise.all(
      account.wraps.map(async (stored) => {
        const info = await this.deps.vault.describe(stored.wrap);
        return { ...info, id: bytesUuid(info.wrapId), wrap: stored.wrap, createdAt: stored.created_at };
      }),
    );
    return { commitment: account.commitment, wraps, scopes: account.scopes };
  }

  /**
   * Fetches the keys (after every connect). An unlocked tab stays unlocked,
   * and a setup in progress keeps its screen unless another device finished one.
   */
  async load(): Promise<void> {
    await this.opened;
    const quiet = this.state.kind === "unlocked" || this.setup !== null;
    if (!quiet) this.set({ kind: "loading" });
    let account: AccountKeys | undefined;
    try {
      account = (await this.deps.request("keys.get", {}, resend)).keys;
    } catch {
      if (!quiet) this.set({ kind: "failed" });
      return;
    }
    if (!account) {
      if (!quiet) this.set({ kind: "new", known: this.deps.known.get() });
      return;
    }
    if (this.setup) await this.abandonSetup();
    const keys = await this.describe(account);
    if (this.state.kind === "unlocked") {
      this.set({ kind: "unlocked", keys });
      return;
    }
    await this.unlockWithDevice(keys);
  }

  /**
   * Unlocks silently when this browser remembers the device and the server
   * still holds its wrap; otherwise shows the unlock screen. Decided before
   * any locked state is shown, so the unlock screen never flashes.
   */
  private async unlockWithDevice(keys: Keys): Promise<void> {
    const remembered = await this.deps.vault.remembered();
    const wrap = keys.wraps.find((w) => w.method === "device");
    if (remembered && !wrap) {
      // The session ended or the device was forgotten elsewhere: the local half is useless now.
      await this.deps.vault.forget();
    }
    if (!remembered || !wrap) {
      this.set({ kind: "locked", keys, device: false });
      return;
    }
    this.set({ kind: "locked", keys, device: true });
    try {
      await this.deps.vault.unlockWithDevice(wrap.wrap, keys.commitment);
      this.unlocked(keys);
    } catch {
      await this.deps.vault.forget();
      this.set({ kind: "locked", keys, device: false });
    }
  }

  /**
   * Shows the tab as unlocked; with `remember`, only once the server holds
   * the device wrap, so a reload right after already unlocks by itself. A
   * failure to remember does not undo the unlock.
   */
  private async finishUnlock(keys: Keys, remember: boolean): Promise<void> {
    let current = keys;
    if (remember) {
      try {
        await this.storeDeviceWrap();
        const account = (await this.deps.request("keys.get", {}, resend)).keys;
        if (account) current = await this.describe(account);
      } catch {
        // Settings still offer "remember this device".
      }
    }
    this.unlocked(current);
  }

  private async storeDeviceWrap(): Promise<void> {
    const wrap = await this.deps.vault.remember(randomId(), uuidBytes(this.deps.deviceId()));
    try {
      await this.deps.request("keys.wrap_add", { wrap }, resend);
    } catch (e) {
      await this.deps.vault.forget();
      throw e;
    }
  }

  private unlocked(keys: Keys): void {
    this.deps.known.set();
    this.set({ kind: "unlocked", keys });
  }

  passkeyAvailable(): Promise<boolean> {
    return this.deps.passkeys.available();
  }

  /** Recovery list words that complete `prefix`. */
  completeWord(prefix: string): Promise<string[]> {
    return this.deps.vault.complete(prefix);
  }

  // First setup (docs/crypto.md, "First key setup"): nothing reaches the
  // server until the user confirmed the recovery words.

  /** Creates the ARK and the recovery key in the worker; returns the words, shown once. */
  async beginSetup(): Promise<string[]> {
    await this.opened;
    const result = (await this.deps.vault.call("setup", randomId())) as {
      recoveryWords: string;
      recoveryWrap: Uint8Array;
      commitment: Uint8Array;
      writerPublicKey: Uint8Array;
    };
    this.setup = {
      words: result.recoveryWords.split(" "),
      recoveryWrap: result.recoveryWrap,
      commitment: result.commitment,
      writerPublicKey: result.writerPublicKey,
      passkeys: [],
    };
    return this.setup.words;
  }

  /** Registers a passkey and wraps the new ARK for it. Throws `PasskeyError`. */
  async setupPasskey(): Promise<void> {
    if (!this.setup) throw new Error("no setup in progress");
    this.setup.passkeys.push(await this.passkeyWrap([]));
  }

  /** Uploads everything in one request; `keys.exists` means another device set up first. */
  async finishSetup(remember: boolean): Promise<void> {
    const setup = this.setup;
    if (!setup) throw new Error("no setup in progress");
    const scopes = [];
    for (const kind of ACCOUNT_SCOPES) {
      const scopeId = crypto.randomUUID();
      const scope = (await this.deps.vault.call("createScope", uuidBytes(scopeId))) as {
        publicKey: Uint8Array;
        wrappedPrivateKey: Uint8Array;
      };
      scopes.push({
        scope_id: scopeId,
        kind,
        public_key: scope.publicKey,
        wrapped_private_key: scope.wrappedPrivateKey,
      });
    }
    await this.deps.request(
      "keys.setup",
      {
        commitment: setup.commitment,
        writer_public_key: setup.writerPublicKey,
        wraps: [setup.recoveryWrap, ...setup.passkeys],
        scopes,
      },
      resend,
    );
    this.setup = null;
    const account = (await this.deps.request("keys.get", {}, resend)).keys;
    if (!account) throw new Error("keys missing after setup");
    await this.finishUnlock(await this.describe(account), remember);
  }

  /** Drops a setup that was not uploaded: wipes the new ARK. */
  async abandonSetup(): Promise<void> {
    this.setup = null;
    await this.deps.vault.call("lock");
  }

  // Unlock.

  async unlockWithPasskey(remember: boolean): Promise<void> {
    const keys = this.keys();
    const passkeys = keys.wraps.flatMap((w) => (w.method === "passkey" ? [w] : []));
    const prf = await this.deps.passkeys.evaluate(
      passkeys.map((p) => ({ credentialId: p.credentialId, salt: p.prfSalt })),
    );
    const wrap = passkeys.find((p) => bytesUuid(p.credentialId) === bytesUuid(prf.credentialId));
    if (!wrap) throw new Error("unknown passkey");
    try {
      await this.deps.vault.call("unlockWithPrf", prf.output, wrap.wrap, keys.commitment);
    } finally {
      prf.output.fill(0);
    }
    await this.finishUnlock(keys, remember);
  }

  async unlockWithRecovery(words: string, remember: boolean): Promise<void> {
    const keys = this.keys();
    const wrap = keys.wraps.find((w) => w.method === "recovery");
    if (!wrap) throw new Error("no recovery wrap");
    await this.deps.vault.call("unlockWithRecovery", words, wrap.wrap, keys.commitment);
    await this.finishUnlock(keys, remember);
  }

  // Unlock methods.

  private async passkeyWrap(exclude: Uint8Array[]): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const prf = await this.deps.passkeys.create({
      userId: uuidBytes(this.deps.userId),
      name: this.deps.passkeyName(),
      exclude,
      salt,
    });
    try {
      return (await this.deps.vault.call("passkeyWrap", randomId(), prf.credentialId, salt, prf.output)) as Uint8Array;
    } finally {
      prf.output.fill(0);
    }
  }

  private async reload(): Promise<void> {
    const account = (await this.deps.request("keys.get", {}, resend)).keys;
    if (account && this.state.kind === "unlocked") this.set({ kind: "unlocked", keys: await this.describe(account) });
  }

  async addPasskey(): Promise<void> {
    const keys = this.requireUnlocked();
    const exclude = keys.wraps.flatMap((w) => (w.method === "passkey" ? [w.credentialId] : []));
    const wrap = await this.passkeyWrap(exclude);
    await this.deps.request("keys.wrap_add", { wrap }, resend);
    await this.reload();
  }

  async removeWrap(id: string): Promise<void> {
    const wrap = this.requireUnlocked().wraps.find((w) => w.id === id);
    await this.deps.request("keys.wrap_remove", { wrap_id: id }, resend);
    if (wrap?.method === "device") await this.deps.vault.forget();
    await this.reload();
  }

  /** Remembers this device (D-018): the secret stays in the worker, its wrap goes to the server. */
  async remember(): Promise<void> {
    this.requireUnlocked();
    await this.storeDeviceWrap();
    await this.reload();
  }

  async forgetDevice(): Promise<void> {
    const wrap = this.requireUnlocked().wraps.find((w) => w.method === "device");
    if (wrap) await this.removeWrap(wrap.id);
    else await this.deps.vault.forget();
  }

  /** A new recovery key; nothing changes until `finishRotation`. Returns the words, shown once. */
  async beginRotation(): Promise<string[]> {
    this.requireUnlocked();
    const result = (await this.deps.vault.call("rotateRecovery", randomId())) as {
      recoveryWords: string;
      recoveryWrap: Uint8Array;
    };
    this.rotation = { words: result.recoveryWords.split(" "), wrap: result.recoveryWrap };
    return this.rotation.words;
  }

  /** Replaces the recovery wrap: the old words stop working. */
  async finishRotation(): Promise<void> {
    const rotation = this.rotation;
    if (!rotation) throw new Error("no rotation in progress");
    await this.deps.request("keys.recovery_rotate", { wrap: rotation.wrap }, resend);
    this.rotation = null;
    await this.reload();
  }

  abandonRotation(): void {
    this.rotation = null;
  }

  /** Wipes the keys and ends the worker (sign-out). */
  async close(): Promise<void> {
    this.setup = null;
    this.rotation = null;
    await this.opened.catch(() => undefined);
    await this.deps.vault.close();
  }
}
