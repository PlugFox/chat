import { createSignal, type JSX, Show } from "solid-js";
import { Banner, Button, Checkbox, Page, Section, Stack, Text, TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { type KeysError, keysError } from "../../vault/errors";
import type { Keys, KeyVault } from "../../vault/keys";

/** Unlock in this tab (D-019) with a passkey or the recovery key. */
export function Unlock(props: { vault: KeyVault; keys: Keys }): JSX.Element {
  const { t } = useI18n();
  const [words, setWords] = createSignal("");
  const [remember, setRemember] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<KeysError | null>(null);
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
          <TextField
            label={t("keys.recovery.label")}
            hint={t("keys.unlock.recoveryHint")}
            mono
            required
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            value={words()}
            onInput={(e) => setWords(e.currentTarget.value)}
          />
          <Stack direction="row">
            <Button type="submit" variant={hasPasskey() ? "secondary" : "primary"} disabled={busy()}>
              {t("keys.unlock.recovery")}
            </Button>
          </Stack>
        </Stack>
      </Section>
    </Page>
  );
}
