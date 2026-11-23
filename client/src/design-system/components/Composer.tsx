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
 * back to the input that opened it. `meter`, if given, is a short gauge of how
 * full something is that opens more about it. `suggestions`, if any, stand in
 * a list above the text area, which controls it: arrows move, Enter
 * or Tab takes one, Esc leaves the text to be sent as it is.
 */
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, on, Show } from "solid-js";
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

export interface ComposerMeter {
  /** The amount, short (`12k`). */
  text: string;
  /** The button's accessible name and tooltip, in full. */
  label: string;
  /** How full, 0 to 1, when there is a limit to measure against. */
  share?: number | undefined;
  onOpen: () => void;
}

export interface ComposerSuggestion {
  id: string;
  /** What is typed (`/compact`). */
  label: string;
  description: string;
}

/** Past this share the gauge asks for attention. */
const METER_HIGH = 0.8;

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
  meter?: ComposerMeter | undefined;
  suggestions?: ComposerSuggestion[] | undefined;
  /** The name of the suggestions' list. */
  suggestionsLabel?: string;
  onSuggestion?: (id: string) => void;
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
  const [dismissed, setDismissed] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const shown = () => (dismissed() ? [] : (props.suggestions ?? []));
  const active = () => Math.min(activeIndex(), shown().length - 1);
  createEffect(
    on(
      () => props.value,
      () => {
        setDismissed(false);
        setActiveIndex(0);
      },
      { defer: true },
    ),
  );
  /** Only while the list is up. A `textarea` may not take the combobox role, and needs none for these. */
  const combobox = () =>
    shown().length > 0
      ? ({
          "aria-controls": `${id}-list`,
          "aria-autocomplete": "list",
          "aria-activedescendant": `${id}-${shown()[active()]?.id}`,
        } as const)
      : {};
  const take = (suggestion: ComposerSuggestion | undefined) => {
    if (suggestion) props.onSuggestion?.(suggestion.id);
  };
  /** Moves in the list or takes from it; whether the key was its. */
  const suggestionKey = (e: KeyboardEvent): boolean => {
    const count = shown().length;
    if (count === 0 || e.isComposing) return false;
    if (e.key === "ArrowDown") setActiveIndex((active() + 1) % count);
    else if (e.key === "ArrowUp") setActiveIndex((active() - 1 + count) % count);
    else if (e.key === "Escape") setDismissed(true);
    else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") take(shown()[active()]);
    else return false;
    e.preventDefault();
    return true;
  };
  return (
    <form
      class={styles["composer"]}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Show when={shown().length > 0}>
        <div id={`${id}-list`} class={styles["suggestions"]} role="listbox" aria-label={props.suggestionsLabel}>
          <For each={shown()}>
            {(item, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: the text area keeps the focus and its keys drive the list.
              // biome-ignore lint/a11y/useKeyWithClickEvents: same.
              <div
                id={`${id}-${item.id}`}
                class={styles["suggestion"]}
                role="option"
                aria-selected={index() === active()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => take(item)}
              >
                <span class={styles["suggestion-label"]}>{item.label}</span>
                <span class={styles["suggestion-text"]}>{item.description}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.attachments}>{props.attachments}</Show>
      <textarea
        id={id}
        aria-label={props.label}
        {...combobox()}
        class={styles["input"]}
        rows={1}
        value={props.value}
        placeholder={props.placeholder}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (suggestionKey(e)) return;
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
        <Show when={props.meter}>
          {(meter) => (
            <button
              type="button"
              class={styles["options"]}
              data-meter
              data-high={(meter().share ?? 0) >= METER_HIGH ? "" : undefined}
              title={meter().label}
              aria-label={meter().label}
              onClick={() => meter().onOpen()}
            >
              <Show when={meter().share !== undefined}>
                <svg class={styles["ring"]} viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="8" pathLength="1" class={styles["ring-track"]} />
                  <circle
                    cx="10"
                    cy="10"
                    r="8"
                    pathLength="1"
                    class={styles["ring-value"]}
                    stroke-dasharray={`${Math.min(meter().share ?? 0, 1)} 1`}
                  />
                </svg>
              </Show>
              <span>{meter().text}</span>
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
