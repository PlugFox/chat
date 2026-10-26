/**
 * The chats screen (`/`, `/chats/new`, `/chats/:id`): the list beside the
 * open chat on large screens, one of them on smaller ones. `?message=<id>`
 * opens a chat at that message (a saved one).
 */
import { useParams, useSearchParams } from "@solidjs/router";
import { type JSX, Show } from "solid-js";
import { ChatLayout } from "../../design-system/components";
import { ChatListPane } from "./ChatListPane";
import { ChatView } from "./ChatView";
import { NewChat } from "./NewChat";

export default function ChatsPage(): JSX.Element {
  const params = useParams<{ id?: string }>();
  const [search] = useSearchParams<{ message?: string }>();
  const target = () => {
    const id = Number(search.message);
    return Number.isInteger(id) && id >= 0 ? id : undefined;
  };
  const open = () => (params.id && params.id !== "new" ? params.id : undefined);
  return (
    <ChatLayout
      showing={params.id ? "detail" : "list"}
      list={<ChatListPane current={open()} />}
      detail={
        <Show when={open()} keyed fallback={<NewChat />}>
          {(chatId) => <ChatView chatId={chatId} target={target()} />}
        </Show>
      }
    />
  );
}
