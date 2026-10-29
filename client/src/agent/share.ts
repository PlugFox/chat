/**
 * A provider config as a link (docs/protocol.md, "Provider links"; D-098):
 * `https://host/provider#1.<config>`, the config a MessagePack map in
 * base64url without padding. It is not encrypted. The opening page takes it
 * out of the address bar as soon as the page starts (`takeProviderFromUrl`).
 */
import { Decoder, Encoder } from "@msgpack/msgpack";
import type { ProviderKind, StoredProvider } from "../protocol/generated/protocol";

export type SharedProvider = Omit<StoredProvider, "id">;

const VERSION = "1";
export const PROVIDER_PATH = "/provider";
/** Longer than any real config; a QR holds far less. */
const FRAGMENT_MAX = 4096;
const KINDS = new Set<string>(["openai_compatible", "anthropic"] satisfies ProviderKind[]);

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function httpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function providerUrl(origin: string, provider: SharedProvider, withKey: boolean): string {
  const config = encoder.encode({
    kind: provider.kind,
    name: provider.name,
    base_url: provider.base_url,
    model: provider.model,
    api_key: withKey && provider.api_key !== "" ? provider.api_key : undefined,
  });
  return `${origin}${PROVIDER_PATH}#${VERSION}.${encode(config)}`;
}

/** The config in a fragment (without `#`), or `null` for anything else. */
export function parseProvider(fragment: string): SharedProvider | null {
  if (fragment.length > FRAGMENT_MAX) return null;
  const [version, config, ...rest] = fragment.split(".");
  if (version !== VERSION || config === undefined || rest.length > 0) return null;
  const bytes = decode(config);
  if (!bytes) return null;
  let raw: unknown;
  try {
    raw = decoder.decode(bytes);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { kind, name, base_url, model, api_key = "" } = raw as Record<string, unknown>;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof name !== "string" || typeof model !== "string" || typeof api_key !== "string") return null;
  if (typeof base_url !== "string" || !httpUrl(base_url)) return null;
  if (name.trim() === "" || model.trim() === "") return null;
  return { kind: kind as ProviderKind, name: name.trim(), base_url, model: model.trim(), api_key };
}

/** A pasted link from any host, or its fragment alone. */
export function parsePastedProvider(text: string): SharedProvider | null {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  return parseProvider(hash === -1 ? trimmed : trimmed.slice(hash + 1));
}

/** `null`: no link was opened; `"invalid"`: one was, and could not be read. */
let taken: SharedProvider | "invalid" | null = null;

/**
 * Reads the config once, at start-up, and removes the fragment from the
 * address bar and the history entry, so the key lives in memory only.
 */
export function takeProviderFromUrl(): void {
  if (location.pathname !== PROVIDER_PATH || location.hash.length < 2) return;
  taken = parseProvider(location.hash.slice(1)) ?? "invalid";
  history.replaceState(history.state, "", PROVIDER_PATH);
}

/** The config read at start-up; handed out once. */
export function claimProvider(): SharedProvider | "invalid" | null {
  const config = taken;
  taken = null;
  return config;
}
