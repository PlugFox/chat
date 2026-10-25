/**
 * The unlock methods of the account (docs/crypto.md, "ARK wraps"): passkeys,
 * the recovery key and this device. Changing them needs this tab unlocked.
 */
import { createResource, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  List,
  ListItem,
  RecoveryWords,
  Section,
  Stack,
  Text,
} from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { useVault } from "../../vault/context";
import { type KeysError, keysError } from "../../vault/errors";
import type { KeyVault, Wrap } from "../../vault/keys";
import { ConfirmWords } from "../keys/ConfirmWords";

type Rotation = { step: "words" | "confirm"; words: string[] } | { step: "done" };

function RotateRecovery(props: { vault: KeyVault; onClose: () => void }): JSX.Element {
  const { t } = useI18n();
  const [rotation, setRotation] = createSignal<Rotation | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<KeysError | null>(null);

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
  const close = () => {
    props.vault.abandonRotation();
    props.onClose();
  };
  const words = () => {
    const r = rotation();
    return r && r.step !== "done" ? r.words : [];
  };

  return (
    <Dialog open title={t("keys.rotate.title")} closeLabel={t("common.close")} onClose={close}>
      <Stack gap="md">
        <Show when={error()}>{(e) => <Banner tone="danger">{t(e().key, { n: e().word ?? 0 })}</Banner>}</Show>
        <Switch>
          <Match when={rotation() === null}>
            <Text measure>{t("keys.rotate.intro")}</Text>
            <Stack direction="row" wrap gap="sm">
              <Button
                variant="primary"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    setRotation({ step: "words", words: await props.vault.beginRotation() });
                  })
                }
              >
                {t("keys.rotate.start")}
              </Button>
              <Button variant="ghost" onClick={close}>
                {t("common.cancel")}
              </Button>
            </Stack>
          </Match>
          <Match when={rotation()?.step === "words"}>
            <Text measure>{t("keys.recovery.intro")}</Text>
            <RecoveryWords label={t("keys.recovery.label")} words={words()} />
            <Banner tone="warning">{t("keys.recovery.once")}</Banner>
            <Stack direction="row">
              <Button variant="primary" onClick={() => setRotation({ step: "confirm", words: words() })}>
                {t("keys.recovery.written")}
              </Button>
            </Stack>
          </Match>
          <Match when={rotation()?.step === "confirm"}>
            <Text measure>{t("keys.confirm.intro")}</Text>
            <ConfirmWords
              words={words()}
              busy={busy()}
              submit={t("keys.rotate.finish")}
              onBack={() => setRotation({ step: "words", words: words() })}
              onConfirm={() =>
                void run(async () => {
                  await props.vault.finishRotation();
                  setRotation({ step: "done" });
                })
              }
            />
          </Match>
          <Match when={rotation()?.step === "done"}>
            <Banner tone="success">{t("keys.rotate.done")}</Banner>
            <Stack direction="row">
              <Button variant="primary" onClick={props.onClose}>
                {t("common.close")}
              </Button>
            </Stack>
          </Match>
        </Switch>
      </Stack>
    </Dialog>
  );
}

export function KeysSection(): JSX.Element {
  const { t, locale } = useI18n();
  const { vault, state } = useVault();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<KeysError | null>(null);
  const [rotating, setRotating] = createSignal(false);
  const [prf] = createResource(vault, (v) => v.passkeyAvailable());
  const date = (ms: number) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(ms);
  const unlocked = () => {
    const s = state();
    const v = vault();
    return s?.kind === "unlocked" && v ? { vault: v, keys: s.keys } : null;
  };

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

  const title = (wrap: Wrap) =>
    t(
      wrap.method === "passkey"
        ? "keys.method.passkey"
        : wrap.method === "recovery"
          ? "keys.method.recovery"
          : "keys.method.device",
    );

  return (
    <Section title={t("keys.settings.title")}>
      <Show when={unlocked()} fallback={<Text tone="muted">{t("keys.settings.locked")}</Text>}>
        {(u) => (
          <>
            <Show when={error()}>{(e) => <Banner tone="danger">{t(e().key, { n: e().word ?? 0 })}</Banner>}</Show>
            <List label={t("keys.settings.methods")}>
              <For each={u().keys.wraps}>
                {(wrap) => (
                  <ListItem
                    title={title(wrap)}
                    details={[t("keys.method.added", { date: date(wrap.createdAt) })]}
                    actions={
                      <Switch>
                        <Match when={wrap.method === "passkey"}>
                          <Button
                            variant="ghost"
                            disabled={busy()}
                            aria-label={t("keys.method.removeLabel", { date: date(wrap.createdAt) })}
                            onClick={() => void run(() => u().vault.removeWrap(wrap.id))}
                          >
                            {t("keys.method.remove")}
                          </Button>
                        </Match>
                        <Match when={wrap.method === "recovery"}>
                          <Button variant="ghost" disabled={busy()} onClick={() => setRotating(true)}>
                            {t("keys.rotate.button")}
                          </Button>
                        </Match>
                      </Switch>
                    }
                  />
                )}
              </For>
            </List>
            <Show when={prf() !== false}>
              <Stack direction="row">
                <Button icon="key" disabled={busy()} onClick={() => void run(() => u().vault.addPasskey())}>
                  {t("keys.passkey.add")}
                </Button>
              </Stack>
            </Show>
            <Checkbox
              label={t("keys.remember.label")}
              hint={t("keys.remember.hint")}
              checked={u().keys.wraps.some((w) => w.method === "device")}
              disabled={busy()}
              onChange={(on) => void run(() => (on ? u().vault.remember() : u().vault.forgetDevice()))}
            />
            <Show when={rotating()}>
              <RotateRecovery vault={u().vault} onClose={() => setRotating(false)} />
            </Show>
          </>
        )}
      </Show>
    </Section>
  );
}
