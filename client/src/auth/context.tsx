/**
 * The browser's `AuthClient` as a Solid context: `useAuth().state()` is the
 * sign-in state, `useAuth().client` makes calls.
 */
import { type Accessor, createContext, createSignal, type JSX, onCleanup, onMount, useContext } from "solid-js";
import { useI18n } from "../i18n/i18n";
import { AuthClient, type AuthState, type ChannelLike } from "./client";

const DEVICE_KEY = "chat.device";

/** A random id per browser profile, kept in localStorage; per tab when storage is blocked. */
export function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function browserClient(): AuthClient {
  const channel =
    typeof BroadcastChannel === "undefined" ? undefined : (new BroadcastChannel("chat.auth") as unknown as ChannelLike);
  return new AuthClient({
    fetch: (input, init) => fetch(input, init),
    locks: typeof navigator.locks === "undefined" ? undefined : navigator.locks,
    channel,
    now: Date.now,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    device: () => ({ device_id: deviceId(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
}

export interface Auth {
  client: AuthClient;
  state: Accessor<AuthState>;
}

const AuthContext = createContext<Auth>();

export function AuthProvider(props: { children: JSX.Element }): JSX.Element {
  const { locale } = useI18n();
  const client = browserClient();
  const [state, setState] = createSignal<AuthState>(client.current);
  onCleanup(client.subscribe(setState));
  onMount(() => {
    void client.start().then(() => {
      // Device, timezone and language for this session; failing it costs nothing now.
      if (client.current.kind === "signed_in") client.reportSession(locale()).catch(() => undefined);
    });
  });
  return <AuthContext.Provider value={{ client, state }}>{props.children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth outside AuthProvider");
  return auth;
}
