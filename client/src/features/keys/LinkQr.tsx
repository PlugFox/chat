import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Banner, Button, QrCode, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { type KeysError, keysError } from "../../vault/errors";
import type { KeyVault, LinkShown } from "../../vault/keys";

/** Shortly before the server's 2 minutes, so a code is never shown dead. */
const RENEW_EARLY_MS = 5_000;
/** The `link.message` event is the fast path; this catches one that was missed. */
const POLL_MS = 5_000;

/**
 * The new device's side of linking: a QR the unlocked phone scans, renewed
 * before it expires. The tab unlocks by itself when the phone answers.
 */
export function LinkQr(props: { vault: KeyVault; remember: boolean; failed: boolean }): JSX.Element {
  const { t } = useI18n();
  // Taken once: the vault outlives this screen, and reading it through props
  // inside the effects below would track the gate's Match, which goes stale on unlock.
  const vault = props.vault;
  const [shown, setShown] = createSignal<LinkShown | null>(null);
  const [error, setError] = createSignal<KeysError | null>(null);
  let renew: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let disposed = false;

  const show = async () => {
    if (busy) return;
    busy = true;
    clearTimeout(renew);
    setError(null);
    try {
      const link = await vault.beginLink(location.origin);
      // Hidden or unlocked while the code was being made: nothing may keep it.
      if (disposed) {
        vault.endLink();
        return;
      }
      setShown(link);
      if (!link) return;
      vault.linkRemember(props.remember);
      renew = setTimeout(() => void show(), Math.max(link.expiresInMs - RENEW_EARLY_MS, 1_000));
    } catch (e) {
      setShown(null);
      setError(keysError(e));
    } finally {
      busy = false;
    }
  };

  const poll = setInterval(async () => {
    if (busy || disposed || !shown()) return;
    if (!(await vault.pollLink()) && !disposed && !props.failed) void show();
  }, POLL_MS);

  onMount(() => void show());
  createEffect(() => vault.linkRemember(props.remember));
  // A failed answer: the code on screen is spent.
  createEffect(
    on(
      () => props.failed,
      (failed) => {
        if (!failed) return;
        clearTimeout(renew);
        setShown(null);
      },
    ),
  );
  onCleanup(() => {
    disposed = true;
    clearTimeout(renew);
    clearInterval(poll);
    vault.endLink();
  });

  return (
    <Stack gap="md">
      <Show when={props.failed}>
        <Banner tone="danger">{t("keys.link.failed")}</Banner>
      </Show>
      <Show when={error()}>{(e) => <Banner tone="danger">{t(e().key)}</Banner>}</Show>
      <Show when={shown()}>
        {(link) => (
          <>
            <QrCode value={link().url} label={t("keys.link.qr")} />
            <Text tone="muted" measure>
              {t("keys.link.scan")}
            </Text>
          </>
        )}
      </Show>
      <Show when={props.failed || error()}>
        <Stack direction="row">
          <Button onClick={() => void show()}>{t("keys.link.show")}</Button>
        </Stack>
      </Show>
    </Stack>
  );
}
