/**
 * A labelled text input with optional hint and error. The label is always
 * visible (no placeholder-as-label); hint and error are tied to the input
 * with `aria-describedby`, and an error sets `aria-invalid`. Suggestions are
 * buttons under the input rather than a listbox popup: they work the same
 * with touch, keyboard and screen readers, and picking one keeps the focus
 * (and a phone's keyboard) in the input.
 */
import { createUniqueId, For, type JSX, Show, splitProps } from "solid-js";
import { Button } from "./Button";
import styles from "./TextField.module.css";

export interface TextFieldProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class" | "style" | "id" | "aria-describedby"> {
  label: string;
  hint?: string;
  error?: string;
  /** Monospace input (recovery words, URLs, keys). */
  mono?: boolean;
  /** Completions for what is being typed; the list is named by `suggestionsLabel`. */
  suggestions?: string[];
  suggestionsLabel?: string;
  onSuggestion?: (value: string) => void;
}

export function TextField(props: TextFieldProps): JSX.Element {
  const [own, rest] = splitProps(props, [
    "label",
    "hint",
    "error",
    "mono",
    "type",
    "suggestions",
    "suggestionsLabel",
    "onSuggestion",
  ]);
  const id = createUniqueId();
  let input: HTMLInputElement | undefined;
  const describedBy = () =>
    [own.hint ? `${id}-hint` : "", own.error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div class={styles["field"]}>
      <label class={styles["label"]} for={id}>
        {own.label}
      </label>
      <input
        {...rest}
        ref={input}
        id={id}
        type={own.type ?? "text"}
        class={styles["input"]}
        data-mono={own.mono ? "" : undefined}
        aria-invalid={own.error ? "true" : undefined}
        aria-describedby={describedBy()}
      />
      <Show when={own.suggestions?.length}>
        <ul class={styles["suggestions"]} aria-label={own.suggestionsLabel}>
          <For each={own.suggestions}>
            {(value) => (
              <li>
                <Button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    own.onSuggestion?.(value);
                    input?.focus();
                  }}
                >
                  {value}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={own.hint}>
        <p id={`${id}-hint`} class={styles["hint"]}>
          {own.hint}
        </p>
      </Show>
      <Show when={own.error}>
        <p id={`${id}-error`} class={styles["error"]}>
          {own.error}
        </p>
      </Show>
    </div>
  );
}
