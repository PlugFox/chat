/**
 * How a grant or a reply's tool call reads (D-099): built from this client's
 * own catalog and the days the request names, never from server text.
 */
import type { useI18n } from "../../i18n/i18n";
import type { Metric, Outcome, ToolUse } from "../../protocol/generated/protocol";
import { dayLabel, metricName } from "../registers/format";

type T = ReturnType<typeof useI18n>["t"];

export function daysText(t: T, locale: string, from?: string, to?: string): string {
  if (from && to && from === to) return dayLabel(from, locale);
  if (from && to) return t("permissions.days.range", { from: dayLabel(from, locale), to: dayLabel(to, locale) });
  if (from) return t("permissions.days.from", { from: dayLabel(from, locale) });
  if (to) return t("permissions.days.to", { to: dayLabel(to, locale) });
  return t("permissions.days.all");
}

/** A metric's name in the locale, its key until the catalog is loaded. */
export function metricLabel(key: string, metric: Metric | undefined, locale: string): string {
  return metric ? metricName(metric, locale) : key;
}

/** What a tool call read, without its outcome. */
export function toolWhat(t: T, locale: string, use: ToolUse, metric: Metric | undefined): string {
  switch (use.tool) {
    case "list_metrics":
      return t("tools.list_metrics");
    case "session_context":
      return t("tools.session_context");
    case "read_history":
      return use.outcome === "answered" && use.count !== undefined
        ? t("tools.read_history_count", { count: use.count })
        : t("tools.read_history");
    case "read_file":
      return t("tools.read_file");
    case "web_fetch":
      return t("tools.web_fetch", { host: use.host ?? "" });
    case "run_code":
      return t("tools.run_code");
    case "write_memory":
      return t("tools.write_memory");
    case "get_weather":
      return t("tools.get_weather");
    case "add_measurement":
      return t("tools.add_measurement", { metric: metricLabel(use.metric ?? "", metric, locale) });
    case "read_register":
      return t("tools.read_register", {
        metric: metricLabel(use.metric ?? "", metric, locale),
        days: daysText(t, locale, use.from, use.to),
      });
    default:
      return t("tools.other", { tool: use.tool });
  }
}

const ICONS: Record<Outcome | "waiting", string> = {
  approved: "check",
  denied: "block",
  refused: "block",
  timeout: "schedule",
  cancelled: "close",
  answered: "info",
  waiting: "hourglass_empty",
};

/** One line of a reply's tool calls: what was read and how the request ended. */
export function toolLine(
  t: T,
  locale: string,
  use: ToolUse,
  metric: Metric | undefined,
): { icon: string; text: string } {
  const what = toolWhat(t, locale, use, metric);
  if (use.outcome === undefined && use.tool === "run_code") {
    return { icon: ICONS.waiting, text: `${what} · ${t("tools.outcome.running")}` };
  }
  if (use.outcome === undefined && (use.tool === "read_history" || use.tool === "read_file")) {
    // The app answers it, not the user.
    return { icon: ICONS.waiting, text: `${what} · ${t("tools.outcome.reading")}` };
  }
  const outcome = use.outcome ?? "waiting";
  if (outcome === "answered") return { icon: ICONS.answered, text: what };
  return { icon: ICONS[outcome], text: `${what} · ${t(`tools.outcome.${outcome}`)}` };
}
