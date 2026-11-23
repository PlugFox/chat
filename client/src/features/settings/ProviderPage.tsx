import { useNavigate } from "@solidjs/router";
import { createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { host, sameConfig } from "../../agent/agent";
import { useAgent } from "../../agent/context";
import { claimProvider } from "../../agent/share";
import { Banner, Button, List, ListItem, Page, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";

/**
 * A provider config opened from a shared link (docs/protocol.md, "Provider
 * links"; D-098), behind the key gate. Nothing is added until the user
 * confirms, after seeing the host every turn with it would go to.
 */
export default function ProviderPage(): JSX.Element {
  const { t } = useI18n();
  const { providers, update } = useAgent();
  const navigate = useNavigate();
  const shared = claimProvider();
  const config = shared === "invalid" ? null : shared;
  const [outcome, setOutcome] = createSignal<"added" | "active" | "cancelled" | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const ready = () => {
    const p = providers();
    return p?.kind === "ready" ? p.value : null;
  };
  const known = () => (config ? ready()?.providers.find((p) => sameConfig(p, config)) : undefined);

  const add = async () => {
    if (!config) return;
    setBusy(true);
    setFailed(false);
    const id = crypto.randomUUID();
    try {
      await update((v) => {
        // Added on another device meanwhile: once is enough.
        if (v.providers.some((p) => sameConfig(p, config))) return v;
        return { providers: [...v.providers, { id, ...config }], active: v.active ?? id };
      });
      setOutcome(ready()?.active === id ? "active" : "added");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const done = (
    <Stack direction="row">
      <Button onClick={() => navigate("/settings/providers")}>{t("providers.import.settings")}</Button>
    </Stack>
  );

  return (
    <Page title={t("providers.import.title")} narrow busy={!ready() && providers()?.kind !== "failed"}>
      <Switch>
        <Match when={outcome() === "added" || outcome() === "active"}>
          <Banner tone="success">
            {t(outcome() === "active" ? "providers.import.addedActive" : "providers.import.added", {
              name: config?.name ?? "",
            })}
          </Banner>
          {done}
        </Match>
        <Match when={outcome() === "cancelled"}>
          <Banner>{t("providers.import.cancelled")}</Banner>
          {done}
        </Match>
        <Match when={!config}>
          <Banner tone="danger">
            {t(shared === "invalid" ? "providers.import.invalid" : "providers.import.missing")}
          </Banner>
          {done}
        </Match>
        <Match when={providers()?.kind === "failed"}>
          <Banner tone="danger">{t("providers.loadFailed")}</Banner>
        </Match>
        <Match when={config && ready() ? config : null}>
          {(c) => (
            <>
              <Show when={known()}>
                {(p) => <Banner tone="success">{t("providers.import.known", { name: p().name })}</Banner>}
              </Show>
              <Show when={failed()}>
                <Banner tone="danger">{t("providers.saveFailed")}</Banner>
              </Show>
              <List label={t("providers.import.title")}>
                <ListItem
                  title={c().name}
                  details={[
                    t(`providers.kind.${c().kind}`),
                    `${host(c().base_url)} · ${c().model}`,
                    c().api_key === "" ? t("providers.import.noKey") : t("providers.import.withKey"),
                  ]}
                />
              </List>
              <Show when={!known()} fallback={done}>
                <Banner tone="warning">{t("providers.import.warning", { host: host(c().base_url) })}</Banner>
                <Stack direction="row" wrap gap="sm">
                  <Button variant="primary" disabled={busy()} onClick={() => void add()}>
                    {t("providers.import.add")}
                  </Button>
                  <Button variant="ghost" disabled={busy()} onClick={() => setOutcome("cancelled")}>
                    {t("common.cancel")}
                  </Button>
                </Stack>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </Page>
  );
}

/** `/provider` while signed out: the config is dropped, not kept across the sign-in redirect (D-098). */
export function ProviderSignedOut(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  claimProvider();
  return (
    <Page title={t("providers.import.signedOutTitle")} narrow>
      <Text measure>{t("providers.import.signedOut")}</Text>
      <Stack direction="row">
        <Button variant="primary" onClick={() => navigate("/sign-in")}>
          {t("keys.linkPage.signIn")}
        </Button>
      </Stack>
    </Page>
  );
}
