/**
 * A modal dialog on the native `<dialog>` (focus trap, Esc, inert background
 * and top layer for free). `open` drives `showModal()`/`close()`; Esc, the
 * close button and a click on the barrier call `onClose`. Focus moves to the
 * title on open.
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
  /** The barrier does nothing: a stray tap would lose typed work or answer for the user. */
  persistent?: boolean;
  /** Buttons at the bottom, primary action last. */
  actions?: JSX.Element;
  children: JSX.Element;
}

export function Dialog(props: DialogProps): JSX.Element {
  let dialog: HTMLDialogElement | undefined;
  const titleId = createUniqueId();
  // The surface covers the dialog's box, so only the barrier targets the dialog itself. A press must
  // start there too: a text selection dragged out of a field ends in a click on the dialog.
  let pressedBarrier = false;
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: the barrier is a pointer's way to do what Esc does through `onCancel`.
    <dialog
      ref={dialog}
      class={styles["dialog"]}
      aria-labelledby={titleId}
      onPointerDown={(e) => {
        pressedBarrier = e.target === dialog;
      }}
      onClick={(e) => {
        if (pressedBarrier && e.target === dialog && !props.persistent) props.onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div class={styles["surface"]}>
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
      </div>
    </dialog>
  );
}
