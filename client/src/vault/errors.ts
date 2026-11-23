/**
 * Localized text for a keys failure (docs/i18n.md): a protocol code from the
 * server, a passkey outcome, or a chat-crypto error from the worker, which
 * arrives as its message (crates/crypto/src/error.rs).
 */
import type { MessageKey } from "../i18n/messages/en";
import { TransportError } from "../transport/socket";
import { PasskeyError } from "./passkey";

export interface KeysError {
  key: MessageKey;
  /** The word position for `keys.error.word`, from 1. */
  word?: number;
}

const byCode: Partial<Record<string, MessageKey>> = {
  "keys.exists": "keys.error.exists",
  "keys.limit": "keys.error.limit",
  "keys.device_mismatch": "keys.error.device",
  "link.not_found": "keys.linkPage.expired",
  "link.used": "keys.linkPage.used",
  rate_limited: "error.rate_limited",
  disconnected: "error.network",
  closed: "error.network",
};

const byPasskey: Record<PasskeyError["reason"], MessageKey> = {
  cancelled: "keys.error.passkeyCancelled",
  no_prf: "keys.error.noPrf",
  unsupported: "keys.error.passkeyFailed",
};

export function keysError(error: unknown): KeysError {
  if (error instanceof PasskeyError) return { key: byPasskey[error.reason] };
  if (error instanceof TransportError) return { key: byCode[error.code] ?? "error.generic" };
  const message = error instanceof Error ? error.message : "";
  const word = /recovery key word (\d+) is not in the word list/.exec(message);
  if (word) return { key: "keys.error.word", word: Number(word[1]) + 1 };
  if (message.startsWith("recovery key must have 12 words")) return { key: "keys.error.length" };
  if (message.startsWith("recovery key checksum")) return { key: "keys.error.checksum" };
  // A wrong secret and a key of another account look alike on purpose.
  if (message === "decryption failed" || message.startsWith("the key does not match"))
    return { key: "keys.error.wrong" };
  return { key: "error.generic" };
}
