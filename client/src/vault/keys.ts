/**
 * The account's keys in this tab (docs/crypto.md, "Unlock and devices"):
 * first setup, unlock with a passkey, the recovery key or a remembered
 * device, and managing the unlock methods. The keys themselves stay in the
 * crypto worker; this holds only public values and wraps. Framework-free so
 * it can be tested without a DOM.
 */

import type { WrapInfo } from "../crypto/protocol";
import type {
  AccountKeys,
  AccountScope,
  AccountScopeKind,
  LinkRequester,
  Requests,
} from "../protocol/generated/protocol";
import type { RequestOptions, RequestType } from "../transport/socket";
import { bytesUuid, uuidBytes } from "./bytes";
import { type LinkCode, linkUrl } from "./link";
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
  /** `linkFailed`: a link message arrived but did not open (it was not made for this QR). */
  | { kind: "locked"; keys: Keys; device: boolean; linkFailed?: boolean }
  | { kind: "unlocked"; keys: Keys };

const ACCOUNT_SCOPES: AccountScopeKind[] = [
  "settings",
  "audit",
  "profile:basics",
  "profile:medical",
  "profile:lifestyle",
];

const resend = { retry: "resend" } as const;

/** A record kind of a chat scope, as the worker takes it (docs/crypto.md, kind table). */
export type ChatKind =
  | { kind: "chat.title" }
  | { kind: "chat.message"; messageId: number; author: "user" | "assistant" | "tool" | "summary" };

/** A record kind of the notes scope, as the worker takes it. */
export type NoteKind = { kind: "note.title"; noteId: Uint8Array } | { kind: "note.body"; noteId: Uint8Array };

/** An opened record; `origin` says whether a client or the server sealed it. */
export interface Opened {
  plaintext: Uint8Array;
  origin: "client" | "server";
}

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

/** The QR this tab shows, waiting for the unlocked device's message. */
interface PendingLink {
  sid: string;
  secret: Uint8Array;
  remember: boolean;
}

export interface LinkShown {
  url: string;
  /** How long the code lives, from when it was created. */
  expiresInMs: number;
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
  private link: PendingLink | null = null;
  /** Scope keys loaded into the worker: the latest key version, by scope id. */
  private readonly scopes = new Map<string, Promise<number>>();

  constructor(private readonly deps: KeysDeps) {
    this.opened = deps.vault.open(uuidBytes(deps.userId));
  }

  get current(): KeysState {
    return this.state;
  }

