/**
 * Where a message is written: a card with a growing text area over a row of
 * controls, and one button in it that sends, or stops the reply while one is running. Enter sends, Shift+Enter starts a
 * new line (and so does Enter while an input method is composing). The label
 * is the text area's accessible name (no visible label: the placeholder and the
 * place say what it is); the hint, if any, is tied to it. `options`, if
 * given, is a button beside the attach button that names the chat's settings in
 * short (the model, the effort) and opens them. `attach`, if given, is a
 * button that opens the file chooser; the files picked show in
 * `attachments` above the text area, and a message of files alone sends. The
 * chooser's input stays mounted once there was one, as `attach` goes away with
 * the connection: a phone's camera can outlast the socket, and the photo comes
 * back to the input that opened it.
 */
import { createMemo, createUniqueId, type JSX, Show } from "solid-js";
import styles from "./Composer.module.css";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

export interface ComposerOptions {
  /** What the button shows, cut with an ellipsis when it does not fit. */
  summary: string;
  /** The button's accessible name; the summary follows it. */
  label: string;
  onOpen: () => void;
}

export interface ComposerAttach {
  /** The button's accessible name. */
  label: string;
  /** What the file chooser offers (`accept`). */
  accept: string;
  onPick: (files: File[]) => void;
}

export interface ComposerProps {
  label: string;
  placeholder?: string;
  value: string;
  onInput: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  /** A reply is being written: the button stops it. */
  running?: boolean;
  /** Nothing can be sent right now (the hint says why). */
  disabled?: boolean;
  hint?: string | undefined;
  options?: ComposerOptions | undefined;
  attach?: ComposerAttach | undefined;
  /** The files of the message being written (`Attachments`). */
  attachments?: JSX.Element;
  /** There are files to send: the message sends without text. */
  hasAttachments?: boolean;
  sendLabel: string;
  stopLabel: string;
}

export function Composer(props: ComposerProps): JSX.Element {
  const id = createUniqueId();
  let picker: HTMLInputElement | undefined;
  const chooser = createMemo<ComposerAttach | undefined>((last) => props.attach ?? last);
  const canSend = () => !props.disabled && !props.running && (props.value.trim() !== "" || !!props.hasAttachments);
  const send = () => {
    if (canSend()) props.onSend();
  };
  return (
    <form
      class={styles["composer"]}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Show when={props.attachments}>{props.attachments}</Show>
      <textarea
        id={id}
        aria-label={props.label}
        class={styles["input"]}
        rows={1}
        value={props.value}
        placeholder={props.placeholder}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Show when={props.hint}>
        <p id={`${id}-hint`} class={styles["hint"]}>
          {props.hint}
        </p>
      </Show>
      <div class={styles["controls"]}>
        <input
          ref={picker}
          class={styles["picker"]}
          type="file"
          multiple
          accept={chooser()?.accept}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            if (files.length > 0) chooser()?.onPick(files);
          }}
        />
        <Show when={props.attach}>
          {(attach) => (
            <IconButton icon="add" label={attach().label} disabled={props.disabled} onClick={() => picker?.click()} />
          )}
        </Show>
        <Show when={props.options}>
          {(options) => (
            <button
              type="button"
              class={styles["options"]}
              title={options().summary}
              aria-label={`${options().label}: ${options().summary}`}
              onClick={() => options().onOpen()}
            >
              <span class={styles["summary"]}>{options().summary}</span>
              <Icon name="arrow_drop_down" size="xs" />
            </button>
          )}
        </Show>
        <div class={styles["send"]}>
          <Show
            when={props.running && props.onStop}
            fallback={
              <IconButton
                type="submit"
                icon="arrow_upward"
                label={props.sendLabel}
                variant="primary"
                disabled={!canSend()}
              />
            }
          >
            <IconButton
              icon="stop_circle"
              label={props.stopLabel}
              variant="secondary"
              onClick={() => props.onStop?.()}
            />
          </Show>
        </div>
      </div>
    </form>
  );
}
