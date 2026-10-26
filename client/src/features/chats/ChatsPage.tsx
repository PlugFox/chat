/**
 * The chats screen (`/`, `/chats/new`, `/chats/:id`): the list beside the
 * open chat on large screens, one of them on smaller ones.
 */
import { useParams } from "@solidjs/router";
import { type JSX, Show } from "solid-js";
import { ChatLayout } from "../../design-system/components";
import { ChatListPane } from "./ChatListPane";
import { ChatView } from "./ChatView";
import { NewChat } from "./NewChat";

export default function ChatsPage(): JSX.Element {
  const params = useParams<{ id?: string }>();
  const open = () => (params.id && params.id !== "new" ? params.id : undefined);
  return (
    <ChatLayout
      showing={params.id ? "detail" : "list"}
      list={<ChatListPane current={open()} />}
      detail={
        <Show when={open()} keyed fallback={<NewChat />}>
          {(chatId) => <ChatView chatId={chatId} />}
        </Show>
      }
    />
  );
}
