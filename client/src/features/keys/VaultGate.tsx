import { type JSX, Match, Switch } from "solid-js";
import { Banner, Button, Page, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { useVault } from "../../vault/context";
import { KeySetup } from "./KeySetup";
import { Unlock } from "./Unlock";

/**
 * Shows its children only once the keys are unlocked in this tab; until then
 * the setup or unlock screen takes their place. Signing in never unlocks (G6).
 */
export function VaultGate(props: { children: JSX.Element }): JSX.Element {
  const { t } = useI18n();
  const { vault, state } = useVault();
  const linkFailed = () => {
    const s = state();
    return s?.kind === "locked" && !!s.linkFailed;
  };
  return (
    <Switch
      fallback={
        <Page title={t("keys.loading.title")} narrow busy>
          <Text tone="muted">{t("keys.loading.text")}</Text>
        </Page>
      }
    >
      <Match when={state()?.kind === "unlocked"}>{props.children}</Match>
      <Match when={state()?.kind === "failed"}>
        <Page title={t("keys.loading.title")} narrow>
          <Banner tone="danger">{t("keys.loading.failed")}</Banner>
          <Stack direction="row">
            <Button onClick={() => void vault()?.load()}>{t("common.retry")}</Button>
          </Stack>
        </Page>
      </Match>
      <Match
        when={(() => {
          const s = state();
          const v = vault();
          return s?.kind === "new" && v ? { vault: v, known: s.known } : null;
        })()}
      >
        {(setup) => <KeySetup vault={setup().vault} known={setup().known} />}
      </Match>
      <Match
        when={(() => {
          const s = state();
          const v = vault();
          return s?.kind === "locked" && !s.device && v ? { vault: v, keys: s.keys } : null;
        })()}
      >
        {/* Read from the state, not the Match value: it changes while the screen
            is up, and the Match value goes stale the moment the tab unlocks. */}
        {(locked) => <Unlock vault={locked().vault} keys={locked().keys} linkFailed={linkFailed()} />}
      </Match>
    </Switch>
  );
}
