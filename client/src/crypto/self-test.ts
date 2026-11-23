/**
 * A round trip through the real worker and WASM: setup, a scope, seal, open,
 * lock. Used by the UI kit (and so by the e2e suite under the production CSP).
 */
import { VaultClient } from "./vault";

function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function cryptoSelfTest(): Promise<void> {
  const vault = new VaultClient();
  try {
    await vault.open(random(16));
    const setup = (await vault.call("setup", random(16))) as { recoveryWords: string };
    if (setup.recoveryWords.split(" ").length !== 12) throw new Error("recovery key is not 12 words");
    const scope = random(16);
    await vault.call("createScope", scope);
    const kind = { kind: "chat.message", messageId: 1, author: "user" };
    const plaintext = new TextEncoder().encode("Привет, vault");
    const sealed = await vault.call("seal", scope, 1, kind, plaintext);
    const opened = (await vault.call("open", scope, kind, sealed)) as { plaintext: Uint8Array; origin: string };
    if (new TextDecoder().decode(opened.plaintext) !== "Привет, vault" || opened.origin !== "client") {
      throw new Error("round trip mismatch");
    }
    const elsewhere = { kind: "chat.message", messageId: 2, author: "user" };
    const moved = await vault.call("open", scope, elsewhere, sealed).then(
      () => true,
      () => false,
    );
    if (moved) throw new Error("a record opened at another message id");
  } finally {
    await vault.close();
  }
}
