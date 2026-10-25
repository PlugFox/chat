/**
 * Messages between the main thread and the crypto worker. The method list is
 * the whole surface: nothing in it returns the ARK, a KEK or a private key
 * (docs/crypto.md, "Client worker API").
 */
import type { Vault } from "./wasm/chat_crypto";

/** Every Vault method the main thread may call, by name. */
export type VaultMethod = Exclude<
  { [K in keyof Vault]: Vault[K] extends (...args: never[]) => unknown ? K : never }[keyof Vault],
  "free" | "__destroy_into_raw"
>;

export type VaultArgs<M extends VaultMethod> = Vault[M] extends (...args: infer A) => unknown ? A : never;
export type VaultResult<M extends VaultMethod> = Vault[M] extends (...args: never[]) => infer R ? R : never;

export type WorkerRequest =
  | { id: number; op: "open"; userId: Uint8Array }
  | { id: number; op: "call"; method: VaultMethod; args: unknown[] }
  | { id: number; op: "close" };

export type WorkerResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
