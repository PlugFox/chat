/**
 * A chat's settings (D-093): the model, the reasoning effort and how much
 * history a turn carries, chosen in a dialog that the composer's options
 * button opens and named there in short. A field left at its default takes
 * the account's choice.
 */
import { createEffect, createSignal, type JSX, on } from "solid-js";
import { useAgent } from "../../agent/context";
import { HISTORY_DEFAULT, historyMessages } from "../../chats/records";
import { Dialog, Select, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { ChatSettings, Effort, StoredProvider } from "../../protocol/generated/protocol";

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const HISTORY_PRESETS = [10, 20, 50, 100, 200];

/** The provider a turn of the chat runs with: its own, or the active one. */
function useProvider(): (settings: ChatSettings) => StoredProvider | undefined {
  const { providers } = useAgent();
  return (settings) => {
    const state = providers();
    if (state?.kind !== "ready") return undefined;
    const list = state.value.providers;
    return list.find((p) => p.id === settings.provider) ?? list.find((p) => p.id === state.value.active);
  };
}

/** What the composer's options button shows: the model, then what the chat changed. */
export function useSettingsSummary(): (settings: ChatSettings) => string {
  const { t } = useI18n();
  const provider = useProvider();
  return (settings) => {
    const parts = [provider(settings)?.model ?? t("chat.settings.modelNone")];
    if (settings.effort) parts.push(t(`chat.settings.effort.${settings.effort}`));
    if (settings.history?.mode === "recent")
      parts.push(t("chat.settings.messages", { count: settings.history.messages }));
    return parts.join(" · ");
  };
}

export function ChatSettingsDialog(props: {
  open: boolean;
  settings: ChatSettings;
  onChange: (settings: ChatSettings) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const { providers } = useAgent();
  // The dialog shows what was chosen at once; the chat's copy follows from the server.
  const [draft, setDraft] = createSignal<ChatSettings>({});
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) setDraft(props.settings);
      },
    ),
  );
  const change = (next: ChatSettings) => {
    setDraft(next);
    props.onChange(next);
  };
  /** `next` with `key` set, or removed for the default. */
  const set = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K] | undefined) => {
    const { [key]: _, ...rest } = draft();
    change(value === undefined ? rest : { ...rest, [key]: value });
  };

  const models = () => {
    const state = providers();
    const list = state?.kind === "ready" ? state.value.providers : [];
    const active = state?.kind === "ready" ? list.find((p) => p.id === state.value.active) : undefined;
    return [
      {
        value: "",
        label: active
          ? t("chat.settings.modelDefault", { name: active.name, model: active.model })
          : t("chat.settings.modelNone"),
      },
      ...list.map((p) => ({ value: p.id, label: `${p.name} · ${p.model}` })),
    ];
  };
  const efforts = () => [
    { value: "", label: t("chat.settings.effortDefault") },
    ...EFFORTS.map((e) => ({ value: e, label: t(`chat.settings.effort.${e}`) })),
  ];
  const histories = () => {
    const current = draft().history;
    const counts = [...HISTORY_PRESETS];
    // A count another device chose stays selectable.
    if (current?.mode === "recent" && !counts.includes(current.messages)) counts.push(current.messages);
    return [
      { value: "", label: t("chat.settings.historyDefault", { count: HISTORY_DEFAULT }) },
      ...counts
        .sort((a, b) => a - b)
        .map((n) => ({ value: String(n), label: t("chat.settings.historyRecent", { count: n }) })),
    ];
  };
  const history = () => {
    const current = draft().history;
    return current?.mode === "recent" ? String(historyMessages(draft())) : "";
  };

  return (
    <Dialog open={props.open} title={t("chat.settings.title")} closeLabel={t("common.close")} onClose={props.onClose}>
      <Stack gap="md">
        <Select
          label={t("chat.settings.model")}
          value={models().some((m) => m.value === draft().provider) ? (draft().provider ?? "") : ""}
          options={models()}
          onChange={(id) => set("provider", id === "" ? undefined : id)}
        />
        <Stack gap="xs">
          <Select
            label={t("chat.settings.effort")}
            value={draft().effort ?? ""}
            options={efforts()}
            onChange={(e) => set("effort", e === "" ? undefined : (e as Effort))}
          />
          <Text tone="muted" variant="body-sm">
            {t("chat.settings.effortNote")}
          </Text>
        </Stack>
        <Stack gap="xs">
          <Select
            label={t("chat.settings.history")}
            value={history()}
            options={histories()}
            onChange={(n) => set("history", n === "" ? undefined : { mode: "recent", messages: Number(n) })}
          />
          <Text tone="muted" variant="body-sm">
            {t("chat.settings.historyNote")}
          </Text>
        </Stack>
      </Stack>
    </Dialog>
  );
}
