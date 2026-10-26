/** A labelled native `<select>`: keyboard, screen readers and mobile pickers for free. */
import { createUniqueId, For, type JSX } from "solid-js";
import { Icon } from "./Icon";
import styles from "./Select.module.css";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
}

export function Select<T extends string>(props: SelectProps<T>): JSX.Element {
  const id = createUniqueId();
  return (
    <div class={styles["field"]}>
      <label class={styles["label"]} for={id}>
        {props.label}
      </label>
      <div class={styles["control"]}>
        <select
          id={id}
          class={styles["select"]}
          value={props.value}
          onChange={(e) => {
            const option = props.options.find((o) => o.value === e.currentTarget.value);
            if (option) props.onChange(option.value);
          }}
        >
          {/* Options recreated with new labels would reset the value: each says whether it is chosen. */}
          <For each={props.options}>
            {(o) => (
              <option value={o.value} selected={o.value === props.value}>
                {o.label}
              </option>
            )}
          </For>
        </select>
        <span class={styles["chevron"]}>
          <Icon name="arrow_drop_down" />
        </span>
      </div>
    </div>
  );
}
