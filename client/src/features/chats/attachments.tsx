/**
 * The files of a message being written (D-101): picked through the
 * composer, checked, refused with a toast when no agent takes them, each
 * prepared in the media worker one at a time, shown in the
 * composer until the message is sent. A file is not kept unless the user asks
 * in its settings (D-107): a chat is not a gallery. Only a kept big image can
 * also go as it is.
 */
import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import { useToasts } from "../../app/toasts";
import { type AttachmentItem, Attachments, Checkbox, Dialog, Stack } from "../../design-system/components";
import { type Attachment, check, type Picked, prepare, type Refusal } from "../../files/attach";
import { ACCEPT, extension, FILES_PER_MESSAGE, iconOf } from "../../files/kinds";
import { MediaClient } from "../../files/media";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages/en";

const refusals: Record<Refusal, MessageKey> = {
  unsupported: "files.refused.unsupported",
  too_large: "files.refused.tooLarge",
  too_many_pixels: "files.refused.pixels",
  too_many_pages: "files.refused.pages",
  not_text: "files.refused.notText",
  unreadable: "files.refused.unreadable",
};

/** One media worker for the tab: started at the first image. */
let media: MediaClient | null = null;

/** A picked file in the composer: still being prepared, or ready to send. */
interface Item {
  key: string;
  name: string;
  kind: string;
  extension: string;
  size: number;
  /** The blob URL of an image's preview, freed when the item goes. */
  preview?: string;
  attachment?: Attachment;
  picked: Picked & { ok: true };
  /** Stays after the reply (D-107). */
  keep: boolean;
}

