/**
 * The chats of the tab as a Solid context: one `ChatList` while the keys are
 * unlocked, loaded on every connect and `sync.reset`, and a `Thread` per chat
 * opened in this tab, and the saved messages. Server events go to all of
 * them. The account's chat defaults (the `chat` setting) are read on the
 * same connects.
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
import type { ChatSettings } from "../protocol/generated/protocol";
import { useSocket } from "../transport/context";
import { useVault } from "../vault/context";
import { CHAT_KEY, ChatDefaults, type ChatDefaultsValue } from "./defaults";
import { type ChatKeys, ChatList, type Request } from "./list";
import { SavedMessages } from "./saved";
import { startChat, Thread } from "./thread";
import { OwnTurns } from "./turns";

export interface ChatsContext {
  /** `null` while locked or signed out. */
  list: Accessor<ChatList | null>;
  /** The saved messages; `null` while locked or signed out. */
  saved: Accessor<SavedMessages | null>;
  /** The open chat's messages; one `Thread` per chat for the life of the list. */
  thread: (chatId: string) => Thread | null;
  /** Starts a chat with its first message and settings; resolves to its id. */
  start: (text: string, settings?: ChatSettings) => Promise<string>;
  /** Changes whenever the list or a thread changes: read it to follow them. */
  version: Accessor<number>;
  /** The account's chat defaults (D-091); empty while locked or not read. */
  defaults: Accessor<ChatDefaultsValue>;
  /** Stores new defaults; throws `TransportError` when it cannot. */
  setDefaults: (next: ChatDefaultsValue) => Promise<void>;
  /** The chat of a turn this tab started, waiting up to `ms` to hear of it (D-100). */
  turnChat: (turnId: string, ms: number) => Promise<string | undefined>;
}

const Context = createContext<ChatsContext>();

export function ChatsProvider(props: { children: JSX.Element }): JSX.Element {
  const { socket, state: connection, onEvent } = useSocket();
  const { vault, state: keys } = useVault();
  const [list, setList] = createSignal<ChatList | null>(null);
  const [saved, setSaved] = createSignal<SavedMessages | null>(null);
  const [version, setVersion] = createSignal(0);
  const [store, setStore] = createSignal<ChatDefaults | null>(null);
  const [defaults, setDefaultsValue] = createSignal<ChatDefaultsValue>({});
  const bump = () => setVersion((v) => v + 1);
  const threads = new Map<string, Thread>();
  const turns = new OwnTurns();
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
          setSaved(null);
          setStore(null);
          setDefaultsValue({});
          request = null;
          chatKeys = null;
          return;
        }
        request = async (type, payload, options) => {
          const answer = await s.request(type, payload, options);
          if (type === "message.send" || type === "turn.retry") {
            turns.started((answer as { turn_id: string }).turn_id, (payload as { chat_id: string }).chat_id);
          }
          return answer;
        };
        chatKeys = v;
        const chats = new ChatList(request, v);
        const unsubscribe = chats.subscribe(bump);
        const marks = new SavedMessages(request, v);
        const unmark = marks.subscribe(bump);
        const account = new ChatDefaults({
          request,
          seal: (plaintext) => v.sealSetting(CHAT_KEY, plaintext),
          open: (record) => v.openSetting(CHAT_KEY, record),
        });
        const unfollow = account.subscribe(() => setDefaultsValue(account.value));
        const reset = () => {
          void chats.load();
          void account.load();
          marks.reset();
          for (const thread of threads.values()) thread.reset();
        };
        const unlisten = onEvent((type, payload) => {
          switch (type) {
            case "chat.updated":
              chats.put(payload.chat);
              marks.chatChanged(payload.chat);
              threads.get(payload.chat.chat_id)?.grow(payload.chat.last_message_id, payload.chat.summary_id);
              return;
            case "chat.deleted":
              chats.remove(payload.chat_id);
              marks.chatDeleted(payload.chat_id);
              threads.delete(payload.chat_id);
              return;
            case "message.created":
              threads.get(payload.chat_id)?.receive(payload.message);
              return;
            case "message.updated":
              threads.get(payload.chat_id)?.receive(payload.message);
              marks.messageChanged(payload.chat_id, payload.message);
              return;
            case "message.deleted":
              threads.get(payload.chat_id)?.deleted(payload);
              marks.messageDeleted(payload.chat_id, payload.message_id);
              return;
            case "saved.updated":
              marks.updated(payload);
              return;
            case "message.delta":
              threads.get(payload.chat_id)?.delta(payload);
              return;
            case "chat.titled":
              void chats.retitle(payload.chat_id, payload.title).catch(() => {});
              return;
            case "settings.updated":
              void account.receive(payload);
              return;
            case "sync.reset":
              reset();
              return;
          }
        });
        setList(chats);
        setSaved(marks);
        setStore(account);
        onCleanup(() => {
          unlisten();
          unsubscribe();
          unmark();
          unfollow();
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
        void store()?.load();
        saved()?.reset();
        for (const thread of threads.values()) thread.reset();
      },
    ),
  );

  const thread = (chatId: string) => {
    const chats = list();
    if (!chats || !request || !chatKeys) return null;
    let open = threads.get(chatId);
    if (!open) {
      const info = chats.get(chatId)?.info;
      open = new Thread(chatId, info?.last_message_id ?? 0, request, chatKeys, (title) => {
        void chats.retitle(chatId, title).catch(() => {});
      });
      open.grow(info?.last_message_id ?? 0, info?.summary_id);
      open.subscribe(bump);
      threads.set(chatId, open);
    }
    return open;
  };

  const start = (text: string, settings?: ChatSettings) => {
    if (!request || !chatKeys) return Promise.reject(new Error("locked"));
    return startChat(request, chatKeys, text, settings).then((chatId) => {
      // The device that started the chat asks for its title (docs/protocol.md, "Titles").
      void thread(chatId)
        ?.title()
        .catch(() => {});
      return chatId;
    });
  };

  const setDefaults = (next: ChatDefaultsValue) => store()?.update(next) ?? Promise.reject(new Error("locked"));

  return (
    <Context.Provider
      value={{ list, saved, thread, start, version, defaults, setDefaults, turnChat: (id, ms) => turns.chatOf(id, ms) }}
    >
      {props.children}
    </Context.Provider>
  );
}

export function useChats(): ChatsContext {
  const context = useContext(Context);
  if (!context) throw new Error("useChats outside ChatsProvider");
  return context;
}
