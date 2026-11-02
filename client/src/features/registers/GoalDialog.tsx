/**
 * A metric's goal (D-124): the value to reach, the wished change per month, or
 * both, in the metric's unit. Clearing both removes the goal.
 */
import { createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { useToasts } from "../../app/toasts";
import { Button, Dialog, Stack, TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { Metric } from "../../protocol/generated/protocol";
import { checkValue, deviceOffset, formatValue, parseValue } from "../../registers/catalog";
import type { Goal } from "../../registers/goals";
import type { Registers } from "../../registers/registers";
import { requestError } from "../chats/errors";
import { metricName, unitLabel } from "./format";

export function GoalDialog(props: { registers: Registers; metric: Metric; onClose: () => void }): JSX.Element {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const form = createUniqueId();
  const existing = props.registers.goal(props.metric.key);
  const [target, setTarget] = createSignal(existing?.target === undefined ? "" : String(existing.target));
  const [delta, setDelta] = createSignal(existing?.delta === undefined ? "" : String(existing.delta));
  const [targetError, setTargetError] = createSignal<string>();
  const [deltaError, setDeltaError] = createSignal<string>();
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
    const nextTarget = target().trim() === "" ? undefined : parseValue(target());
    const nextDelta = delta().trim() === "" ? undefined : parseValue(delta());
    const range = t("registers.invalid.range", {
      min: formatValue(props.metric, props.metric.min, locale()),
      max: formatValue(props.metric, props.metric.max, locale()),
    });
    const badTarget =
      nextTarget === null
        ? t("registers.invalid.number")
        : nextTarget !== undefined && checkValue(props.metric, nextTarget) !== null
          ? range
          : undefined;
    const span = props.metric.max - props.metric.min;
    const badDelta =
      nextDelta === null
        ? t("registers.invalid.number")
        : nextDelta !== undefined && Math.abs(nextDelta) > span
          ? t("registers.goal.deltaRange", { max: formatValue(props.metric, span, locale()) })
          : undefined;
    setTargetError(badTarget);
    setDeltaError(badDelta);
    if (badTarget || badDelta || nextTarget === null || nextDelta === null) return;
    if (nextTarget === undefined && nextDelta === undefined) return void store(null);
    const now = new Date();
    const today = new Date(now.getTime() + deviceOffset(now) * 60_000).toISOString().slice(0, 10);
    // A new pace counts from today; a changed target leaves the pace where it started.
    const since = existing && existing.delta === nextDelta ? existing.since : today;
    return void store({
      since,
      ...(nextTarget === undefined ? {} : { target: nextTarget }),
      ...(nextDelta === undefined ? {} : { delta: nextDelta }),
    });
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
          label={unit === "" ? t("registers.goal.deltaLabel") : t("registers.goal.deltaIn", { unit })}
          value={delta()}
          inputmode="text"
          autocomplete="off"
          error={deltaError()}
          onInput={(e) => setDelta(e.currentTarget.value)}
        />
      </Stack>
    </Dialog>
  );
}
