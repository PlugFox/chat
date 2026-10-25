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
import { Socket, type SocketState } from "./socket";

export interface SocketContext {
  /** The socket while signed in. */
  socket: Accessor<Socket | null>;
  state: Accessor<SocketState | null>;
}

const Context = createContext<SocketContext>();

function url(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}

export function SocketProvider(props: { children: JSX.Element }): JSX.Element {
  const { client, state: auth } = useAuth();
  const [socket, setSocket] = createSignal<Socket | null>(null);
  const [state, setState] = createSignal<SocketState | null>(null);
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
      const s = new Socket({ url: url(), accessToken: (force) => client.accessToken(force), onState: setState });
      setSocket(s);
      onCleanup(() => s.stop());
    }),
  );
  return <Context.Provider value={{ socket, state }}>{props.children}</Context.Provider>;
}

export function useSocket(): SocketContext {
  const context = useContext(Context);
  if (!context) throw new Error("useSocket outside SocketProvider");
  return context;
}
