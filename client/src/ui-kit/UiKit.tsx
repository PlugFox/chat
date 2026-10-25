/**
 * Every component and variant on one page, for review and for the e2e suite
 * (axe and touch targets in every theme). Development and test builds only.
 * Adding a component or a variant means adding it here.
 */
import { createSignal, type JSX } from "solid-js";
import {
  Banner,
  Button,
  Dialog,
  Heading,
  IconButton,
  Page,
  Section,
  Select,
  Stack,
  Text,
  TextField,
} from "../design-system/components";
import { useI18n } from "../i18n/i18n";

export default function UiKit(): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  const [choice, setChoice] = createSignal<"a" | "b">("a");
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
        <TextField label={t("uiKit.sample.field")} mono value="abandon ability able" autocomplete="off" />
        <Select
          label={t("settings.theme")}
          value={choice()}
          options={[
            { value: "a", label: t("settings.theme.light") },
            { value: "b", label: t("settings.theme.dark") },
          ]}
          onChange={setChoice}
        />
      </Section>

      <Section title={t("uiKit.feedback")}>
        <Banner>{t("uiKit.sample.info")}</Banner>
        <Banner tone="success">{t("uiKit.sample.success")}</Banner>
        <Banner tone="warning">{t("uiKit.sample.warning")}</Banner>
        <Banner tone="danger">{t("uiKit.sample.danger.text")}</Banner>
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
