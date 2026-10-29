/**
 * The LLM providers (docs/protocol.md, "Settings"; D-086): a list with the
 * one turns use, edited in a dialog. Changing them needs this tab unlocked.
 */
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { type AgentState, activeProvider, host } from "../../agent/agent";
import { useAgent } from "../../agent/context";
import { parsePastedProvider, providerUrl } from "../../agent/share";
import { useToasts } from "../../app/toasts";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  List,
  ListItem,
  QrCode,
  Section,
  Select,
  Stack,
  Text,
  TextField,
} from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages/en";
import type { ProviderKind, StoredProvider } from "../../protocol/generated/protocol";

type Preset = "openai" | "anthropic" | "openrouter" | "ollama" | "other";

const PRESETS: Record<Exclude<Preset, "other">, { name: string; kind: ProviderKind; base_url: string }> = {
  openai: { name: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1" },
  anthropic: { name: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com" },
  openrouter: { name: "OpenRouter", kind: "openai_compatible", base_url: "https://openrouter.ai/api/v1" },
  ollama: { name: "Ollama", kind: "openai_compatible", base_url: "http://localhost:11434/v1" },
};

function validUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

type Draft = Omit<StoredProvider, "id">;

function ProviderForm(props: {
  initial?: StoredProvider | undefined;
  busy: boolean;
  onSave: (draft: Draft) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [preset, setPreset] = createSignal<Preset>("openai");
  const [draft, setDraft] = createSignal<Draft>(props.initial ?? { ...PRESETS.openai, api_key: "", model: "" });
  const [tried, setTried] = createSignal(false);
  const [pasted, setPasted] = createSignal<"filled" | "invalid" | null>(null);
  const set = (change: Partial<Draft>) => setDraft({ ...draft(), ...change });
  const paste = (input: HTMLInputElement) => {
    if (input.value.trim() === "") {
      setPasted(null);
      return;
    }
    const shared = parsePastedProvider(input.value);
    if (!shared) {
      setPasted("invalid");
      return;
    }
    // The key goes to its own masked field; the link holding it does not stay on screen.
    input.value = "";
    setPreset("other");
    setDraft(shared);
    setPasted("filled");
  };
  const choose = (p: Preset) => {
    setPreset(p);
    if (p !== "other") set(PRESETS[p]);
  };
  const errors = () => {
    const d = draft();
    return {
      name: d.name.trim() ? undefined : t("providers.form.required"),
      base_url: validUrl(d.base_url.trim()) ? undefined : t("providers.form.badUrl"),
      model: d.model.trim() ? undefined : t("providers.form.required"),
    };
  };
  const shown = (field: "name" | "base_url" | "model") => (tried() ? errors()[field] : undefined);
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    setTried(true);
    const d = draft();
    if (Object.values(errors()).some(Boolean)) return;
    props.onSave({ ...d, name: d.name.trim(), base_url: d.base_url.trim(), model: d.model.trim() });
  };

  return (
    <Dialog
      open
      title={props.initial ? t("providers.form.editTitle") : t("providers.form.addTitle")}
      closeLabel={t("common.close")}
      onClose={props.onClose}
    >
      <Stack as="form" gap="md" onSubmit={submit}>
        <Show when={!props.initial}>
          <Select
            label={t("providers.form.preset")}
            value={preset()}
            options={[
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
              { value: "openrouter", label: "OpenRouter" },
              { value: "ollama", label: "Ollama" },
              { value: "other", label: t("providers.form.presetOther") },
            ]}
            onChange={choose}
          />
          <TextField
            label={t("providers.form.link")}
            hint={pasted() === "filled" ? t("providers.form.linkFilled") : t("providers.form.linkHint")}
            error={pasted() === "invalid" ? t("providers.form.linkInvalid") : undefined}
            mono
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => paste(e.currentTarget)}
          />
        </Show>
        <TextField
          label={t("providers.form.name")}
          value={draft().name}
          error={shown("name")}
          onInput={(e) => set({ name: e.currentTarget.value })}
        />
        <Select
          label={t("providers.form.kind")}
          value={draft().kind}
          options={[
            { value: "openai_compatible", label: t("providers.kind.openai_compatible") },
            { value: "anthropic", label: t("providers.kind.anthropic") },
          ]}
          onChange={(kind) => set({ kind })}
        />
        <TextField
          label={t("providers.form.baseUrl")}
          hint={t("providers.form.baseUrlHint")}
          mono
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck={false}
          value={draft().base_url}
          error={shown("base_url")}
          onInput={(e) => set({ base_url: e.currentTarget.value })}
        />
        <TextField
          label={t("providers.form.apiKey")}
          hint={props.initial ? t("providers.form.apiKeyEditHint") : t("providers.form.apiKeyHint")}
          mono
          type="password"
          autocomplete="off"
          spellcheck={false}
          value={draft().api_key}
          onInput={(e) => set({ api_key: e.currentTarget.value })}
        />
        <TextField
          label={t("providers.form.model")}
          hint={t("providers.form.modelHint")}
          mono
          autocomplete="off"
          spellcheck={false}
          value={draft().model}
          error={shown("model")}
          onInput={(e) => set({ model: e.currentTarget.value })}
        />
        <Stack direction="row" wrap gap="sm">
          <Button type="submit" variant="primary" disabled={props.busy}>
            {t("common.save")}
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}

/**
 * A provider as a link to scan or copy (D-098). The link is made when asked
 * for, after the warning, and holds the API key unless it is left out.
 */
function ShareDialog(props: { provider: StoredProvider; onClose: () => void }): JSX.Element {
  const { t } = useI18n();
  const toasts = useToasts();
  const hasKey = props.provider.api_key !== "";
  const [withKey, setWithKey] = createSignal(hasKey);
  const [qr, setQr] = createSignal<string | null>(null);
  const url = () => providerUrl(location.origin, props.provider, withKey());
  const copy = () =>
    navigator.clipboard.writeText(url()).then(
      () => toasts.show(t("providers.share.copied")),
      () => toasts.show(t("providers.share.copyFailed"), "danger"),
    );

  return (
    <Dialog
      open
      title={t("providers.share.title", { name: props.provider.name })}
      closeLabel={t("common.close")}
      onClose={props.onClose}
    >
      <Stack gap="md">
        <Text measure>{t("providers.share.intro")}</Text>
        <Banner tone="warning">{t(withKey() ? "providers.share.warningKey" : "providers.share.warningNoKey")}</Banner>
        <Show when={hasKey}>
          <Checkbox
            label={t("providers.share.withKey")}
            hint={t("providers.share.withKeyHint")}
            checked={withKey()}
            onChange={(checked) => {
              setWithKey(checked);
              setQr(null);
            }}
          />
        </Show>
        <Show when={qr()}>
          {(value) => (
            <>
              <QrCode value={value()} label={t("providers.share.qr")} />
              <Text tone="muted" measure>
                {t("providers.share.scan")}
              </Text>
            </>
          )}
        </Show>
        <Stack direction="row" wrap gap="sm">
          <Show when={!qr()}>
            <Button variant="primary" icon="qr_code" onClick={() => setQr(url())}>
              {t("providers.share.show")}
            </Button>
          </Show>
          <Button icon="content_copy" onClick={() => void copy()}>
            {t("providers.share.copy")}
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            {t("common.close")}
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}

function agentNotice(kind: AgentState["kind"]): { tone: "warning" | "danger"; key: MessageKey } | undefined {
  if (kind === "refused") return { tone: "danger", key: "providers.agent.refused" };
  if (kind === "failed") return { tone: "warning", key: "providers.agent.failed" };
  return undefined;
}

export function ProvidersSection(): JSX.Element {
  const { t } = useI18n();
  const { providers, agent, update } = useAgent();
  const [editing, setEditing] = createSignal<StoredProvider | "new" | null>(null);
  const [removing, setRemoving] = createSignal<StoredProvider | null>(null);
  const [sharing, setSharing] = createSignal<StoredProvider | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const ready = () => {
    const p = providers();
    return p?.kind === "ready" ? p : null;
  };
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (draft: Draft) => {
    const target = editing();
    const id = target && target !== "new" ? target.id : crypto.randomUUID();
    const done = await run(() =>
      update((v) => {
        const providers = v.providers.some((p) => p.id === id)
          ? v.providers.map((p) => (p.id === id ? { id, ...draft } : p))
          : [...v.providers, { id, ...draft }];
        // The first provider is the one turns use.
        return { providers, active: v.active ?? id };
      }),
    );
    if (done) setEditing(null);
  };
  const use = (id: string) => void run(() => update((v) => ({ ...v, active: id })));
  const remove = async (target: StoredProvider) => {
    const done = await run(() =>
      update((v) => {
        const providers = v.providers.filter((p) => p.id !== target.id);
        return v.active === target.id || v.active === undefined ? { providers } : { providers, active: v.active };
      }),
    );
    if (done) setRemoving(null);
  };
  const notice = () => agentNotice(agent().kind);

  return (
    <Section title={t("providers.title")}>
      <Switch>
        <Match when={providers() === null}>
          <Text tone="muted">{t("providers.locked")}</Text>
        </Match>
        <Match when={providers()?.kind === "failed"}>
          <Banner tone="danger">{t("providers.loadFailed")}</Banner>
        </Match>
        <Match when={ready()}>
          {(state) => (
            <>
              <Text measure>{t("providers.intro")}</Text>
              <Show when={failed()}>
                <Banner tone="danger">{t("providers.saveFailed")}</Banner>
              </Show>
              <Show when={state().value.providers.length > 0 && !activeProvider(state())}>
                <Banner tone="warning">{t("providers.noneActive")}</Banner>
              </Show>
              <Show when={notice()}>{(n) => <Banner tone={n().tone}>{t(n().key)}</Banner>}</Show>
              <Show
                when={state().value.providers.length > 0}
                fallback={<Text tone="muted">{t("providers.empty")}</Text>}
              >
                <List label={t("providers.list")}>
                  <For each={state().value.providers}>
                    {(p) => (
                      <ListItem
                        title={p.name}
                        badge={p.id === state().value.active ? t("providers.active") : undefined}
                        details={[t(`providers.kind.${p.kind}`), `${host(p.base_url)} · ${p.model}`]}
                        actions={
                          <>
                            <Show when={p.id !== state().value.active}>
                              <Button
                                variant="ghost"
                                disabled={busy()}
                                aria-label={t("providers.useLabel", { name: p.name })}
                                onClick={() => use(p.id)}
                              >
                                {t("providers.use")}
                              </Button>
                            </Show>
                            <Button
                              variant="ghost"
                              icon="edit"
                              disabled={busy()}
                              aria-label={t("providers.editLabel", { name: p.name })}
                              onClick={() => setEditing(p)}
                            >
                              {t("providers.edit")}
                            </Button>
                            <Button
                              variant="ghost"
                              icon="qr_code"
                              aria-label={t("providers.shareLabel", { name: p.name })}
                              onClick={() => setSharing(p)}
                            >
                              {t("providers.share")}
                            </Button>
                            <Button
                              variant="ghost"
                              icon="delete"
                              disabled={busy()}
                              aria-label={t("providers.removeLabel", { name: p.name })}
                              onClick={() => setRemoving(p)}
                            >
                              {t("providers.remove")}
                            </Button>
                          </>
                        }
                      />
                    )}
                  </For>
                </List>
              </Show>
              <Stack direction="row">
                <Button icon="add" disabled={busy()} onClick={() => setEditing("new")}>
                  {t("providers.add")}
                </Button>
              </Stack>
              <Show when={editing()}>
                {(target) => (
                  <ProviderForm
                    initial={target() === "new" ? undefined : (target() as StoredProvider)}
                    busy={busy()}
                    onSave={(draft) => void save(draft)}
                    onClose={() => setEditing(null)}
                  />
                )}
              </Show>
              <Show when={sharing()}>
                {(target) => <ShareDialog provider={target()} onClose={() => setSharing(null)} />}
              </Show>
              <Show when={removing()}>
                {(target) => (
                  <Dialog
                    open
                    title={t("providers.removeTitle", { name: target().name })}
                    closeLabel={t("common.close")}
                    onClose={() => setRemoving(null)}
                  >
                    <Stack gap="md">
                      <Text measure>{t("providers.removeIntro")}</Text>
                      <Stack direction="row" wrap gap="sm">
                        <Button variant="danger" disabled={busy()} onClick={() => void remove(target())}>
                          {t("providers.remove")}
                        </Button>
                        <Button variant="ghost" onClick={() => setRemoving(null)}>
                          {t("common.cancel")}
                        </Button>
                      </Stack>
                    </Stack>
                  </Dialog>
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </Section>
  );
}