export function formatSize(locale: string, bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    // "20 B", not "20 byte".
    unitDisplay: unit === 0 ? "narrow" : "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

export interface ComposerFiles {
  /** The composer's `attach`, or nothing when the server takes no files. */
  attach: () => { label: string; accept: string; onPick: (files: File[]) => void } | undefined;
  /** The composer's `attachments`. */
  tray: () => JSX.Element;
  /** A file's settings, to render beside the composer. */
  dialog: () => JSX.Element;
  has: () => boolean;
  /** Some file is still being prepared: nothing can be sent yet. */
  busy: () => boolean;
  /** The files ready to send, in the order picked. */
  ready: () => Attachment[];
  clear: () => void;
}

/**
 * `sending`: the message is on its way, so its files stay as they are.
 */
export function useComposerFiles(enabled: () => boolean, sending: () => boolean): ComposerFiles {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const [items, setItems] = createSignal<Item[]>([]);
  const [setting, setSetting] = createSignal<string | null>(null);
  /** Files picked and still being checked, which take their places already. */
  let checking = 0;
  let disposed = false;

  const free = (item: Item) => {
    if (item.preview) URL.revokeObjectURL(item.preview);
  };
  onCleanup(() => {
    disposed = true;
    for (const item of items()) free(item);
  });

  const add = (picked: Picked & { ok: true }) => {
    const key = crypto.randomUUID();
    const item: Item = {
      key,
      name: picked.file.name,
      kind: iconOf(picked.file.name, picked.type),
      extension: extension(picked.file.name),
      size: picked.file.size,
      picked,
      keep: false,
    };
    setItems((list) => [...list, item]);
    media ??= new MediaClient();
    prepare(picked, false, media).then(
      (attachment) => {
        const preview = attachment.preview
          ? URL.createObjectURL(new Blob([new Uint8Array(attachment.preview)], { type: "image/jpeg" }))
          : undefined;
        let kept = false;
        setItems((list) =>
          list.map((i) => {
            if (i.key !== key) return i;
            kept = true;
            const size = attachment.data.size;
            return preview ? { ...i, attachment, preview, size } : { ...i, attachment, size };
          }),
        );
        // Removed while it was being prepared, or the composer is gone.
        if ((!kept || disposed) && preview) URL.revokeObjectURL(preview);
      },
      () => {
        setItems((list) => list.filter((i) => i.key !== key));
        toasts.show(t("files.refused.unreadable", { name: picked.file.name }), "danger");
      },
    );
  };

  const pick = async (files: File[]) => {
    const room = FILES_PER_MESSAGE - items().length - checking;
    if (files.length > room) toasts.show(t("files.refused.count", { count: FILES_PER_MESSAGE }), "danger");
    const taken = files.slice(0, Math.max(0, room));
    checking += taken.length;
    // One at a time: a check reads the whole file.
    const checked: Picked[] = [];
    try {
      for (const file of taken) checked.push(await check(file));
    } finally {
      checking -= taken.length;
    }
    if (disposed) return;
    for (const picked of checked) {
      if (picked.ok) add(picked);
      else toasts.show(t(refusals[picked.reason], { name: picked.name }), "danger");
    }
  };

  const change = (key: string, update: (item: Item) => Item) =>
    setItems((list) => list.map((i) => (i.key === key ? update(i) : i)));

  /** An image sent as it is keeps the picked file beside the copy the model reads. */
  const setAsIs = (key: string, asIs: boolean) =>
    change(key, (i) => {
      if (!i.attachment) return i;
      const { original: _original, ...attachment } = i.attachment;
      const { file, type } = i.picked;
      return {
        ...i,
        attachment: asIs ? { ...attachment, original: { name: file.name, type, data: file } } : attachment,
      };
    });

  const remove = (key: string) => {
    const item = items().find((i) => i.key === key);
    if (item) free(item);
    setItems((list) => list.filter((i) => i.key !== key));
    if (setting() === key) setSetting(null);
  };

  const shown = () => items().find((i) => i.key === setting());
  const sizeOf = (item: Item) => item.size + (item.keep ? (item.attachment?.original?.data.size ?? 0) : 0);

  const trayItems = (): AttachmentItem[] =>
    items().map((item) => ({
      id: item.key,
      name: item.attachment?.name ?? item.name,
      meta: item.keep
        ? `${formatSize(locale(), sizeOf(item))} · ${t("files.kept")}`
        : formatSize(locale(), sizeOf(item)),
      preview: item.preview,
      kind: item.kind,
      extension: item.extension,
      busy: !item.attachment,
    }));

  return {
    attach: () => (enabled() ? { label: t("files.attach"), accept: ACCEPT, onPick: (f) => void pick(f) } : undefined),
    tray: () => (
      <Show when={items().length > 0}>
        <Attachments
          label={t("files.attached")}
          items={trayItems()}
          removeLabel={t("files.remove")}
          busyLabel={t("files.preparing")}
          locked={sending()}
          onRemove={remove}
          onOpen={setSetting}
          openLabel={t("files.settings")}
        />
      </Show>
    ),
    dialog: () => (
      <Dialog
        open={shown() !== undefined}
        title={shown()?.attachment?.name ?? shown()?.name ?? ""}
        closeLabel={t("common.close")}
        onClose={() => setSetting(null)}
      >
        <Show when={shown()}>
          {(item) => (
            <Stack gap="sm">
              <Checkbox
                label={t("files.keep")}
                hint={t("files.notKept")}
                checked={item().keep}
                onChange={(keep) => change(item().key, (i) => ({ ...i, keep }))}
              />
              <Show when={item().keep && item().picked.big}>
                <Checkbox
                  label={t("files.big.asIs")}
                  hint={t("files.big.text")}
                  checked={item().attachment?.original !== undefined}
                  onChange={(asIs) => setAsIs(item().key, asIs)}
                />
              </Show>
            </Stack>
          )}
        </Show>
      </Dialog>
    ),
    has: () => items().length > 0,
    busy: () => items().some((i) => !i.attachment),
    ready: () => items().flatMap((i) => (i.attachment ? [{ ...i.attachment, keep: i.keep }] : [])),
    clear: () => {
      for (const item of items()) free(item);
      setItems([]);
      setSetting(null);
    },
  };
}
