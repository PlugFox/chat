/** Localized text for an `/auth` failure, by protocol code (docs/i18n.md). */
import type { MessageKey } from "../i18n/messages/en";
import { AuthHttpError } from "./client";

const byCode: Partial<Record<string, MessageKey>> = {
  "auth.invalid_email": "error.auth.invalid_email",
  "auth.code_invalid": "error.auth.code_invalid",
  "auth.code_expired": "error.auth.code_expired",
  "auth.signup_closed": "error.auth.signup_closed",
  "auth.email_unverified": "error.auth.email_unverified",
  "auth.reauth_required": "error.auth.reauth_required",
  "identity.in_use": "error.identity.in_use",
  "identity.last": "error.identity.last",
  rate_limited: "error.rate_limited",
  network: "error.network",
};

export function errorKey(error: unknown): MessageKey {
  return (error instanceof AuthHttpError && byCode[error.code]) || "error.generic";
}
