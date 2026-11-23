/**
 * A file's type at a glance: a tile from the atlas of file kinds (PDF,
 * image, table, data, code, text, any other file) with its extension under
 * the symbol. Decorative: the file's name beside it says what it is.
 */
import type { JSX } from "solid-js";
import styles from "./FileIcon.module.css";
import { Icon } from "./Icon";

/** The kinds of the atlas; `kind` falls back to `file`. */
const SYMBOLS: Record<string, string> = {
  pdf: "picture_as_pdf",
  image: "image",
  table: "table_chart",
  data: "data_object",
  code: "code",
  text: "description",
  file: "draft",
};

export interface FileIconProps {
  /** `pdf`, `image`, `table`, `data`, `code`, `text` or `file`. */
  kind: string;
  /** The extension shown under the symbol, at most a few letters. */
  extension?: string | undefined;
  size?: "md" | "lg";
}

export function FileIcon(props: FileIconProps): JSX.Element {
  const kind = () => (props.kind in SYMBOLS ? props.kind : "file");
  return (
    <span class={styles["tile"]} data-kind={kind()} data-size={props.size ?? "md"} aria-hidden="true">
      <Icon name={SYMBOLS[kind()] ?? "draft"} size={props.size === "lg" ? "lg" : "md"} />
      <span class={styles["extension"]}>{(props.extension ?? "").slice(0, 4).toUpperCase()}</span>
    </span>
  );
}
