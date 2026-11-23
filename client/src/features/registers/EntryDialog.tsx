/**
 * A new entry of a metric, or a change to one: the value in the metric's
 * unit, the moment on the clock where it was recorded (an entry from
 * another time zone keeps its own), and a comment.
 */
import { createSignal, createUniqueId, type JSX } from "solid-js";
import { useToasts } from "../../app/toasts";
import { Button, Dialog, Stack, TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { Metric } from "../../protocol/generated/protocol";
import { checkValue, deviceOffset, formatValue, parseValue, wallClock } from "../../registers/catalog";
import { COMMENT_MAX } from "../../registers/records";
import { Conflict, type OpenedEntry, type Registers } from "../../registers/registers";
import { requestError } from "../chats/errors";
import { metricName, unitLabel } from "./format";

/** `YYYY-MM-DDTHH:mm` of a wall clock held as a UTC date. */
function inputValue(clock: Date): string {
  return clock.toISOString().slice(0, 16);
}

/** The moment a typed wall clock names: at `tz` when the entry has one, else on this device. */
function moment(text: string, tz: number | null): { occurredAt: number; tz: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
  if (tz === null) {
    const local = new Date(text);
    if (Number.isNaN(local.getTime())) return null;
    return { occurredAt: Math.floor(local.getTime() / 1000), tz: deviceOffset(local) };
  }
  const clock = Date.parse(`${text}Z`);
  if (Number.isNaN(clock)) return null;
  return { occurredAt: clock / 1000 - tz * 60, tz };
}

export function EntryDialog(props: {
  registers: Registers;
  metric: Metric;
  /** The entry to change; a new one without it. */
  entry: OpenedEntry | null;
  onClose: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const form = createUniqueId();
  const existing = props.entry?.value.kind === "value" ? props.entry.value : null;
  const now = new Date();
  const [value, setValue] = createSignal(existing ? String(existing.value) : "");
  const [when, setWhen] = createSignal(
    props.entry && existing
      ? inputValue(wallClock(props.entry.info.occurred_at, existing.tz))
      : inputValue(new Date(now.getTime() + deviceOffset(now) * 60_000)),
  );
  const [comment, setComment] = createSignal(existing?.comment ?? "");
  const [valueError, setValueError] = createSignal<string>();
  const [whenError, setWhenError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);

  const unit = unitLabel(props.metric.unit, t);
  const name = metricName(props.metric, locale());

  const check = (): number | null => {
    const parsed = parseValue(value());
    if (parsed === null) {
      setValueError(t("registers.invalid.number"));
      return null;
    }
    const problem = checkValue(props.metric, parsed);
    setValueError(
      problem === "integer"
        ? t("registers.invalid.integer")
        : problem === "precision"
          ? t("registers.invalid.precision", { places: props.metric.precision })
          : problem === "range"
            ? t("registers.invalid.range", {
                min: formatValue(props.metric, props.metric.min, locale()),
                max: formatValue(props.metric, props.metric.max, locale()),
              })
            : undefined,
    );
    return problem ? null : parsed;
  };

  const save = async () => {
    const number = check();
    const at = moment(when(), existing?.tz ?? null);
    setWhenError(at ? undefined : t("registers.invalid.when"));
    if (number === null || !at || saving()) return;
    setSaving(true);
    try {
      const fields = { value: number, tz: at.tz, comment: comment() };
      if (props.entry) await props.registers.update(props.entry, at.occurredAt, fields);
      else await props.registers.create(props.metric.key, at.occurredAt, fields);
      props.onClose();
    } catch (e) {
      if (e instanceof Conflict) {
        toasts.show(t("registers.conflict"), "danger");
        props.onClose();
      } else {
        toasts.show(t(requestError(e)), "danger");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      persistent
      title={t(props.entry ? "registers.editTitle" : "registers.addTitle", { metric: name })}
      closeLabel={t("common.close")}
      onClose={() => props.onClose()}
      actions={
        <>
          <Button onClick={() => props.onClose()}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form={form} disabled={saving()}>
            {t("registers.save")}
          </Button>
        </>
      }
    >
      <Stack
        as="form"
        gap="md"
        id={form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={unit === "" ? t("registers.value") : t("registers.valueIn", { unit })}
          value={value()}
          inputmode={props.metric.value_type === "integer" ? "numeric" : "decimal"}
          autocomplete="off"
          required
          error={valueError()}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            if (valueError()) check();
          }}
        />
        <TextField
          type="datetime-local"
          label={t("registers.when")}
          value={when()}
          required
          error={whenError()}
          onInput={(e) => setWhen(e.currentTarget.value)}
        />
        <TextField
          label={t("registers.comment")}
          hint={t("registers.commentHint")}
          value={comment()}
          maxLength={COMMENT_MAX}
          autocomplete="off"
          onInput={(e) => setComment(e.currentTarget.value)}
        />
      </Stack>
    </Dialog>
  );
}
