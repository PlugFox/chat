/**
 * A metric's goal (D-124, D-126): the value to reach, the day the path to it
 * starts from, whose value is the user's own measurement then, and the day
 * to reach it by, if any. Removing it is a button of its own.
 */
import { createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { useToasts } from "../../app/toasts";
import { Button, Dialog, Stack, TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { Metric } from "../../protocol/generated/protocol";
import { checkValue, formatValue, parseValue } from "../../registers/catalog";
import type { Goal } from "../../registers/goals";
import type { Registers } from "../../registers/registers";
import { requestError } from "../chats/errors";
import { metricName, unitLabel } from "./format";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function GoalDialog(props: {
  registers: Registers;
  metric: Metric;
  /** The day to reach it by that a goal of D-124 gets from its pace and entries, which the form then stores. */
  until: string | null;
  today: string;
  onClose: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const form = createUniqueId();
  const existing = props.registers.goal(props.metric.key);
  const [target, setTarget] = createSignal(existing === undefined ? "" : String(existing.target));
  const [since, setSince] = createSignal(existing?.since ?? props.today);
  const [until, setUntil] = createSignal(existing?.until ?? props.until ?? "");
  const [targetError, setTargetError] = createSignal<string>();
  const [sinceError, setSinceError] = createSignal<string>();
  const [untilError, setUntilError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const unit = unitLabel(props.metric.unit, t);

  const store = async (goal: Goal | null) => {
    if (saving()) return;
    setSaving(true);
    try {
      await props.registers.setGoal(props.metric.key, goal);
      props.onClose();
    } catch (e) {
      toasts.show(t(requestError(e)), "danger");
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const value = target().trim() === "" ? undefined : parseValue(target());
    const badTarget =
      value === undefined
        ? t("registers.goal.targetRequired")
        : value === null
          ? t("registers.invalid.number")
          : checkValue(props.metric, value) !== null
            ? t("registers.invalid.range", {
                min: formatValue(props.metric, props.metric.min, locale()),
                max: formatValue(props.metric, props.metric.max, locale()),
              })
            : undefined;
    const start = since();
    const end = until();
    const badSince = DAY.test(start) ? undefined : t("registers.goal.sinceInvalid");
    const badUntil = end === "" || (DAY.test(end) && end > start) ? undefined : t("registers.goal.untilInvalid");
    setTargetError(badTarget);
    setSinceError(badSince);
    setUntilError(badUntil);
    if (badTarget || badSince || badUntil || value === undefined || value === null) return;
    return void store({ target: value, since: start, ...(end === "" ? {} : { until: end }) });
  };

  return (
    <Dialog
      open
      persistent
      title={t("registers.goal.title", { metric: metricName(props.metric, locale()) })}
      closeLabel={t("common.close")}
      onClose={() => props.onClose()}
      actions={
        <>
          <Show when={existing}>
            <Button variant="danger" disabled={saving()} onClick={() => void store(null)}>
              {t("registers.goal.remove")}
            </Button>
          </Show>
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
          save();
        }}
      >
        <TextField
          label={unit === "" ? t("registers.goal.targetLabel") : t("registers.goal.targetIn", { unit })}
          value={target()}
          inputmode="decimal"
          autocomplete="off"
          error={targetError()}
          onInput={(e) => setTarget(e.currentTarget.value)}
        />
        <TextField
          label={t("registers.goal.since")}
          type="date"
          value={since()}
          error={sinceError()}
          onInput={(e) => setSince(e.currentTarget.value)}
        />
        <TextField
          label={t("registers.goal.until")}
          type="date"
          value={until()}
          error={untilError()}
          onInput={(e) => setUntil(e.currentTarget.value)}
        />
      </Stack>
    </Dialog>
  );
}
