import { useNavigate } from "@solidjs/router";
import { createResource, createSignal, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { Banner, Button, List, ListItem, Page, Stack, Text } from "../../design-system/components";
import { describeAgent } from "../../i18n/agent";
import { useI18n } from "../../i18n/i18n";
import { useVault } from "../../vault/context";
import { type KeysError, keysError } from "../../vault/errors";
import { claimLink } from "../../vault/link";

/**
 * The unlocked device's side of linking: opened from the QR by the phone's
 * camera, behind the key gate. Nothing is sent until the user confirms.
 */
export default function LinkPage(): JSX.Element {
  const { t, locale } = useI18n();
  const { vault } = useVault();
  const navigate = useNavigate();
  const code = claimLink();
  const [outcome, setOutcome] = createSignal<"done" | "cancelled" | null>(null);
  const [error, setError] = createSignal<KeysError | null>(null);
  const [busy, setBusy] = createSignal(false);
  const wipe = () => code?.secret.fill(0);
  onCleanup(wipe);

  const [requester] = createResource(
    () => (code ? vault() : null),
    async (v) => {
      try {
        return await v.linkInfo(code?.sid ?? "");
      } catch (e) {
        setError(keysError(e));
        return null;
      }
    },
  );

  const device = () => {
    const agent = describeAgent(requester()?.user_agent);
    return agent ? t("keys.linkPage.device", agent) : t("keys.linkPage.unknownDevice");
  };
  const details = () => {
    const r = requester();
    if (!r) return [];
    const date = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(r.created_at);
    return [
      t("keys.linkPage.created", { date }),
      ...(r.country ? [new Intl.DisplayNames([locale()], { type: "region" }).of(r.country) ?? r.country] : []),
    ];
  };

  const confirm = async () => {
    const v = vault();
    if (!code || !v) return;
    setBusy(true);
    setError(null);
    try {
      await v.sendLink(code);
      wipe();
      setOutcome("done");
    } catch (e) {
      setError(keysError(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    wipe();
    setOutcome("cancelled");
  };

  const home = (
    <Stack direction="row">
      <Button onClick={() => navigate("/")}>{t("keys.linkPage.home")}</Button>
    </Stack>
  );

  return (
    <Page title={t("keys.linkPage.title")} narrow busy={requester.loading}>
      <Switch>
        <Match when={outcome() === "done"}>
          <Banner tone="success">{t("keys.linkPage.done")}</Banner>
          {home}
        </Match>
        <Match when={outcome() === "cancelled"}>
          <Banner>{t("keys.linkPage.cancelled")}</Banner>
          {home}
        </Match>
        <Match when={!code || (!requester.loading && !requester())}>
          <Banner tone="danger">{t(error()?.key ?? "keys.linkPage.expired")}</Banner>
          {home}
        </Match>
        <Match when={requester()}>
          <Show when={error()}>{(e) => <Banner tone="danger">{t(e().key)}</Banner>}</Show>
          <Text measure>{t("keys.linkPage.ask")}</Text>
          <List label={t("keys.linkPage.title")}>
            <ListItem title={device()} details={details()} />
          </List>
          <Banner tone="warning">{t("keys.linkPage.warning")}</Banner>
          <Stack direction="row" wrap gap="sm">
            <Button variant="primary" disabled={busy()} onClick={() => void confirm()}>
              {t("keys.linkPage.confirm")}
            </Button>
            <Button variant="ghost" disabled={busy()} onClick={cancel}>
              {t("keys.linkPage.cancel")}
            </Button>
          </Stack>
        </Match>
      </Switch>
    </Page>
  );
}

/** `/link` while signed out: the code is dropped, not kept across the sign-in redirect (D-075). */
export function LinkSignedOut(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  claimLink()?.secret.fill(0);
  return (
    <Page title={t("keys.linkPage.signedOutTitle")} narrow>
      <Text measure>{t("keys.linkPage.signedOut")}</Text>
      <Stack direction="row">
        <Button variant="primary" onClick={() => navigate("/sign-in")}>
          {t("keys.linkPage.signIn")}
        </Button>
      </Stack>
    </Page>
  );
}
