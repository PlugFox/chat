import { createResource, type JSX } from "solid-js";
import { TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { KeyVault } from "../../vault/keys";

export interface RecoveryInputProps {
  vault: KeyVault;
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onInput: (value: string) => void;
  /** The whole key (12 words) rather than one word: completion works on the word being typed. */
  phrase?: boolean;
}

/** The word being typed: the last one, unless a space already ended it. */
function typing(value: string): string {
  return /\s$/.test(value) ? "" : (value.split(/\s+/).at(-1) ?? "");
}

/** A recovery-word input with completion from the word list (docs/crypto.md, "Recovery key"). */
export function RecoveryInput(props: RecoveryInputProps): JSX.Element {
  const { t } = useI18n();
  const [completions] = createResource(
    () => typing(props.value).toLowerCase(),
    (prefix) => (prefix ? props.vault.completeWord(prefix) : Promise.resolve([])),
    { initialValue: [] },
  );
  // A word typed out in full needs no suggestion.
  const suggestions = () => {
    const list = completions.latest;
    return list.length === 1 && list[0] === typing(props.value).toLowerCase() ? [] : list;
  };
  const pick = (word: string) => {
    const head = props.value.slice(0, props.value.length - typing(props.value).length);
    props.onInput(props.phrase ? `${head}${word} ` : word);
  };

  return (
    <TextField
      label={props.label}
      {...(props.hint ? { hint: props.hint } : {})}
      {...(props.error ? { error: props.error } : {})}
      mono
      required
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      suggestions={suggestions()}
      suggestionsLabel={t("keys.recovery.suggestions")}
      onSuggestion={pick}
    />
  );
}
