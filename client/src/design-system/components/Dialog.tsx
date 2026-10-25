/**
 * A modal dialog on the native `<dialog>` (focus trap, Esc, inert background
 * and top layer for free). `open` drives `showModal()`/`close()`; Esc and the
 * close button call `onClose`. Focus moves to the title on open.
 */
import { createEffect, createUniqueId, type JSX, on, Show } from "solid-js";
import styles from "./Dialog.module.css";
import { Heading } from "./Heading";
import { IconButton } from "./IconButton";

export interface DialogProps {
  open: boolean;
  title: string;
  /** Label of the close button. */
  closeLabel: string;
  onClose: () => void;
  /** Buttons at the bottom, primary action last. */
  actions?: JSX.Element;
  children: JSX.Element;
}

export function Dialog(props: DialogProps): JSX.Element {
  let dialog: HTMLDialogElement | undefined;
  const titleId = createUniqueId();
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!dialog) return;
        if (open && !dialog.open) {
          dialog.showModal();
          document.getElementById(titleId)?.focus();
        } else if (!open && dialog.open) {
          dialog.close();
        }
      },
    ),
  );
  return (
    <dialog
      ref={dialog}
      class={styles["dialog"]}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div class={styles["header"]}>
        <Heading level={2} size="title-lg" id={titleId} focusable>
          {props.title}
        </Heading>
        <IconButton icon="close" label={props.closeLabel} onClick={() => props.onClose()} />
      </div>
      <div class={styles["body"]}>{props.children}</div>
      <Show when={props.actions}>
        <div class={styles["actions"]}>{props.actions}</div>
      </Show>
    </dialog>
  );
}
