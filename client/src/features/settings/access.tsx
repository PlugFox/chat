/**
 * The access log (docs/protocol.md, "Permissions and the access log";
 * D-099): every request of the agent to read the user's data, newest first,
 * with how it ended; the model's reason opens on demand. Needs this tab
 * unlocked, for the metric names, the chats' titles and the reasons.
 */
import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import {
  readCodeRequest,
  readGoalProposal,
  readProposal,
  readWeatherRequest,
  readWebRequest,
} from "../../agent/permissions";
import { usePermissions } from "../../agent/permissions-context";
import { useChats } from "../../chats/context";
import { Banner, Button, Dialog, List, ListItem, Quote, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { AccessEntry } from "../../protocol/generated/protocol";
import { useSocket } from "../../transport/context";
import { useVault } from "../../vault/context";
import { daysText, metricLabel } from "../permissions/labels";

export function AccessSection(): JSX.Element {
  const { t, locale } = useI18n();
  const { socket, state: connection } = useSocket();
  const { vault, state: keys } = useVault();
  const permissions = usePermissions();
  const chats = useChats();
  const [entries, setEntries] = createSignal<AccessEntry[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [reason, setReason] = createSignal<string | null>(null);
  const unlocked = () => keys()?.kind === "unlocked";

  const load = async (before: string | null) => {
    const s = socket();
    if (!s) return;
    setFailed(false);
    try {
      const page = await s.request("access_log.list", before ? { before } : {}, { retry: "resend" });
      setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
      setNext(page.next ?? null);
      setLoaded(true);
    } catch {
      setFailed(true);
    }
  };

  createEffect(
    on(
      () => unlocked() && connection()?.kind === "open",
      (ready) => {
        if (ready) void load(null);
      },
    ),
  );

  const what = (entry: AccessEntry) => {
    const grant = entry.grant;
    if (grant.tool === "session_context") return t("permissions.session");
    if (grant.tool === "read_history") return t("permissions.history", { count: grant.count });
    if (grant.tool === "read_file") return t("permissions.file");
    if (grant.tool === "web_fetch") return t("permissions.web");
    if (grant.tool === "run_code") return t("tools.run_code");
    if (grant.tool === "get_weather") return t("permissions.weather");
    if (grant.tool === "set_goal") {
      return t("tools.set_goal", { metric: metricLabel(grant.metric, permissions.metric(grant.metric), locale()) });
    }
    if (grant.tool === "add_measurement") {
      return t("tools.add_measurement", {
        metric: metricLabel(grant.metric, permissions.metric(grant.metric), locale()),
      });
    }
    const name = metricLabel(grant.metric, permissions.metric(grant.metric), locale());
    return `${name}, ${daysText(t, locale(), grant.from, grant.to)}`;
  };
  /** The chat, when this tab has it loaded: a chat not among those may be gone or just not loaded. */
  const chat = (entry: AccessEntry): string[] => {
    const known = chats.list()?.get(entry.chat_id);
    if (!known) return [];
    return [t("settings.access.chat", { chat: known.title.kind === "text" ? known.title.text : t("chats.untitled") })];
  };
  const date = (ms: number) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(ms);
  const showReason = async (entry: AccessEntry) => {
    const v = vault();
    if (!v) return;
    try {
      const opened = await v.openAuditReason(entry.id, entry.reason);
      if (entry.grant.tool === "set_goal") {
        const proposal = readGoalProposal(opened);
        setReason(
          proposal?.reason.trim()
            ? proposal.reason
            : t(proposal ? "permissions.noReason" : "permissions.unreadableReason"),
        );
        return;
      }
      if (entry.grant.tool === "add_measurement") {
        const proposal = readProposal(opened);
        if (!proposal) {
          setReason(t("permissions.unreadableReason"));
          return;
        }
        const text = proposal.reason;
        setReason(text.trim() === "" ? t("permissions.noReason") : text);
        return;
      }
      if (entry.grant.tool === "get_weather") {
        const place = readWeatherRequest(opened);
        setReason(place ? `${place.reason}\n\n${place.city}, ${place.country}` : t("permissions.unreadableReason"));
        return;
      }
      if (entry.grant.tool === "web_fetch" || entry.grant.tool === "run_code") {
        const web = entry.grant.tool === "web_fetch" ? readWebRequest(opened) : null;
        const code = entry.grant.tool === "run_code" ? readCodeRequest(opened) : null;
        const body = web?.url ?? code?.code;
        const why = web?.reason ?? code?.reason ?? "";
        setReason(body === undefined ? t("permissions.unreadableReason") : why === "" ? body : `${why}\n\n${body}`);
        return;
      }
      setReason(opened.trim() === "" ? t("permissions.noReason") : opened);
    } catch {
      setReason(t("permissions.unreadableReason"));
    }
  };

  return (
    <Show when={unlocked()} fallback={<Text tone="muted">{t("settings.access.locked")}</Text>}>
      <Text measure>{t("settings.access.note")}</Text>
      <Show when={failed()}>
        <Banner tone="danger">{t("settings.access.failed")}</Banner>
      </Show>
      <Show when={loaded() && entries().length === 0}>
        <Text tone="muted">{t("settings.access.empty")}</Text>
      </Show>
      <Show when={entries().length > 0}>
        <List label={t("settings.access")}>
          <For each={entries()}>
            {(entry) => (
              <ListItem
                title={what(entry)}
                details={[
                  date(entry.requested_at),
                  t(`settings.access.outcome.${entry.outcome ?? "waiting"}`),
                  ...chat(entry),
                ]}
                actions={
                  <Button variant="ghost" onClick={() => void showReason(entry)}>
                    {t("settings.access.reason")}
                  </Button>
                }
              />
            )}
          </For>
        </List>
      </Show>
      <Show when={next()}>
        {(before) => (
          <Button variant="ghost" onClick={() => void load(before())}>
            {t("settings.access.more")}
          </Button>
        )}
      </Show>
      <Dialog
        open={reason() !== null}
        title={t("settings.access.reason")}
        closeLabel={t("common.close")}
        onClose={() => setReason(null)}
      >
        <Quote label={t("permissions.reason")}>{reason() ?? ""}</Quote>
      </Dialog>
    </Show>
  );
}
