/**
 * The permission dialog (docs/protocol.md, "Permissions and the access log";
 * D-099): the oldest waiting request of this auth session, wherever the user
 * is. Everything it names comes from this client's own data: the metric
 * from its catalog, the days from the grant, the chat's title and the
 * provider's host from its own records; the model's reason is quoted as its
 * words. Closing it denies. A request whose provider this client does not
 * hold cannot be allowed, and a newly shown request takes a moment before
 * it can be, so a click meant for the one before cannot allow it. An entry the
 * agent proposes shows what would be stored; it sends no data, so it names no host.
 * A site shows its whole address, as an address can carry data out. The weather
 * shows the place found by IP, which is what the model and the service would learn.
 */
import { createEffect, createSignal, type JSX, on, onCleanup, Show } from "solid-js";
import { host } from "../../agent/agent";
import { useAgent } from "../../agent/context";
import { usePermissions } from "../../agent/permissions-context";
import { useChats } from "../../chats/context";
import { Banner, Button, Dialog, List, ListItem, Quote, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { dayLabel, withUnit } from "../registers/format";
import { daysText, metricLabel } from "./labels";

/** How long a newly shown request waits before it can be allowed. */
const SETTLE_MS = 600;

export function PermissionDialog(): JSX.Element {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const { providers } = useAgent();
  const chats = useChats();
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const current = () => permissions.pending()[0];
  const [settling, setSettling] = createSignal(false);
  createEffect(
    on(
      () => current()?.request.request_id,
      (id) => {
        if (!id) return;
        setSettling(true);
        const timer = setTimeout(() => setSettling(false), SETTLE_MS);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );

  const adding = () => current()?.request.grant.tool === "add_measurement";
  const web = () => current()?.web;
  const what = (): string => {
    const grant = current()?.request.grant;
    if (!grant) return "";
    if (grant.tool === "web_fetch") return web()?.host ?? "";
    if (grant.tool === "run_code") return t("tools.run_code");
    if (grant.tool === "get_weather") {
      const place = current()?.place;
      return place ? [place.city, place.country].filter((p) => p !== "").join(", ") : "";
    }
    if (grant.tool === "session_context") return t("permissions.session");
    // Answered without a dialog; named only to keep the cases whole.
    if (grant.tool === "read_history") return t("tools.read_history");
    if (grant.tool === "read_file") return t("tools.read_file");
    if (grant.tool === "add_measurement") {
      const metric = permissions.metric(grant.metric);
      const name = metricLabel(grant.metric, metric, locale());
      const value = current()?.proposal?.value;
      return metric && value !== undefined ? `${name}: ${withUnit(metric, value, locale(), t)}` : name;
    }
    return metricLabel(grant.metric, permissions.metric(grant.metric), locale());
  };
  const days = (): string[] => {
    const grant = current()?.request.grant;
    const proposal = current()?.proposal;
    const site = web();
    if (site) return [site.url];
    if (proposal) return [dayLabel(proposal.day, locale()), ...(proposal.comment === "" ? [] : [proposal.comment])];
    return grant?.tool === "read_register" ? [daysText(t, locale(), grant.from, grant.to)] : [];
  };
  /** The chat's title, when this tab has the chat loaded. */
  const chat = (): string | null => {
    const entry = chats.list()?.get(current()?.request.chat_id ?? "");
    if (!entry) return null;
    return entry.title.kind === "text" ? entry.title.text : t("chats.untitled");
  };
  /** The host the data would go to; `null` when this client does not hold the turn's provider. */
  const provider = (): string | null => {
    const p = providers();
    const id = current()?.request.provider_id;
    const entry = p?.kind === "ready" ? p.value.providers.find((e) => e.id === id) : undefined;
    return entry ? host(entry.base_url) : null;
  };
  const reason = (): string => {
    const r = current()?.reason;
    if (r === null) return t("permissions.unreadableReason");
    return r && r.trim() !== "" ? r : t("permissions.noReason");
  };

  const answer = async (approve: boolean) => {
    const id = current()?.request.request_id;
    if (!id || busy() || (approve && (settling() || (!adding() && provider() === null)))) return;
    setBusy(true);
    setFailed(false);
    try {
      await (approve ? permissions.approve(id) : permissions.deny(id));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        persistent
        open={current() !== undefined}
        title={
          current()?.place
            ? t("permissions.weatherTitle")
            : web()
              ? t("permissions.webTitle")
              : adding()
                ? t("permissions.addTitle")
                : t("permissions.title")
        }
        closeLabel={t("permissions.close")}
        onClose={() => void answer(false)}
        actions={
          <>
            <Button variant="ghost" disabled={busy()} onClick={() => void answer(false)}>
              {t("permissions.deny")}
            </Button>
            <Button
              variant="primary"
              disabled={busy() || settling() || (!adding() && provider() === null)}
              onClick={() => void answer(true)}
            >
              {adding() ? t("permissions.addApprove") : t("permissions.approve")}
            </Button>
          </>
        }
      >
        <Stack gap="md">
          <Text measure>
            {current()?.place
              ? chat() === null
                ? t("permissions.weatherIntroNoChat")
                : t("permissions.weatherIntro", { chat: chat() ?? "" })
              : web()
                ? chat() === null
                  ? t("permissions.webIntroNoChat")
                  : t("permissions.webIntro", { chat: chat() ?? "" })
                : adding()
                  ? chat() === null
                    ? t("permissions.addIntroNoChat")
                    : t("permissions.addIntro", { chat: chat() ?? "" })
                  : chat() === null
                    ? t("permissions.introNoChat")
                    : t("permissions.intro", { chat: chat() ?? "" })}
          </Text>
          <List label={adding() ? t("permissions.addLabel") : t("tools.label")}>
            <ListItem title={what()} details={days()} />
          </List>
          <Quote label={t("permissions.reason")}>{reason()}</Quote>
          <Show when={(current()?.proposal?.sameDay ?? 0) > 0}>
            <Banner tone="warning">{t("permissions.addSameDay", { count: current()?.proposal?.sameDay ?? 0 })}</Banner>
          </Show>
          <Show when={current()?.place}>
            <Banner tone="warning">{t("permissions.weatherWarning")}</Banner>
          </Show>
          <Show when={web()}>
            <Banner tone="warning">{t("permissions.webWarning")}</Banner>
          </Show>
          <Show when={!adding()}>
            <Show when={provider()} fallback={<Banner tone="danger">{t("permissions.noHost")}</Banner>}>
              {(h) => <Banner tone="warning">{t("permissions.host", { host: h() })}</Banner>}
            </Show>
          </Show>
          <Show when={failed()}>
            <Banner tone="danger">{t("permissions.failed")}</Banner>
          </Show>
          <Show when={permissions.pending().length > 1}>
            <Text tone="muted">{t("permissions.more", { count: permissions.pending().length - 1 })}</Text>
          </Show>
        </Stack>
      </Dialog>
      <Dialog
        open={current() === undefined && permissions.unstored() !== null}
        title={t("permissions.addFailedTitle")}
        closeLabel={t("common.close")}
        onClose={() => permissions.dismissUnstored()}
        actions={
          <Button variant="primary" onClick={() => void permissions.retryStore()}>
            {t("permissions.addRetry")}
          </Button>
        }
      >
        <Text measure>{t("permissions.addFailed")}</Text>
      </Dialog>
    </>
  );
}
