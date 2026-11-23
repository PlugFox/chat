/**
 * Messages between the main thread and the crypto worker. The method list is
 * the whole surface: nothing in it returns the ARK, a KEK, a private key or
 * the remembered device's secret; `fileKey` returns one file's content key,
 * for a turn that reads it (docs/crypto.md, "Client worker API"; D-101).
 */
import type { Vault } from "./wasm/chat_crypto";

/**
 * Every Vault method the main thread may call, by name. The device-secret
 * methods are left out: only the worker's own device operations call them,
 * so the secret never crosses to the main thread.
 */
export type VaultMethod = Exclude<
  { [K in keyof Vault]: Vault[K] extends (...args: never[]) => unknown ? K : never }[keyof Vault],
  "free" | "__destroy_into_raw" | "deviceWrap" | "unlockWithDeviceSecret" | "encryptFileStart"
>;

export type VaultArgs<M extends VaultMethod> = Vault[M] extends (...args: infer A) => unknown ? A : never;
export type VaultResult<M extends VaultMethod> = Vault[M] extends (...args: never[]) => infer R ? R : never;

/** The public parameters of a wrap, as `describeWrap` returns them. */
export type WrapInfo =
  | { method: "passkey"; wrapId: Uint8Array; credentialId: Uint8Array; prfSalt: Uint8Array }
  | { method: "recovery"; wrapId: Uint8Array }
  | { method: "device"; wrapId: Uint8Array; deviceId: Uint8Array };

export type WorkerRequest =
  | { id: number; op: "open"; userId: Uint8Array }
  | { id: number; op: "call"; method: VaultMethod; args: unknown[] }
  | { id: number; op: "describe"; wrap: Uint8Array }
  | {
      id: number;
      op: "encryptFile";
      scopeId: Uint8Array;
      keyVersion: number;
      fileId: Uint8Array;
      plaintext: Blob;
      original: boolean;
    }
  | { id: number; op: "complete"; prefix: string }
  | { id: number; op: "remember"; wrapId: Uint8Array; deviceId: Uint8Array }
  | { id: number; op: "unlockWithDevice"; wrap: Uint8Array; commitment: Uint8Array }
  | { id: number; op: "remembered" }
  | { id: number; op: "forget" }
  | { id: number; op: "close" };

export type WorkerResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
