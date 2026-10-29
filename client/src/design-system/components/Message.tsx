/**
 * One message of a chat: the author named for screen readers, the text as
 * written (line breaks kept, D-092) or as rich content, after the tool calls
 * of its turn (each a line with an icon), then a status (a streaming indicator,
 * an error with its action), a muted meta line with a mark when the message
 * is saved, and the message's actions.
 * The user's messages sit at the end of the line, everything else at the
 * start. A summary is a card across the line whose text folds under its
 * label. A placeholder holds the place of a message not loaded yet.
 */
import { For, type JSX, Show } from "solid-js";
import { Icon } from "./Icon";
import styles from "./Message.module.css";
import { VisuallyHidden } from "./VisuallyHidden";

export interface MessageProps {
  author: "user" | "other" | "summary";
  /** On a summary: what the card is, shown with its text folded under it. */
  label?: string | undefined;
  /** Who wrote it, for screen readers ("You", "Assistant"). */
  authorLabel: string;
  /** The text; absent while loading or when the status says why there is none. */
  text?: string | undefined;
  /** The text as rich content (`RichText`), shown in its place. */
  content?: JSX.Element;
  /** The reply is still being written; `streamingLabel` names it. */
  streaming?: boolean;
  streamingLabel?: string;
  /** The turn's tool calls, before the text: what the agent read and how the request ended. */
  tools?: { icon: string; text: string }[] | undefined;
  /** Names the list of tool calls for screen readers ("Data the agent asked for"). */
  toolsLabel?: string | undefined;
  /** Muted text in place of the content, such as "Deleted". */
  note?: string | undefined;
  /** Shown under the text: an error banner and its retry. */
  status?: JSX.Element;
  meta?: string | undefined;
  /** The message is saved; names the mark for screen readers ("Saved"). */
  saved?: string | undefined;
  actions?: JSX.Element;
  /** The message a link opened the chat at: marked until the chat closes. */
  target?: boolean;
  /** Not loaded yet: a block of the usual height, no content. */
  placeholder?: boolean;
}

export function Message(props: MessageProps): JSX.Element {
  return (
    <article
      class={styles["message"]}
      data-author={props.author}
      data-placeholder={props.placeholder ? "" : undefined}
      data-target={props.target ? "" : undefined}
    >
      <VisuallyHidden>{props.authorLabel}</VisuallyHidden>
      <div class={styles["bubble"]}>
        <Show when={props.label}>
          {(label) => (
            <Show when={props.text} fallback={<p class={styles["label"]}>{label()}</p>}>
              <details class={styles["fold"]}>
                <summary class={styles["label"]}>
                  {label()}
                  <span class={styles["marker"]}>
                    <Icon name="arrow_drop_down" size="sm" />
                  </span>
                </summary>
                <Show when={props.content} fallback={<p class={styles["text"]}>{props.text}</p>}>
                  {props.content}
                </Show>
              </details>
            </Show>
          )}
        </Show>
        <Show when={props.tools?.length}>
          <ul class={styles["tools"]} aria-label={props.toolsLabel}>
            <For each={props.tools}>
              {(tool) => (
                <li class={styles["tool"]}>
                  <Icon name={tool.icon} size="sm" />
                  <span>{tool.text}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={!props.label && props.text}>
          <Show when={props.content} fallback={<p class={styles["text"]}>{props.text}</p>}>
            {props.content}
          </Show>
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
      <Show when={props.meta || props.actions || props.saved}>
        <div class={styles["footer"]}>
          <Show when={props.saved}>
            {(label) => (
              <span class={styles["mark"]}>
                <Icon name="bookmark_added" size="sm" label={label()} />
              </span>
            )}
          </Show>
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