  get userId(): string {
    return this.deps.userId;
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
    // A code on screen stays up across a reconnect: unmounting it would end the link.
    const quiet = this.state.kind === "unlocked" || this.setup !== null || this.link !== null;
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
    // A message posted while this tab was offline is still on the server.
    if (this.link && (await this.collectLink(keys))) return;
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

  // Device linking, direction A (docs/crypto.md, "Device linking").

  /**
   * New device: a link session and the QR content for it, replacing the code
   * shown before; `origin` is this app's origin. `null` when the tab got
   * unlocked meanwhile, by the old code's message or another way.
   */
  async beginLink(origin: string): Promise<LinkShown | null> {
    if (this.state.kind !== "locked") return null;
    // The old code may have been answered just now: its message would be lost with it.
    if (this.link && (await this.collectLink(this.state.keys))) return null;
    const created = await this.deps.request("link.create", {}, resend);
    const offer = (await this.deps.vault.call("linkOffer")) as { publicKey: Uint8Array; secret: Uint8Array };
    if (this.state.kind !== "locked") {
      offer.secret.fill(0);
      return null;
    }
    this.link?.secret.fill(0);
    this.link = { sid: created.sid, secret: offer.secret, remember: this.link?.remember ?? false };
    if (this.state.linkFailed) this.set({ ...this.state, linkFailed: false });
    return { url: linkUrl(origin, { sid: created.sid, ...offer }), expiresInMs: created.expires_in_ms };
  }

  /**
   * Asks the server for the answer, in case its event was missed. `false`
   * when there is nothing to wait for any more (unlocked, or the code is gone).
   */
  async pollLink(): Promise<boolean> {
    if (this.state.kind !== "locked" || !this.link) return false;
    await this.collectLink(this.state.keys);
    return this.state.kind === "locked" && this.link !== null;
  }

  /** Whether the link, once it arrives, also remembers this device. */
  linkRemember(remember: boolean): void {
    if (this.link) this.link.remember = remember;
  }

  /** Stops waiting (the QR is no longer shown). */
  endLink(): void {
    this.link?.secret.fill(0);
    this.link = null;
  }

  /** The `link.message` event; messages of other or finished links are ignored. */
  async receiveLink(sid: string, message: Uint8Array): Promise<void> {
    if (this.link?.sid !== sid || this.state.kind !== "locked") return;
    await this.openLink(this.state.keys, message);
  }

  private async collectLink(keys: Keys): Promise<boolean> {
    const link = this.link;
    if (!link) return false;
    let message: Uint8Array | undefined;
    try {
      message = (await this.deps.request("link.get", { sid: link.sid }, resend)).message;
    } catch {
      // Expired or gone: the screen shows a new QR.
      this.endLink();
      return false;
    }
    if (!message) return false;
    await this.openLink(keys, message);
    return true;
  }

  private async openLink(keys: Keys, message: Uint8Array): Promise<void> {
    const link = this.link;
    if (!link) return;
    this.link = null;
    try {
      await this.deps.vault.call("linkReceive", uuidBytes(link.sid), link.secret, message, keys.commitment);
    } catch {
      this.set({ kind: "locked", keys, device: false, linkFailed: true });
      return;
    } finally {
      link.secret.fill(0);
    }
    await this.finishUnlock(keys, link.remember);
  }

  /** Unlocked device: who asks to be linked, as the server describes the session. */
  linkInfo(sid: string): Promise<LinkRequester> {
    this.requireUnlocked();
    return this.deps.request("link.info", { sid }, resend);
  }

  /** Unlocked device: seals the ARK to the key from the QR and posts it. */
  async sendLink(code: LinkCode): Promise<void> {
    this.requireUnlocked();
    const message = (await this.deps.vault.call(
      "linkSend",
      uuidBytes(code.sid),
      code.secret,
      code.publicKey,
      new Uint8Array(),
    )) as Uint8Array;
    await this.deps.request("link.post", { sid: code.sid, message }, resend);
  }

  // Records of the account scopes (docs/crypto.md, "Records").

  /**
   * Loads every key version of a scope into the worker once; resolves to the
   * latest. The worker unwraps them with the ARK, so a key of another scope
   * or account does not load.
   */
  private scopeKeys(scopeId: string): Promise<number> {
    let loaded = this.scopes.get(scopeId);
    if (!loaded) {
      loaded = (async () => {
        const { keys } = await this.deps.request("scope.keys", { scope_ids: [scopeId] }, resend);
        let latest = 0;
        for (const key of keys) {
          if (key.scope_id !== scopeId) continue;
          await this.deps.vault.call("loadScope", uuidBytes(scopeId), key.key_version, key.wrapped_private_key);
          latest = Math.max(latest, key.key_version);
        }
        if (latest === 0) throw new Error("scope has no keys");
        return latest;
      })();
      loaded.catch(() => this.scopes.delete(scopeId));
      this.scopes.set(scopeId, loaded);
    }
    return loaded;
  }

  private accountScope(kind: AccountScopeKind): string {
    const scope = this.requireUnlocked().scopes.find((s) => s.kind === kind);
    if (!scope) throw new Error(`no ${kind} scope`);
    return scope.scope_id;
  }

  /** Seals a setting's value (a `settings.value` record) to the latest key of the settings scope. */
  async sealSetting(key: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const scopeId = this.accountScope("settings");
    const version = await this.scopeKeys(scopeId);
    return (await this.deps.vault.call(
      "seal",
      uuidBytes(scopeId),
      version,
      { kind: "settings.value", key },
      plaintext,
    )) as Uint8Array;
  }

  /** Opens a setting's record; throws unless one of the user's clients wrote it for this key. */
  async openSetting(key: string, record: Uint8Array): Promise<Uint8Array> {
    const scopeId = this.accountScope("settings");
    await this.scopeKeys(scopeId);
    const opened = (await this.deps.vault.call(
      "open",
      uuidBytes(scopeId),
      { kind: "settings.value", key },
      record,
    )) as {
      plaintext: Uint8Array;
      origin: string;
    };
    // The worker already refuses a server-written record of a client-only kind.
    if (opened.origin !== "client") throw new Error("setting not written by a client");
    return opened.plaintext;
  }

  // Records of chat scopes (docs/protocol.md, "Chats and messages").

  /** The keys of a new chat, its id being the scope id; the private key stays loaded in the worker. */
  async createChat(chatId: string): Promise<{ publicKey: Uint8Array; wrappedPrivateKey: Uint8Array }> {
    this.requireUnlocked();
    const created = (await this.deps.vault.call("createScope", uuidBytes(chatId))) as {
      publicKey: Uint8Array;
      wrappedPrivateKey: Uint8Array;
    };
    this.scopes.set(chatId, Promise.resolve(1));
    return created;
  }

  /** Seals a client-written record (a title, an edited message) to the chat's latest key. */
  async sealChat(chatId: string, kind: ChatKind, plaintext: Uint8Array): Promise<Uint8Array> {
    this.requireUnlocked();
    const version = await this.scopeKeys(chatId);
    return (await this.deps.vault.call("seal", uuidBytes(chatId), version, kind, plaintext)) as Uint8Array;
  }

  /** Opens a chat record; the worker refuses a server-written record of a kind only clients write. */
  async openChat(chatId: string, kind: ChatKind, record: Uint8Array): Promise<Opened> {
    this.requireUnlocked();
    await this.scopeKeys(chatId);
    return (await this.deps.vault.call("open", uuidBytes(chatId), kind, record)) as Opened;
  }

  // Records of the notes scope (docs/protocol.md, "Notes").

  /** The keys of the notes scope; the private key stays loaded in the worker. */
  async createNotes(scopeId: string): Promise<{ publicKey: Uint8Array; wrappedPrivateKey: Uint8Array }> {
    this.requireUnlocked();
    const created = (await this.deps.vault.call("createScope", uuidBytes(scopeId))) as {
      publicKey: Uint8Array;
      wrappedPrivateKey: Uint8Array;
    };
    this.scopes.set(scopeId, Promise.resolve(1));
    return created;
  }

  /** Seals a note's title or body to the latest key of the notes scope. */
  async sealNote(scopeId: string, kind: NoteKind, plaintext: Uint8Array): Promise<Uint8Array> {
    this.requireUnlocked();
    const version = await this.scopeKeys(scopeId);
    return (await this.deps.vault.call("seal", uuidBytes(scopeId), version, kind, plaintext)) as Uint8Array;
  }

  /** Opens a note record; the worker refuses one the server sealed, as only clients write notes. */
  async openNote(scopeId: string, kind: NoteKind, record: Uint8Array): Promise<Uint8Array> {
    this.requireUnlocked();
    await this.scopeKeys(scopeId);
    return ((await this.deps.vault.call("open", uuidBytes(scopeId), kind, record)) as Opened).plaintext;
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
    this.endLink();
    this.setup = null;
    this.rotation = null;
    await this.opened.catch(() => undefined);
    await this.deps.vault.close();
  }
}
