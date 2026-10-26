/**
 * One message of a chat: the author named for screen readers, the text as
 * written (line breaks kept, D-092), then a status (a streaming indicator,
 * an error with its action), a muted meta line and the message's actions.
 * The user's messages sit at the end of the line, everything else at the
 * start. A placeholder holds the place of a message not loaded yet.
 */
import { type JSX, Show } from "solid-js";
import styles from "./Message.module.css";
import { VisuallyHidden } from "./VisuallyHidden";

export interface MessageProps {
  author: "user" | "other";
  /** Who wrote it, for screen readers ("You", "Assistant"). */
  authorLabel: string;
  /** The text; absent while loading or when the status says why there is none. */
  text?: string | undefined;
  /** The reply is still being written; `streamingLabel` names it. */
  streaming?: boolean;
  streamingLabel?: string;
  /** Muted text in place of the content, such as "Deleted". */
  note?: string | undefined;
  /** Shown under the text: an error banner and its retry. */
  status?: JSX.Element;
  meta?: string | undefined;
  actions?: JSX.Element;
  /** Not loaded yet: a block of the usual height, no content. */
  placeholder?: boolean;
}

export function Message(props: MessageProps): JSX.Element {
  return (
    <article class={styles["message"]} data-author={props.author} data-placeholder={props.placeholder ? "" : undefined}>
      <VisuallyHidden>{props.authorLabel}</VisuallyHidden>
      <div class={styles["bubble"]}>
        <Show when={props.text}>
          <p class={styles["text"]}>{props.text}</p>
        </Show>
        <Show when={props.note}>
          <p class={styles["note"]}>{props.note}</p>
        </Show>
        <Show when={props.streaming}>
          <span class={styles["streaming"]} role="img" aria-label={props.streamingLabel}>
            <span />
            <span />
            <span />
          </span>
        </Show>
        <Show when={props.status}>{props.status}</Show>
      </div>
      <Show when={props.meta || props.actions}>
        <div class={styles["footer"]}>
          <Show when={props.meta}>
            <span class={styles["meta"]}>{props.meta}</span>
          </Show>
          <Show when={props.actions}>
            <div class={styles["actions"]}>{props.actions}</div>
          </Show>
        </div>
      </Show>
    </article>
  );
}
