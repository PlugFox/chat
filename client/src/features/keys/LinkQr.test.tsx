import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n";
import { type KeysDeps, type KeysState, KeyVault } from "../../vault/keys";
import { VaultGate } from "./VaultGate";

const [vault, setVault] = createSignal<KeyVault | null>(null);
const [state, setState] = createSignal<KeysState | null>(null);
vi.mock("../../vault/context", () => ({ useVault: () => ({ vault, state }) }));

const LINK = "0190d2c4-8b7e-7000-8000-0000000000e1";
let calls: string[] = [];
let posted: Uint8Array | undefined;
let created: Promise<void> = Promise.resolve();

/** A locked account with a recovery wrap; the fake worker opens any link message. */
function keyVault(): KeyVault {
  const wrap = new Uint8Array(17);
  wrap[0] = 2;
  const deps: KeysDeps = {
    userId: "0190d2c4-8b7e-7000-8000-000000000001",
    deviceId: () => "0190d2c4-8b7e-7000-8000-0000000000d1",
    vault: {
      open: async () => undefined,
      call: async (method) => {
        calls.push(method);
        return method === "linkOffer"
          ? { publicKey: new Uint8Array(32), secret: new Uint8Array(32).fill(5) }
          : undefined;
      },
      describe: async () => ({ method: "recovery", wrapId: new Uint8Array(16) }),
      complete: async () => [],
      remember: async () => new Uint8Array(),
      unlockWithDevice: async () => undefined,
      remembered: async () => null,
      forget: async () => undefined,
      close: async () => undefined,
    },
    request: (async (type: string) => {
      calls.push(type);
      if (type === "keys.get") {
        return { keys: { commitment: new Uint8Array(32), wraps: [{ wrap, created_at: 0 }], scopes: [] } };
      }
      if (type === "link.create") {
        await created;
        return { sid: LINK, expires_in_ms: 120_000 };
      }
      if (type === "link.get") return posted ? { message: posted } : {};
      throw new Error(type);
    }) as KeysDeps["request"],
    passkeys: {
      available: async () => false,
      create: () => Promise.reject(new Error("no passkeys")),
      evaluate: () => Promise.reject(new Error("no passkeys")),
    },
    known: { get: () => true, set: () => undefined },
    passkeyName: () => "Vault Chat",
  };
  const keys = new KeyVault(deps);
  keys.subscribe(setState);
  setVault(keys);
  return keys;
}

async function showCode(keys: KeyVault): Promise<void> {
  await keys.load();
  render(() => (
    <I18nProvider locale="en">
      <VaultGate>
        <p>unlocked</p>
      </VaultGate>
    </I18nProvider>
  ));
  fireEvent.click(await screen.findByRole("button", { name: "Show a code" }));
}

afterEach(cleanup);

beforeEach(() => {
  calls = [];
  posted = undefined;
  created = Promise.resolve();
});

it("keeps the code up across a reconnect and collects an answer posted meanwhile", async () => {
  const keys = keyVault();
  await showCode(keys);
  await waitFor(() => expect(calls).toContain("linkOffer"));
  posted = new Uint8Array([1]);
  await keys.load();
  expect(calls).toContain("link.get");
  expect(keys.current.kind).toBe("unlocked");
  await screen.findByText("unlocked");
});

it("leaves nothing behind when the code is hidden while it is being made", async () => {
  let release = () => {};
  created = new Promise((resolve) => {
    release = resolve;
  });
  const keys = keyVault();
  await showCode(keys);
  fireEvent.click(await screen.findByRole("button", { name: "Hide the code" }));
  release();
  await waitFor(() => expect(calls).toContain("linkOffer"));
  // Nothing is pending: a later answer is ignored and no renewal runs.
  await keys.receiveLink(LINK, new Uint8Array([1]));
  expect(keys.current.kind).toBe("locked");
  expect(await keys.pollLink()).toBe(false);
});
