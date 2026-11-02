/**
 * A chat's settings (D-093): the model, the reasoning effort and how much
 * history a turn carries with its auto-compaction (D-091), chosen in a
 * dialog that the composer's options button opens and named there in short.
 * A field left at its default takes the account's choice, which Settings
 * holds with the same history fields.
 */
import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import { useAgent } from "../../agent/context";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import { type HistoryChoice, resolveHistory } from "../../chats/records";
import { Button, Dialog, Select, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { ChatSettings, Effort, History, StoredProvider } from "../../protocol/generated/protocol";

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const HISTORY_PRESETS = [10, 20, 50, 100, 200];
/** Auto-compaction thresholds offered, in thousands of tokens (D-091). */
const THRESHOLD_PRESETS = [16, 32, 64, 96, 128];

/** One choice of history in words, as a default option names it. */
function useChoiceLabel(): (choice: HistoryChoice) => string {
  const { t } = useI18n();
  return (choice) => {
    if (choice.mode === "recent") return t("chat.settings.historyRecent", { count: choice.messages });
    if (!choice.auto) return t("chat.settings.historyCompact");
    return t("chat.settings.compactAuto", { count: Math.round(choice.threshold / 1000) });
  };
}

/**
 * The history a chat or the account chose, and its auto-compaction while it
 * compacts; the defaults stand for `inherited` (the account's choice in a
 * chat, none in the account).
 */
export function HistoryFields(props: {
  history: History | undefined;
  inherited: History | undefined;
  onChange: (history: History | undefined) => void;
  /** Offers no history at all: a chat's choice only, as the server cannot read the account's (D-112). */
  closable?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const choiceLabel = useChoiceLabel();
  const fallback = () => resolveHistory(undefined, props.inherited);
  const histories = () => {
    const current = props.history;
    const counts = [...HISTORY_PRESETS];
    // A count another device chose stays selectable.
    if (current?.mode === "recent" && current.messages > 0 && !counts.includes(current.messages)) {
      counts.push(current.messages);
    }
    return [
      { value: "", label: t("chat.settings.default", { choice: choiceLabel(fallback()) }) },
      ...(props.closable ? [{ value: "0", label: t("chat.settings.historyNone") }] : []),
      { value: "compact", label: t("chat.settings.historyCompact") },
      ...counts
        .sort((a, b) => a - b)
        .map((n) => ({ value: String(n), label: t("chat.settings.historyRecent", { count: n }) })),
    ];
  };
  const history = () => {
    const current = props.history;
    if (current?.mode === "recent") return String(current.messages);
    return current?.mode === "compact" ? "compact" : "";
  };
  /** What auto-compaction falls back to: the chosen mode's default. */
  const compactFallback = () => {
    const resolved = resolveHistory({ mode: "compact" }, props.inherited);
    return resolved.mode === "compact" && resolved.auto
      ? t("chat.settings.compactAt", { count: Math.round(resolved.threshold / 1000) })
      : t("chat.settings.compactOff");
  };
  const compacts = () => {
    const current = props.history;
    return current === undefined ? fallback().mode === "compact" : current.mode === "compact";
  };
  const thresholds = () => {
    const current = props.history;
    const counts = [...THRESHOLD_PRESETS];
    const chosen = current?.mode === "compact" && current.threshold ? Math.round(current.threshold / 1000) : null;
    if (chosen !== null && !counts.includes(chosen)) counts.push(chosen);
    return [
      { value: "", label: t("chat.settings.default", { choice: compactFallback() }) },
      { value: "off", label: t("chat.settings.compactOff") },
      ...counts
        .sort((a, b) => a - b)
        .map((k) => ({ value: String(k * 1000), label: t("chat.settings.compactAt", { count: k }) })),
    ];
  };
  const threshold = () => {
    const current = props.history;
    if (current?.mode !== "compact") return "";
    if (current.auto === false) return "off";
    return current.threshold ? String(current.threshold) : "";
  };
  const setCompaction = (value: string) => {
    const current = props.history;
    // The chat compacts by default: choosing a threshold names that mode.
    if (value === "") props.onChange(current === undefined ? undefined : { mode: "compact" });
    else if (value === "off") props.onChange({ mode: "compact", auto: false });
    else props.onChange({ mode: "compact", auto: true, threshold: Number(value) });
  };

  return (
    <>
      <Stack gap="xs">
        <Select
          label={t("chat.settings.history")}
          value={history()}
          options={histories()}
          onChange={(n) =>
            props.onChange(
              n === "" ? undefined : n === "compact" ? { mode: "compact" } : { mode: "recent", messages: Number(n) },
            )
          }
        />
        <Text tone="muted" variant="body-sm">
          {t(history() === "0" ? "chat.settings.historyNoneNote" : "chat.settings.historyNote")}
        </Text>
      </Stack>
      <Show when={compacts()}>
        <Stack gap="xs">
          <Select
            label={t("chat.settings.compact")}
            value={threshold()}
            options={thresholds()}
            onChange={setCompaction}
          />
          <Text tone="muted" variant="body-sm">
            {t("chat.settings.compactNote")}
          </Text>
        </Stack>
      </Show>
    </>
  );
}

/**
 * What the model keeps for the chat (D-117): shown as plain text, since the
 * model writes it and a page it read may have steered it, and clearable.
 */
function MemoryField(props: { read: () => Promise<string | null>; clear: () => Promise<void> }): JSX.Element {
  const { t } = useI18n();
  const toasts = useToasts();
  const [memory, setMemory] = createSignal<string | null | undefined>(undefined);
  const [failed, setFailed] = createSignal(false);
  props.read().then(setMemory, () => setFailed(true));
  const clear = () =>
    props.clear().then(
      () => {
        setFailed(false);
        setMemory(null);
      },
      () => toasts.show(t("chat.settings.memoryClearFailed"), "danger"),
    );
  return (
    <Stack gap="xs">
      <Text variant="label-md">{t("chat.settings.memory")}</Text>
      <Show
        when={memory()}
        fallback={
          <Text tone="muted" variant="body-sm">
            {t(failed() ? "chat.settings.memoryUnreadable" : "chat.settings.memoryNone")}
          </Text>
        }
      >
        {(text) => <For each={text().split("\n")}>{(line) => <Text variant="body-sm">{line}</Text>}</For>}
      </Show>
      <Text tone="muted" variant="body-sm">
        {t("chat.settings.memoryNote")}
      </Text>
      <Show when={memory() || failed()}>
        <Stack direction="row">
          <Button icon="delete" onClick={() => void clear()}>
            {t("chat.settings.memoryClear")}
          </Button>
        </Stack>
      </Show>
    </Stack>
  );
}

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
    const history = settings.history;
    if (history?.mode === "recent") {
      parts.push(
        history.messages === 0
          ? t("chat.settings.historyNoneShort")
          : t("chat.settings.messages", { count: history.messages }),
      );
    } else if (history?.mode === "compact" && history.auto === false) parts.push(t("chat.settings.compactNone"));
    else if (history?.mode === "compact" && history.threshold)
      parts.push(t("chat.settings.compactShort", { count: Math.round(history.threshold / 1000) }));
    return parts.join(" · ");
  };
}

export function ChatSettingsDialog(props: {
  open: boolean;
  settings: ChatSettings;
  onChange: (settings: ChatSettings) => void;
  onClose: () => void;
  /** "Compact now", for a chat that exists and runs no turn. */
  onCompact?: (() => void) | undefined;
  /** The memory of a chat that exists. */
  memory?: { read: () => Promise<string | null>; clear: () => Promise<void> } | undefined;
}): JSX.Element {
  const { t } = useI18n();
  const { providers } = useAgent();
  const chats = useChats();
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
        <HistoryFields
          closable
          history={draft().history}
          inherited={chats.defaults().history}
          onChange={(history) => set("history", history)}
        />
        <Show when={props.open && props.memory} keyed>
          {(memory) => <MemoryField read={memory.read} clear={memory.clear} />}
        </Show>
        <Show when={props.onCompact}>
          {(compact) => (
            <Stack direction="row">
              <Button icon="compress" onClick={() => compact()()}>
                {t("chat.settings.compactNow")}
              </Button>
            </Stack>
          )}
        </Show>
      </Stack>
    </Dialog>
  );
}
