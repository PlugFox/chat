/**
 * The WebSocket of the signed-in user as a Solid context: one `Socket` per
 * sign-in, stopped at sign-out. `useSocket().state()` follows the connection.
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
import { useAuth } from "../auth/context";
import type { Events } from "../protocol/generated/protocol";
import { type EventType, Socket, type SocketState } from "./socket";

/** A server event as `(type, payload)`; checking `type` narrows `payload`. */
type Listener = (...event: { [K in EventType]: [type: K, payload: Events[K]] }[EventType]) => void;

export interface SocketContext {
  /** The socket while signed in. */
  socket: Accessor<Socket | null>;
  state: Accessor<SocketState | null>;
  /** Server events of the signed-in user's socket; returns the unsubscribe. */
  onEvent: (listener: Listener) => () => void;
}

const Context = createContext<SocketContext>();

function url(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}

export function SocketProvider(props: { children: JSX.Element }): JSX.Element {
  const { client, state: auth } = useAuth();
  const [socket, setSocket] = createSignal<Socket | null>(null);
  const [state, setState] = createSignal<SocketState | null>(null);
  const listeners = new Set<Listener>();
  const onEvent = (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const userId = () => {
    const s = auth();
    return s.kind === "signed_in" ? s.userId : null;
  };
  createEffect(
    on(userId, (user) => {
      if (!user) {
        setSocket(null);
        setState(null);
        return;
      }
      const s = new Socket({
        url: url(),
        accessToken: (force) => client.accessToken(force),
        onState: setState,
        onEvent: (type, payload) => {
          const event = [type, payload] as Parameters<Listener>;
          for (const listener of listeners) listener(...event);
        },
      });
      setSocket(s);
      onCleanup(() => s.stop());
    }),
  );
  return <Context.Provider value={{ socket, state, onEvent }}>{props.children}</Context.Provider>;
}

export function useSocket(): SocketContext {
  const context = useContext(Context);
  if (!context) throw new Error("useSocket outside SocketProvider");
  return context;
}
