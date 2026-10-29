/**
 * A message's files (D-101): image previews opened in the crypto worker,
 * their ThumbHash until then, the model's description as alternative text;
 * an image opens whole in the viewer, any other file is fetched, opened and
 * saved.
 */
import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { thumbHashToDataURL } from "thumbhash";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import { ImageViewer, type MessageFile, MessageFiles, type MessageImage } from "../../design-system/components";
import { extension, iconOf } from "../../files/kinds";
import { saveBlob } from "../../files/save";
import { useI18n } from "../../i18n/i18n";
import type { FileRef } from "../../protocol/generated/protocol";
import { formatSize } from "./attachments";
import { requestError } from "./errors";

function placeholder(hash: Uint8Array | undefined): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(hash);
  } catch {
    return undefined;
  }
}

export function ChatMessageFiles(props: { chatId: string; files: FileRef[] }): JSX.Element {
  const { t, locale } = useI18n();
  const chats = useChats();
  const toasts = useToasts();
  const store = () => chats.files(props.chatId);
  const [previews, setPreviews] = createSignal<Record<string, string>>({});
  const [alts, setAlts] = createSignal<Record<string, string>>({});
  const [viewing, setViewing] = createSignal<{ file: FileRef; src?: string; error?: string } | null>(null);

  const images = () => props.files.filter((f) => f.type.startsWith("image/"));
  createEffect(() => {
    const files = store();
    // Follows `file.described`: the description may come after the message.
    chats.version();
    if (!files) return;
    for (const file of images()) {
      if (!previews()[file.id]) {
        void files.preview(file.id).then((src) => {
          if (src) setPreviews((p) => ({ ...p, [file.id]: src }));
        });
      }
      if (!alts()[file.id]) {
        void files.description(file.id).then((text) => {
          if (text) setAlts((a) => ({ ...a, [file.id]: text }));
        });
      }
    }
  });

  const close = () => {
    const shown = viewing()?.src;
    if (shown) URL.revokeObjectURL(shown);
    setViewing(null);
  };
  onCleanup(close);

  const open = (id: string) => {
    const file = props.files.find((f) => f.id === id);
    const files = store();
    if (!file || !files) return;
    if (!file.type.startsWith("image/")) {
      files.open(file.id, file.type).then(
        (blob) => saveBlob(blob, file.name),
        (e: unknown) => toasts.show(t(requestError(e)), "danger"),
      );
      return;
    }
    setViewing({ file });
    files.open(file.id, file.type).then(
      (blob) => {
        if (viewing()?.file.id === file.id) setViewing({ file, src: URL.createObjectURL(blob) });
      },
      (e: unknown) => {
        if (viewing()?.file.id === file.id) setViewing({ file, error: t(requestError(e)) });
      },
    );
  };

  /** Saves what the user sent: the original when the image went as it was. */
  const save = () => {
    const file = viewing()?.file;
    const files = store();
    if (!file || !files) return;
    const original = file.original;
    const name = original ? `${file.name.replace(/\.[^.]+$/, "")}.${original.type.split("/")[1] ?? "bin"}` : file.name;
    const opening = original ? files.open(original.id, original.type) : files.open(file.id, file.type);
    opening.then(
      (blob) => saveBlob(blob, name),
      (e: unknown) => toasts.show(t(requestError(e)), "danger"),
    );
  };

  const shownImages = (): MessageImage[] =>
    images().map((file) => ({
      id: file.id,
      src: previews()[file.id],
      placeholder: placeholder(file.hash),
      label: t("files.open", { name: file.name }),
      alt: alts()[file.id] ?? "",
    }));
  const shownFiles = (): MessageFile[] =>
    props.files
      .filter((f) => !f.type.startsWith("image/"))
      .map((file) => ({
        id: file.id,
        name: file.name,
        meta: formatSize(locale(), file.size),
        kind: iconOf(file.name, file.type),
        extension: extension(file.name),
        action: t("files.saveAction"),
      }));

  return (
    <>
      <MessageFiles images={shownImages()} files={shownFiles()} onOpen={open} />
      <Show when={viewing()}>
        {(shown) => (
          <ImageViewer
            open
            title={shown().file.name}
            src={shown().src}
            alt={alts()[shown().file.id] ?? ""}
            caption={alts()[shown().file.id]}
            error={shown().error}
            loadingLabel={t("files.opening")}
            closeLabel={t("common.close")}
            saveLabel={t(shown().file.original ? "files.saveOriginal" : "files.saveImage")}
            onSave={save}
            onClose={close}
          />
        )}
      </Show>
    </>
  );
}
