/**
 * An image of a message on the whole screen, on the native `<dialog>`
 * (Esc closes it, focus stays inside): the image fitted to the screen, its
 * name and description under it, and buttons that save it and close. While
 * the image opens it says so; one that does not open shows why.
 */
import { createEffect, createUniqueId, type JSX, on, Show } from "solid-js";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import styles from "./ImageViewer.module.css";

export interface ImageViewerProps {
  open: boolean;
  /** The file's name, the dialog's title. */
  title: string;
  /** The opened image (a blob URL); absent while it opens. */
  src?: string | undefined;
  alt: string;
  /** What the model wrote about the image, under it. */
  caption?: string | undefined;
  /** Shown instead of the image when it does not open. */
  error?: string | undefined;
  loadingLabel: string;
  closeLabel: string;
  saveLabel: string;
  onSave: () => void;
  onClose: () => void;
}

export function ImageViewer(props: ImageViewerProps): JSX.Element {
  let dialog: HTMLDialogElement | undefined;
  const titleId = createUniqueId();
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        else if (!open && dialog.open) dialog.close();
      },
    ),
  );
  return (
    <dialog
      ref={dialog}
      class={styles["viewer"]}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div class={styles["stage"]}>
        <Show
          when={props.error}
          fallback={
            <Show
              when={props.src}
              fallback={
                <p class={styles["status"]} role="status">
                  <span class={styles["spinner"]}>
                    <Icon name="progress_activity" />
                  </span>
                  {props.loadingLabel}
                </p>
              }
            >
              {(src) => <img class={styles["image"]} src={src()} alt={props.alt} />}
            </Show>
          }
        >
          {(error) => (
            <p class={styles["status"]} role="alert">
              {error()}
            </p>
          )}
        </Show>
      </div>
      <div class={styles["bar"]}>
        <div class={styles["text"]}>
          <h2 id={titleId} class={styles["title"]}>
            {props.title}
          </h2>
          <Show when={props.caption}>
            <p class={styles["caption"]}>{props.caption}</p>
          </Show>
        </div>
        <Button icon="download" disabled={!props.src} onClick={() => props.onSave()}>
          {props.saveLabel}
        </Button>
        <IconButton icon="close" label={props.closeLabel} onClick={() => props.onClose()} />
      </div>
    </dialog>
  );
}
