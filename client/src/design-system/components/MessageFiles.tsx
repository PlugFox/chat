/**
 * The files of a message: images as a grid of square previews, each a
 * button that opens the image, then other files as rows with their icon,
 * name and size, each a button that opens or saves the file. An image
 * whose preview is not open yet shows its placeholder (a ThumbHash) in its
 * place; `alt` is the image's description when there is one.
 */
import { For, type JSX, Show } from "solid-js";
import { FileIcon } from "./FileIcon";
import styles from "./MessageFiles.module.css";
import { VisuallyHidden } from "./VisuallyHidden";

export interface MessageImage {
  id: string;
  /** The square preview (a blob URL), once opened. */
  src?: string | undefined;
  /** A blurred placeholder (a data URL) until then. */
  placeholder?: string | undefined;
  /** What the button does, for screen readers before the image ("Open beach.jpg"). */
  label: string;
  /** What the image shows, read after the label; empty when nothing says. */
  alt: string;
}

export interface MessageFile {
  id: string;
  name: string;
  meta?: string | undefined;
  kind: string;
  extension?: string | undefined;
  /** What the button does ("Save"), for screen readers before the name and size it shows. */
  action: string;
}

export interface MessageFilesProps {
  images: MessageImage[];
  files: MessageFile[];
  onOpen: (id: string) => void;
}

export function MessageFiles(props: MessageFilesProps): JSX.Element {
  return (
    <div class={styles["files"]}>
      <Show when={props.images.length > 0}>
        <ul class={styles["grid"]} data-count={Math.min(props.images.length, 3)}>
          <For each={props.images}>
            {(image) => (
              <li>
                <button type="button" class={styles["tile"]} onClick={() => props.onOpen(image.id)}>
                  <VisuallyHidden>{image.label}</VisuallyHidden>
                  <Show when={image.src ?? image.placeholder}>
                    {(src) => <img class={styles["image"]} src={src()} alt={image.alt} />}
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.files.length > 0}>
        <ul class={styles["rows"]}>
          <For each={props.files}>
            {(file) => (
              <li>
                <button type="button" class={styles["row"]} onClick={() => props.onOpen(file.id)}>
                  <FileIcon kind={file.kind} extension={file.extension} />
                  <span class={styles["text"]}>
                    <VisuallyHidden>{file.action}</VisuallyHidden>
                    <span class={styles["name"]}>{file.name}</span>
                    <Show when={file.meta}>
                      <span class={styles["meta"]}>{file.meta}</span>
                    </Show>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
