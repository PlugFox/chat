/**
 * The QR content of device linking, direction A (docs/crypto.md, "Device
 * linking"): `https://host/link#1.<sid>.<pk_N>.<k>`, base64url without
 * padding. The fragment never reaches the server; the unlocked device takes
 * it out of the address bar as soon as the page starts (`takeLinkFromUrl`).
 */
import { bytesUuid, uuidBytes } from "./bytes";

export interface LinkCode {
  sid: string;
  publicKey: Uint8Array;
  secret: Uint8Array;
}

const VERSION = "1";
export const LINK_PATH = "/link";

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(text: string, length: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

export function linkUrl(origin: string, code: LinkCode): string {
  const parts = [VERSION, encode(uuidBytes(code.sid)), encode(code.publicKey), encode(code.secret)];
  return `${origin}${LINK_PATH}#${parts.join(".")}`;
}

/** The code in a fragment (without `#`), or `null` for anything else. */
export function parseLink(fragment: string): LinkCode | null {
  const [version, sid, publicKey, secret, ...rest] = fragment.split(".");
  if (version !== VERSION || rest.length > 0 || sid === undefined || publicKey === undefined || secret === undefined) {
    return null;
  }
  const sidBytes = decode(sid, 16);
  const pk = decode(publicKey, 32);
  const k = decode(secret, 32);
  return sidBytes && pk && k ? { sid: bytesUuid(sidBytes), publicKey: pk, secret: k } : null;
}

let taken: LinkCode | null = null;

/**
 * Reads the code once, at start-up, and removes the fragment from the address
 * bar and the history entry, so the secret lives in memory only.
 */
export function takeLinkFromUrl(): void {
  if (location.pathname !== LINK_PATH || location.hash.length < 2) return;
  taken = parseLink(location.hash.slice(1));
  history.replaceState(history.state, "", LINK_PATH);
}

/** The code read at start-up; handed out once. */
export function claimLink(): LinkCode | null {
  const code = taken;
  taken = null;
  return code;
}
