/**
 * The signed-in user's `KeyVault` as a Solid context. One per sign-in and
 * tab (D-019): it opens its crypto worker on sign-in, loads the keys whenever
 * the socket connects, and wipes them at sign-out.
 */
import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  useContext,
} from "solid-js";
import { deviceId, useAuth } from "../auth/context";
import { VaultClient } from "../crypto/vault";
import { useI18n } from "../i18n/i18n";
import { useSocket } from "../transport/context";
import { type KeysState, KeyVault } from "./keys";
import * as passkeys from "./passkey";

export interface Vault {
  vault: Accessor<KeyVault | null>;
  /** `null` while signed out. */
  state: Accessor<KeysState | null>;
}

const Context = createContext<Vault>();

/** Set once this browser has unlocked the account; see `KeysState.new`. */
function knownKey(userId: string): string {
  return `chat.keys.${userId}`;
}

function storage(userId: string): { get: () => boolean; set: () => void } {
  return {
    get: () => {
      try {
        return localStorage.getItem(knownKey(userId)) === "1";
      } catch {
        return false;
      }
    },
    set: () => {
      try {
        localStorage.setItem(knownKey(userId), "1");
      } catch {
        // Without storage the warning is simply never shown.
      }
    },
  };
}

export function VaultProvider(props: { children: JSX.Element }): JSX.Element {
  const { state: auth } = useAuth();
  const { socket, state: connection, onEvent } = useSocket();
  const { t } = useI18n();
  const [vault, setVault] = createSignal<KeyVault | null>(null);
  const [state, setState] = createSignal<KeysState | null>(null);

  createEffect(
    on(socket, (s) => {
      const signedIn = auth();
      if (!s || signedIn.kind !== "signed_in") {
        setVault(null);
        setState(null);
        return;
      }
      const client = new VaultClient();
      const keys = new KeyVault({
        userId: signedIn.userId,
        deviceId,
        vault: {
          open: (userId) => client.open(userId),
          call: (method, ...args) => (client.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args),
          describe: (wrap) => client.describe(wrap),
          complete: (prefix) => client.complete(prefix),
          remember: (wrapId, device) => client.remember(wrapId, device),
          unlockWithDevice: (wrap, commitment) => client.unlockWithDevice(wrap, commitment),
          remembered: () => client.remembered(),
          forget: () => client.forget(),
          close: () => client.close(),
        },
        request: (type, payload, options) => s.request(type, payload, options),
        passkeys: { available: passkeys.prfAvailable, create: passkeys.create, evaluate: passkeys.evaluate },
        known: storage(signedIn.userId),
        passkeyName: () => t("keys.passkey.name"),
      });
      setState(keys.current);
      const unsubscribe = keys.subscribe(setState);
      const unlisten = onEvent((type, payload) => {
        if (type === "link.message") void keys.receiveLink(payload.sid, payload.message);
      });
      setVault(keys);
      onCleanup(() => {
        unlisten();
        unsubscribe();
        void keys.close();
      });
    }),
  );

  // Every connect: the server is the source of truth, and a reconnect may follow a revocation.
  createEffect(
    on(
      () => [vault(), connection()?.kind === "open"] as const,
      ([keys, open]) => {
        if (keys && open) void keys.load();
      },
    ),
  );

  return <Context.Provider value={{ vault, state }}>{props.children}</Context.Provider>;
}

export function useVault(): Vault {
  const context = useContext(Context);
  if (!context) throw new Error("useVault outside VaultProvider");
  return context;
}
