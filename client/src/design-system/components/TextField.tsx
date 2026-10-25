/**
 * A labelled text input with optional hint and error. The label is always
 * visible (no placeholder-as-label); hint and error are tied to the input
 * with `aria-describedby`, and an error sets `aria-invalid`.
 */
import { createUniqueId, type JSX, Show, splitProps } from "solid-js";
import styles from "./TextField.module.css";

export interface TextFieldProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class" | "style" | "id" | "aria-describedby"> {
  label: string;
  hint?: string;
  error?: string;
  /** Monospace input (recovery words, URLs, keys). */
  mono?: boolean;
}

export function TextField(props: TextFieldProps): JSX.Element {
  const [own, rest] = splitProps(props, ["label", "hint", "error", "mono", "type"]);
  const id = createUniqueId();
  const describedBy = () =>
    [own.hint ? `${id}-hint` : "", own.error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div class={styles["field"]}>
      <label class={styles["label"]} for={id}>
        {own.label}
      </label>
      <input
        {...rest}
        id={id}
        type={own.type ?? "text"}
        class={styles["input"]}
        data-mono={own.mono ? "" : undefined}
        aria-invalid={own.error ? "true" : undefined}
        aria-describedby={describedBy()}
      />
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
