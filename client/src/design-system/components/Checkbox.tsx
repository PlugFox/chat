/**
 * A native checkbox with a visible label and an optional hint tied by
 * `aria-describedby`. The input itself is transparent and covers the whole
 * row, so the target is the full width and at least 48px tall; the box next
 * to the label is drawn.
 */
import { createUniqueId, type JSX, Show } from "solid-js";
import styles from "./Checkbox.module.css";
import { Icon } from "./Icon";

export interface CheckboxProps {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  const id = createUniqueId();
  return (
    <div class={styles["field"]}>
      <label class={styles["row"]} for={id}>
        <input
          id={id}
          type="checkbox"
          class={styles["input"]}
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={props.hint ? `${id}-hint` : undefined}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span class={styles["box"]} aria-hidden="true">
          <Icon name="check" size="sm" />
        </span>
        <span class={styles["label"]}>{props.label}</span>
      </label>
      <Show when={props.hint}>
        <p id={`${id}-hint`} class={styles["hint"]}>
          {props.hint}
        </p>
      </Show>
    </div>
  );
}
