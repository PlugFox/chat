import { createSignal, For, type JSX, Show } from "solid-js";
import { Banner, Button, Stack, TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";

/** Three distinct positions, in order: enough to show the words were written down. */
function pick(count: number): number[] {
  const keys = crypto.getRandomValues(new Uint32Array(count));
  return Array.from({ length: count }, (_, i) => i)
    .sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0))
    .slice(0, 3)
    .sort((a, b) => a - b);
}

export interface ConfirmWordsProps {
  words: string[];
  busy: boolean;
  submit: string;
  onBack: () => void;
  onConfirm: () => void;
  /** Shown above the buttons (the "remember this device" choice at setup). */
  children?: JSX.Element;
}

/** Asks for some of the recovery words back before they become the only way in. */
export function ConfirmWords(props: ConfirmWordsProps): JSX.Element {
  const { t } = useI18n();
  const positions = pick(props.words.length);
  const [values, setValues] = createSignal<string[]>(positions.map(() => ""));
  const [checked, setChecked] = createSignal(false);
  const wrong = (i: number) => values()[i]?.trim().toLowerCase() !== props.words[positions[i] ?? 0];

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setChecked(true);
    if (positions.every((_, i) => !wrong(i))) props.onConfirm();
  };

  return (
    <Stack as="form" gap="md" onSubmit={submit}>
      <Show when={checked() && positions.some((_, i) => wrong(i))}>
        <Banner tone="danger">{t("keys.confirm.mismatch")}</Banner>
      </Show>
      <For each={positions}>
        {(position, i) => (
          <TextField
            label={t("keys.confirm.word", { n: position + 1 })}
            mono
            required
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            value={values()[i()] ?? ""}
            {...(checked() && wrong(i()) ? { error: t("keys.confirm.wrongWord") } : {})}
            onInput={(e) => {
              const next = [...values()];
              next[i()] = e.currentTarget.value;
              setValues(next);
            }}
          />
        )}
      </For>
      {props.children}
      <Stack direction="row" wrap gap="sm">
        <Button type="submit" variant="primary" disabled={props.busy}>
          {props.submit}
        </Button>
        <Button variant="ghost" disabled={props.busy} onClick={props.onBack}>
          {t("keys.confirm.back")}
        </Button>
      </Stack>
    </Stack>
  );
}
