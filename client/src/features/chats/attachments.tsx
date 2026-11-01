/**
 * The files of a message being written (D-101): picked through the
 * composer, checked, refused with a toast when no agent takes them, big
 * images sent compressed or as they are as the user chooses (as Telegram
 * asks), each prepared in the media worker one at a time, shown in the
 * composer until the message is sent. Files are not kept unless the user asks
 * (D-107): a chat is not a gallery, so a big image is then just compressed.
 */
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { useToasts } from "../../app/toasts";
import {
  type AttachmentItem,
  Attachments,
  Button,
  Checkbox,
  Dialog,
  Stack,
  Text,
} from "../../design-system/components";
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
  /** The choice for big images, to render beside the composer. */
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
  const [asking, setAsking] = createSignal<(Picked & { ok: true })[]>([]);
  const [keep, setKeep] = createSignal(false);
  let waiting: (Picked & { ok: true })[] = [];
  /** Asked again after they were already in the composer. */
  const reasked = new Set<Picked>();
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

  const add = (picked: Picked & { ok: true }, asIs: boolean) => {
    const key = crypto.randomUUID();
    const item: Item = {
      key,
      name: picked.file.name,
      kind: iconOf(picked.file.name, picked.type),
      extension: extension(picked.file.name),
      size: picked.file.size,
      picked,
    };
    setItems((list) => [...list, item]);
    media ??= new MediaClient();
    prepare(picked, asIs, media).then(
      (attachment) => {
        const preview = attachment.preview
          ? URL.createObjectURL(new Blob([new Uint8Array(attachment.preview)], { type: "image/jpeg" }))
          : undefined;
        let kept = false;
        setItems((list) =>
          list.map((i) => {
            if (i.key !== key) return i;
            kept = true;
            const size = attachment.data.size + (attachment.original?.data.size ?? 0);
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
    const room = FILES_PER_MESSAGE - items().length - waiting.length - checking;
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
    const big: (Picked & { ok: true })[] = [];
    for (const picked of checked) {
      if (!picked.ok) {
        toasts.show(t(refusals[picked.reason], { name: picked.name }), "danger");
        continue;
      }
      if (picked.big && keep()) big.push(picked);
      else add(picked, false);
    }
    if (big.length > 0) {
      waiting = [...waiting, ...big];
      setAsking(waiting);
    }
  };

  const choose = (asIs: boolean) => {
    const big = waiting;
    waiting = [];
    setAsking([]);
    for (const picked of big) {
      // Asked after the fact: it is already in the composer, compressed.
      const already = items().find((i) => i.picked === picked);
      // Refused while its question was open: it does not come back.
      if (!already && reasked.delete(picked)) continue;
      if (already && !asIs) continue;
      if (already) remove(already.key);
      add(picked, asIs && keep());
    }
  };

  /** Only a kept image can go as it is, so turning this on asks about those already picked. */
  const changeKeep = (on: boolean) => {
    setKeep(on);
    if (!on) return;
    const big = items().flatMap((i) => (i.picked.big && !i.attachment?.original ? [i.picked] : []));
    if (big.length > 0) {
      for (const picked of big) reasked.add(picked);
      waiting = [...waiting, ...big];
      setAsking(waiting);
    }
  };

  const remove = (key: string) => {
    const item = items().find((i) => i.key === key);
    if (item) free(item);
    setItems((list) => list.filter((i) => i.key !== key));
  };

  const trayItems = (): AttachmentItem[] =>
    items().map((item) => ({
      id: item.key,
      name: item.attachment?.name ?? item.name,
      meta: formatSize(locale(), item.size),
      preview: item.preview,
      kind: item.kind,
      extension: item.extension,
      busy: !item.attachment,
    }));

  return {
    attach: () => (enabled() ? { label: t("files.attach"), accept: ACCEPT, onPick: (f) => void pick(f) } : undefined),
    tray: () => (
      <Show when={items().length > 0}>
        <Stack gap="xs">
          <Attachments
            label={t("files.attached")}
            items={trayItems()}
            removeLabel={t("files.remove")}
            busyLabel={t("files.preparing")}
            locked={sending()}
            onRemove={remove}
          />
          <Checkbox label={t("files.keep")} checked={keep()} disabled={sending()} onChange={changeKeep} />
          <Show when={!keep()}>
            <Text tone="muted" variant="body-sm">
              {t("files.notKept")}
            </Text>
          </Show>
        </Stack>
      </Show>
    ),
    dialog: () => (
      <Dialog
        open={asking().length > 0}
        title={t("files.big.title", { count: asking().length })}
        closeLabel={t("common.close")}
        onClose={() => choose(false)}
        actions={
          <>
            <Button onClick={() => choose(true)}>{t("files.big.asIs")}</Button>
            <Button variant="primary" onClick={() => choose(false)}>
              {t("files.big.compress")}
            </Button>
          </>
        }
      >
        <Stack gap="xs">
          <Text>{t("files.big.text")}</Text>
          <For each={asking()}>
            {(picked) => (
              <Text tone="muted" variant="body-sm">
                {picked.file.name}
              </Text>
            )}
          </For>
        </Stack>
      </Dialog>
    ),
    has: () => items().length > 0,
    busy: () => items().some((i) => !i.attachment),
    ready: () => items().flatMap((i) => (i.attachment ? [{ ...i.attachment, keep: keep() }] : [])),
    clear: () => {
      for (const item of items()) free(item);
      setItems([]);
      waiting = [];
      setAsking([]);
      setKeep(false);
    },
  };
}
