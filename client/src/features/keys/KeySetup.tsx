import { createResource, createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { Banner, Button, Checkbox, Page, RecoveryWords, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { type KeysError, keysError } from "../../vault/errors";
import type { KeyVault } from "../../vault/keys";
import { PasskeyError } from "../../vault/passkey";
import { ConfirmWords } from "./ConfirmWords";

type Step = "intro" | "passkey" | "words" | "confirm";

/**
 * First key setup (docs/crypto.md, "First key setup"): the ARK and recovery
 * key are made in the worker, a passkey is added where the browser can, the
 * words are shown and confirmed, and only then is anything uploaded.
 */
export function KeySetup(props: { vault: KeyVault; known: boolean }): JSX.Element {
  const { t } = useI18n();
  const [step, setStep] = createSignal<Step>("intro");
  const [words, setWords] = createSignal<string[]>([]);
  const [passkeyAdded, setPasskeyAdded] = createSignal(false);
  const [remember, setRemember] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<KeysError | null>(null);
  const [prf] = createResource(() => props.vault.passkeyAvailable());

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

  const start = () =>
    run(async () => {
      setWords(await props.vault.beginSetup());
      setStep("passkey");
    });

  const addPasskey = () =>
    run(async () => {
      try {
        await props.vault.setupPasskey();
        setPasskeyAdded(true);
        setStep("words");
      } catch (e) {
        // A passkey without PRF cannot hold a key: say so and go on with the recovery key alone (D-017).
        if (e instanceof PasskeyError && e.reason === "no_prf") setStep("words");
        throw e;
      }
    });

  const finish = () =>
    run(async () => {
      try {
        await props.vault.finishSetup(remember());
      } catch (e) {
        if (keysError(e).key === "keys.error.exists") {
          await props.vault.abandonSetup();
          await props.vault.load();
        }
        throw e;
      }
    });

  return (
    <Page title={t("keys.setup.title")} narrow>
      <Show when={error()}>{(e) => <Banner tone="danger">{t(e().key, { n: e().word ?? 0 })}</Banner>}</Show>
      <Switch>
        <Match when={step() === "intro"}>
          <Show when={props.known}>
            <Banner tone="warning">{t("keys.setup.knownWarning")}</Banner>
          </Show>
          <Text measure>{t("keys.setup.intro")}</Text>
          <Text tone="muted" measure>
            {t("keys.setup.loss")}
          </Text>
          <Text tone="muted" measure>
            {t("keys.setup.server")}
          </Text>
          <Stack direction="row">
            <Button variant="primary" size="lg" disabled={busy()} onClick={() => void start()}>
              {t("keys.setup.start")}
            </Button>
          </Stack>
        </Match>
        <Match when={step() === "passkey"}>
          <Text variant="label-lg">{t("keys.setup.step", { n: 1, total: 3 })}</Text>
          <Show when={prf() !== false} fallback={<Text measure>{t("keys.setup.passkeyUnavailable")}</Text>}>
            <Text measure>{t("keys.setup.passkey")}</Text>
          </Show>
          <Stack direction="row" wrap gap="sm">
            <Show when={prf() !== false}>
              <Button variant="primary" icon="key" disabled={busy()} onClick={() => void addPasskey()}>
                {t("keys.passkey.create")}
              </Button>
            </Show>
            <Button
              variant={prf() === false ? "primary" : "ghost"}
              disabled={busy()}
              onClick={() => {
                setError(null);
                setStep("words");
              }}
            >
              {prf() === false ? t("keys.setup.continue") : t("keys.setup.skipPasskey")}
            </Button>
          </Stack>
        </Match>
        <Match when={step() === "words"}>
          <Text variant="label-lg">{t("keys.setup.step", { n: 2, total: 3 })}</Text>
          <Show when={passkeyAdded()}>
            <Banner tone="success">{t("keys.setup.passkeyAdded")}</Banner>
          </Show>
          <Text measure>{t("keys.recovery.intro")}</Text>
          <RecoveryWords label={t("keys.recovery.label")} words={words()} />
          <Banner tone="warning">{t("keys.recovery.once")}</Banner>
          <Stack direction="row">
            <Button variant="primary" onClick={() => setStep("confirm")}>
              {t("keys.recovery.written")}
            </Button>
          </Stack>
        </Match>
        <Match when={step() === "confirm"}>
          <Text variant="label-lg">{t("keys.setup.step", { n: 3, total: 3 })}</Text>
          <Text measure>{t("keys.confirm.intro")}</Text>
          <ConfirmWords
            vault={props.vault}
            words={words()}
            busy={busy()}
            submit={t("keys.setup.finish")}
            onBack={() => setStep("words")}
            onConfirm={() => void finish()}
          >
            <Checkbox
              label={t("keys.remember.label")}
              hint={t("keys.remember.hint")}
              checked={remember()}
              onChange={setRemember}
            />
          </ConfirmWords>
        </Match>
      </Switch>
    </Page>
  );
}
