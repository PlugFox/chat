/**
 * Passkeys as a source of PRF output (D-065): no server challenge, no
 * attestation. The challenge is random and never checked, because nothing
 * is signed in with the assertion; the PRF output for a stored salt is all
 * that matters, and it goes straight to the crypto worker.
 */

export type PasskeyFailure = "cancelled" | "no_prf" | "unsupported";

export class PasskeyError extends Error {
  constructor(readonly reason: PasskeyFailure) {
    super(`passkey: ${reason}`);
    this.name = "PasskeyError";
  }
}

/** The WebAuthn PRF extension, not yet in every TypeScript DOM library. */
interface PrfValues {
  first: BufferSource;
}
interface PrfInputs {
  eval?: PrfValues;
  evalByCredential?: Record<string, PrfValues>;
}
interface PrfOutputs {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
}

function random(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function prfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const outputs = (credential.getClientExtensionResults() as { prf?: PrfOutputs }).prf;
  const first = outputs?.results?.first;
  return first ? new Uint8Array(first) : null;
}

function fail(e: unknown): never {
  if (e instanceof PasskeyError) throw e;
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) {
    throw new PasskeyError("cancelled");
  }
  throw new PasskeyError("unsupported");
}

/** Whether this browser may produce PRF output: false only when it says so. */
export async function prfAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials) return false;
  const capabilities = (
    PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }
  ).getClientCapabilities;
  if (!capabilities) return true;
  try {
    return (await capabilities())["extension:prf"] !== false;
  } catch {
    return true;
  }
}

export interface Prf {
  credentialId: Uint8Array;
  output: Uint8Array;
}

/** PRF output from one of the given passkeys, each with its own salt. */
export async function evaluate(passkeys: { credentialId: Uint8Array; salt: Uint8Array }[]): Promise<Prf> {
  const prf: PrfInputs = {
    evalByCredential: Object.fromEntries(
      passkeys.map((p) => [base64url(p.credentialId), { first: new Uint8Array(p.salt) }]),
    ),
  };
  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: passkeys.map((p) => ({ type: "public-key", id: new Uint8Array(p.credentialId) })),
        userVerification: "required",
        extensions: { prf } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    fail(e);
  }
  const output = prfOutput(credential);
  if (!output) throw new PasskeyError("no_prf");
  return { credentialId: new Uint8Array(credential.rawId), output };
}

export interface NewPasskey {
  /** The account's user id: one passkey per account on an authenticator. */
  userId: Uint8Array;
  /** Shown by the passkey manager. */
  name: string;
  /** Credentials of the account already enrolled, so the authenticator refuses a duplicate. */
  exclude: Uint8Array[];
  salt: Uint8Array;
}

/**
 * Registers a passkey and returns its PRF output for `salt`: from the
 * registration where the authenticator supports it, otherwise from an
 * immediate second prompt.
 */
export async function create(options: NewPasskey): Promise<Prf> {
  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Vault Chat" },
        user: { id: new Uint8Array(options.userId), name: options.name, displayName: options.name },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: options.exclude.map((id) => ({ type: "public-key", id: new Uint8Array(id) })),
        extensions: { prf: { eval: { first: new Uint8Array(options.salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    fail(e);
  }
  const outputs = (credential.getClientExtensionResults() as { prf?: PrfOutputs }).prf;
  if (!outputs || outputs.enabled === false) throw new PasskeyError("no_prf");
  const credentialId = new Uint8Array(credential.rawId);
  const output = prfOutput(credential);
  if (output) return { credentialId, output };
  return evaluate([{ credentialId, salt: options.salt }]);
}
