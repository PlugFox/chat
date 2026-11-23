/** A labelled multi-line text input, as `TextField` for longer text (editing a message). */
import { createUniqueId, type JSX, splitProps } from "solid-js";
import styles from "./TextArea.module.css";

export interface TextAreaProps
  extends Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "class" | "style" | "id" | "aria-describedby"> {
  label: string;
}

export function TextArea(props: TextAreaProps): JSX.Element {
  const [own, rest] = splitProps(props, ["label"]);
  const id = createUniqueId();
  return (
    <div class={styles["field"]}>
      <label class={styles["label"]} for={id}>
        {own.label}
      </label>
      <textarea {...rest} id={id} class={styles["input"]} />
    </div>
  );
}
