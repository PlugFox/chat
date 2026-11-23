/**
 * The device half of "remember this device" (docs/crypto.md, "Remember this
 * device"), used inside the crypto worker only: a 32-byte secret sealed with
 * a non-extractable AES-256-GCM WebCrypto key, both kept in IndexedDB.
 *
 *   blob = v=1 || nonce (12) || AES-256-GCM(key, nonce, secret, aad)
 *   aad  = "vc/v1/device" || user_id || device_id
 */

const DB_NAME = "chat-vault";
const STORE = "devices";
const VERSION = 1;
const NONCE_LEN = 12;
const SECRET_LEN = 32;
const LABEL = new TextEncoder().encode("vc/v1/device");

interface DeviceRecord {
  deviceId: Uint8Array<ArrayBuffer>;
  key: CryptoKey;
  blob: Uint8Array<ArrayBuffer>;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const open = indexedDB.open(DB_NAME, VERSION);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await request(open);
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** The record of a user on this device, keyed by user id. */
async function load(userId: Uint8Array): Promise<DeviceRecord | undefined> {
  return (await request((await store("readonly")).get(hex(userId)))) as DeviceRecord | undefined;
}

/** The remembered device id, if this browser remembers the user's device. */
export async function rememberedDevice(userId: Uint8Array): Promise<Uint8Array | null> {
  return (await load(userId))?.deviceId ?? null;
}

/** A new secret, sealed and stored; the caller wraps the ARK under it and must wipe it. */
export async function createSecret(userId: Uint8Array, deviceId: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_LEN));
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: concat(LABEL, userId, deviceId) },
    key,
    secret,
  );
  const record: DeviceRecord = { deviceId, key, blob: concat(new Uint8Array([1]), nonce, new Uint8Array(sealed)) };
  await request((await store("readwrite")).put(record, hex(userId)));
  return secret;
}

/** The stored secret, decrypted; the caller must wipe it. Fails when there is none. */
export async function openSecret(userId: Uint8Array): Promise<Uint8Array> {
  const record = await load(userId);
  if (!record) throw new Error("no remembered device");
  const { blob, key, deviceId } = record;
  if (blob[0] !== 1) throw new Error("unsupported device record version");
  const nonce = blob.slice(1, 1 + NONCE_LEN);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: concat(LABEL, userId, deviceId) },
    key,
    blob.slice(1 + NONCE_LEN),
  );
  return new Uint8Array(plain);
}

export async function forgetDevice(userId: Uint8Array): Promise<void> {
  await request((await store("readwrite")).delete(hex(userId)));
}
