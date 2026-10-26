/**
 * The chats of the tab as a Solid context: one `ChatList` while the keys are
 * unlocked, loaded on every connect and `sync.reset`, and a `Thread` per chat
 * opened in this tab. Server events go to both.
 */
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  useContext,
} from "solid-js";
import { useSocket } from "../transport/context";
import { useVault } from "../vault/context";
import { type ChatKeys, ChatList, type Request } from "./list";
import { startChat, Thread } from "./thread";

export interface ChatsContext {
  /** `null` while locked or signed out. */
  list: Accessor<ChatList | null>;
  /** The open chat's messages; one `Thread` per chat for the life of the list. */
  thread: (chatId: string) => Thread | null;
  /** Starts a chat with its first message; resolves to its id. */
  start: (text: string) => Promise<string>;
  /** Changes whenever the list or a thread changes: read it to follow them. */
  version: Accessor<number>;
}

const Context = createContext<ChatsContext>();

export function ChatsProvider(props: { children: JSX.Element }): JSX.Element {
  const { socket, state: connection, onEvent } = useSocket();
  const { vault, state: keys } = useVault();
  const [list, setList] = createSignal<ChatList | null>(null);
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  const threads = new Map<string, Thread>();
  let request: Request | null = null;
  let chatKeys: ChatKeys | null = null;
  // Every reconnect stores a new unlocked state: only a lock may drop the chats.
  const unlocked = createMemo(() => keys()?.kind === "unlocked");

  createEffect(
    on(
      () => [socket(), vault(), unlocked()] as const,
      ([s, v, unlocked]) => {
        threads.clear();
        if (!s || !v || !unlocked) {
          setList(null);
          request = null;
          chatKeys = null;
          return;
        }
        request = (type, payload, options) => s.request(type, payload, options);
        chatKeys = v;
        const chats = new ChatList(request, v);
        const unsubscribe = chats.subscribe(bump);
        const reset = () => {
          void chats.load();
          for (const thread of threads.values()) thread.reset();
        };
        const unlisten = onEvent((type, payload) => {
          switch (type) {
            case "chat.updated":
              chats.put(payload.chat);
              threads.get(payload.chat.chat_id)?.grow(payload.chat.last_message_id);
              return;
            case "chat.deleted":
              chats.remove(payload.chat_id);
              threads.delete(payload.chat_id);
              return;
            case "message.created":
            case "message.updated":
              threads.get(payload.chat_id)?.receive(payload.message);
              return;
            case "message.deleted":
              threads.get(payload.chat_id)?.deleted(payload);
              return;
            case "message.delta":
              threads.get(payload.chat_id)?.delta(payload);
              return;
            case "sync.reset":
              reset();
              return;
          }
        });
        setList(chats);
        onCleanup(() => {
          unlisten();
          unsubscribe();
          threads.clear();
        });
      },
    ),
  );

  // Every connect: chunks are trusted for one socket only (D-028).
  createEffect(
    on(
      () => [list(), connection()?.kind === "open"] as const,
      ([chats, open]) => {
        if (!chats || !open) return;
        void chats.load();
        for (const thread of threads.values()) thread.reset();
      },
    ),
  );

  const thread = (chatId: string) => {
    const chats = list();
    if (!chats || !request || !chatKeys) return null;
    let open = threads.get(chatId);
    if (!open) {
      open = new Thread(chatId, chats.get(chatId)?.info.last_message_id ?? 0, request, chatKeys);
      open.subscribe(bump);
      threads.set(chatId, open);
    }
    return open;
  };

  const start = (text: string) => {
    if (!request || !chatKeys) return Promise.reject(new Error("locked"));
    return startChat(request, chatKeys, text);
  };

  return <Context.Provider value={{ list, thread, start, version }}>{props.children}</Context.Provider>;
}

export function useChats(): ChatsContext {
  const context = useContext(Context);
  if (!context) throw new Error("useChats outside ChatsProvider");
  return context;
}
