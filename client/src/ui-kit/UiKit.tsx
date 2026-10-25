/**
 * Every component and variant on one page, for review and for the e2e suite
 * (axe and touch targets in every theme). Development and test builds only.
 * Adding a component or a variant means adding it here.
 */
import { createSignal, type JSX, Match, Switch } from "solid-js";
import { cryptoSelfTest } from "../crypto/self-test";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  Heading,
  IconButton,
  List,
  ListItem,
  Page,
  RecoveryWords,
  Section,
  Select,
  Stack,
  Text,
  TextField,
} from "../design-system/components";
import { useI18n } from "../i18n/i18n";

/** BIP-39 words for the look only; not anyone's key. */
const SAMPLE_WORDS = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");

export default function UiKit(): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  const [choice, setChoice] = createSignal<"a" | "b">("a");
  const [checked, setChecked] = createSignal(false);
  const [selfTest, setSelfTest] = createSignal<"idle" | "running" | "ok" | { error: string }>("idle");
  const runSelfTest = () => {
    setSelfTest("running");
    cryptoSelfTest().then(
      () => setSelfTest("ok"),
      (e: unknown) => setSelfTest({ error: e instanceof Error ? e.message : String(e) }),
    );
  };
  return (
    <Page title={t("uiKit.title")}>
      <Text tone="muted">{t("uiKit.intro")}</Text>

      <Section title={t("uiKit.buttons")}>
        <Stack direction="row" wrap gap="sm" align="center">
          <Button variant="primary" icon="send">
            {t("uiKit.sample.primary")}
          </Button>
          <Button>{t("uiKit.sample.secondary")}</Button>
          <Button variant="danger" icon="delete">
            {t("uiKit.sample.danger")}
          </Button>
          <Button variant="ghost">{t("uiKit.sample.ghost")}</Button>
          <Button variant="primary" disabled>
            {t("uiKit.sample.disabled")}
          </Button>
          <Button variant="primary" size="lg">
            {t("uiKit.sample.primary")}
          </Button>
        </Stack>
        <Stack direction="row" wrap gap="sm" align="center">
          <IconButton icon="edit" label={t("uiKit.sample.ghost")} />
          <IconButton icon="more_vert" label={t("uiKit.sample.secondary")} variant="secondary" />
          <IconButton icon="send" label={t("uiKit.sample.primary")} variant="primary" mirrorInRtl />
        </Stack>
      </Section>

      <Section title={t("uiKit.fields")}>
        <TextField label={t("uiKit.sample.field")} hint={t("uiKit.sample.fieldHint")} autocomplete="off" />
        <TextField label={t("uiKit.sample.field")} error={t("uiKit.sample.fieldError")} autocomplete="off" />
        <TextField
          label={t("uiKit.sample.field")}
          mono
          value="abandon ability ab"
          autocomplete="off"
          suggestions={["abandon", "ability", "able", "about"]}
          suggestionsLabel={t("keys.recovery.suggestions")}
        />
        <Select
          label={t("settings.theme")}
          value={choice()}
          options={[
            { value: "a", label: t("settings.theme.light") },
            { value: "b", label: t("settings.theme.dark") },
          ]}
          onChange={setChoice}
        />
        <Checkbox
          label={t("uiKit.sample.checkbox")}
          hint={t("uiKit.sample.fieldHint")}
          checked={checked()}
          onChange={setChecked}
        />
        <Checkbox label={t("uiKit.sample.disabled")} checked disabled onChange={() => undefined} />
        <RecoveryWords label={t("keys.recovery.label")} words={SAMPLE_WORDS} />
      </Section>

      <Section title={t("uiKit.feedback")}>
        <Banner>{t("uiKit.sample.info")}</Banner>
        <Banner tone="success">{t("uiKit.sample.success")}</Banner>
        <Banner tone="warning">{t("uiKit.sample.warning")}</Banner>
        <Banner tone="danger">{t("uiKit.sample.danger.text")}</Banner>
      </Section>

      <Section title={t("uiKit.list")}>
        <List label={t("uiKit.list")}>
          <ListItem
            title={t("uiKit.sample.listTitle")}
            badge={t("settings.session.current")}
            details={[t("uiKit.sample.listDetail"), t("uiKit.sample.listDetail2")]}
          />
          <ListItem
            title={t("uiKit.sample.listTitle")}
            details={[t("uiKit.sample.listDetail")]}
            actions={<Button variant="ghost">{t("settings.session.revoke")}</Button>}
          />
        </List>
      </Section>

      <Section title={t("uiKit.typography")}>
        <Heading level={3} size="headline-lg">
          {t("uiKit.sample.heading")}
        </Heading>
        <Heading level={3} size="headline-sm">
          {t("uiKit.sample.heading")}
        </Heading>
        <Heading level={3} size="title-md">
          {t("uiKit.sample.heading")}
        </Heading>
        <Text variant="body-lg" measure>
          {t("uiKit.sample.body")}
        </Text>
        <Text measure>{t("uiKit.sample.body")}</Text>
        <Text variant="body-sm" tone="muted" measure>
          {t("uiKit.sample.body")}
        </Text>
      </Section>

      <Section title={t("uiKit.crypto")}>
        <Stack direction="row">
          <Button onClick={runSelfTest} disabled={selfTest() === "running"}>
            {t("uiKit.crypto.run")}
          </Button>
        </Stack>
        <Switch>
          <Match when={selfTest() === "ok"}>
            <Banner tone="success">{t("uiKit.crypto.ok")}</Banner>
          </Match>
          <Match
            when={(() => {
              const s = selfTest();
              return typeof s === "object" ? s : false;
            })()}
          >
            {(s) => <Banner tone="danger">{t("uiKit.crypto.failed", { error: s().error })}</Banner>}
          </Match>
        </Switch>
      </Section>

      <Section title={t("uiKit.dialog")}>
        <Stack direction="row">
          <Button onClick={() => setOpen(true)}>{t("uiKit.sample.openDialog")}</Button>
        </Stack>
        <Dialog
          open={open()}
          title={t("uiKit.sample.dialogTitle")}
          closeLabel={t("common.close")}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                {t("common.save")}
              </Button>
            </>
          }
        >
          <Text>{t("uiKit.sample.dialogBody")}</Text>
        </Dialog>
      </Section>
    </Page>
  );
}
