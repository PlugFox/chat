import { createSignal, type JSX, Show } from "solid-js";
import { Banner, Button, Checkbox, Page, Section, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { type KeysError, keysError } from "../../vault/errors";
import type { Keys, KeyVault } from "../../vault/keys";
import { LinkQr } from "./LinkQr";
import { RecoveryInput } from "./RecoveryInput";

/** Unlock in this tab (D-019) with a passkey, the recovery key or an unlocked phone. */
export function Unlock(props: { vault: KeyVault; keys: Keys; linkFailed: boolean }): JSX.Element {
  const { t } = useI18n();
  const [words, setWords] = createSignal("");
  const [remember, setRemember] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<KeysError | null>(null);
  const [linking, setLinking] = createSignal(false);
  const hasPasskey = () => props.keys.wraps.some((w) => w.method === "passkey");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(keysError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void run(() => props.vault.unlockWithRecovery(words(), remember()));
  };

  return (
    <Page title={t("keys.unlock.title")} narrow>
      <Text tone="muted" measure>
        {t("keys.unlock.intro")}
      </Text>
      <Show when={error()}>{(e) => <Banner tone="danger">{t(e().key, { n: e().word ?? 0 })}</Banner>}</Show>
      <Checkbox
        label={t("keys.remember.label")}
        hint={t("keys.remember.hint")}
        checked={remember()}
        onChange={setRemember}
      />
      <Show when={hasPasskey()}>
        <Stack direction="row">
          <Button
            variant="primary"
            size="lg"
            icon="key"
            disabled={busy()}
            onClick={() => void run(() => props.vault.unlockWithPasskey(remember()))}
          >
            {t("keys.unlock.passkey")}
          </Button>
        </Stack>
      </Show>
      <Section title={t("keys.unlock.recoveryTitle")}>
        <Stack as="form" gap="md" onSubmit={submit}>
          <RecoveryInput
            vault={props.vault}
            phrase
            label={t("keys.recovery.label")}
            hint={t("keys.unlock.recoveryHint")}
            value={words()}
            onInput={setWords}
          />
          <Stack direction="row">
            <Button type="submit" variant={hasPasskey() ? "secondary" : "primary"} disabled={busy()}>
              {t("keys.unlock.recovery")}
            </Button>
          </Stack>
        </Stack>
      </Section>
      <Section title={t("keys.link.title")}>
        <Text measure>{t("keys.link.intro")}</Text>
        <Show
          when={linking()}
          fallback={
            <Stack direction="row">
              <Button icon="qr_code" onClick={() => setLinking(true)}>
                {t("keys.link.show")}
              </Button>
            </Stack>
          }
        >
          <LinkQr vault={props.vault} remember={remember()} failed={props.linkFailed} />
          <Stack direction="row">
            <Button variant="ghost" onClick={() => setLinking(false)}>
              {t("keys.link.hide")}
            </Button>
          </Stack>
        </Show>
      </Section>
    </Page>
  );
}
