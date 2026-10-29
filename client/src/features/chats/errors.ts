/** Localized text for chat failures, by protocol code (docs/i18n.md, D-089). */

import type { Unreadable } from "../../chats/records";
import type { MessageKey } from "../../i18n/messages/en";
import type { TurnErrorCode } from "../../protocol/generated/protocol";
import { TransportError } from "../../transport/socket";

/** What a refused request says in its toast. */
const byCode: Partial<Record<string, MessageKey>> = {
  "turn.busy": "chat.error.busy",
  "message.too_large": "chat.error.tooLarge",
  "agent.not_started": "chat.error.noAgent",
  "chat.not_found": "chat.error.notFound",
  "message.not_retryable": "chat.error.notRetryable",
  "message.streaming": "chat.error.streaming",
  "message.not_found": "chat.error.messageGone",
  "saved.limit": "saved.error.limit",
  "register.limit": "registers.error.limit",
  rate_limited: "error.rate_limited",
  disconnected: "error.network",
  closed: "error.network",
};

export function requestError(error: unknown): MessageKey {
  return (error instanceof TransportError && byCode[error.code]) || "error.generic";
}

const turnErrors: Record<TurnErrorCode, MessageKey> = {
  "provider.blocked": "turn.error.provider.blocked",
  "provider.unreachable": "turn.error.provider.unreachable",
  "provider.refused": "turn.error.provider.refused",
  "provider.invalid": "turn.error.provider.invalid",
  "turn.too_long": "turn.error.turn.too_long",
  "turn.timed_out": "turn.error.turn.timed_out",
  "turn.interrupted": "turn.error.turn.interrupted",
};

/** A failed reply's text; a code this build does not know still shows, named. */
export function turnError(code: string | undefined): { key: MessageKey; code?: string } {
  if (code === undefined) return { key: "turn.error.generic" };
  const key = turnErrors[code as TurnErrorCode];
  return key ? { key } : { key: "turn.error.unknown", code };
}

/** Retrying cannot help a reply the server's address policy blocked: the provider needs changing. */
export function retryHelps(code: string | undefined): boolean {
  return code !== "provider.blocked";
}

export const unreadable: Record<Unreadable, MessageKey> = {
  decrypt: "chat.unreadable.decrypt",
  parse: "chat.unreadable.parse",
  version: "chat.unreadable.version",
  size: "chat.unreadable.size",
};
