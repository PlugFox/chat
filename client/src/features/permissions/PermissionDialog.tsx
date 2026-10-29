/**
 * The permission dialog (docs/protocol.md, "Permissions and the access log";
 * D-099): the oldest waiting request of this auth session, wherever the user
 * is. Everything it names comes from this client's own data: the metric
 * from its catalog, the days from the grant, the chat's title and the
 * provider's host from its own records; the model's reason is quoted as its
 * words. Closing it denies. A request whose provider this client does not
 * hold cannot be allowed, and a newly shown request takes a moment before
 * it can be, so a click meant for the one before cannot allow it.
 */
import { createEffect, createSignal, type JSX, on, onCleanup, Show } from "solid-js";
import { host } from "../../agent/agent";
import { useAgent } from "../../agent/context";
import { usePermissions } from "../../agent/permissions-context";
import { useChats } from "../../chats/context";
import { Banner, Button, Dialog, List, ListItem, Quote, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
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

  const what = (): string => {
    const grant = current()?.request.grant;
    if (!grant) return "";
    if (grant.tool === "session_context") return t("permissions.session");
    // Answered without a dialog; named only to keep the cases whole.
    if (grant.tool === "read_history") return t("tools.read_history");
    if (grant.tool === "read_file") return t("tools.read_file");
    return metricLabel(grant.metric, permissions.metric(grant.metric), locale());
  };
  const days = (): string[] => {
    const grant = current()?.request.grant;
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
    if (!id || busy() || (approve && (settling() || provider() === null))) return;
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
    <Dialog
      open={current() !== undefined}
      title={t("permissions.title")}
      closeLabel={t("permissions.close")}
      onClose={() => void answer(false)}
      actions={
        <>
          <Button variant="ghost" disabled={busy()} onClick={() => void answer(false)}>
            {t("permissions.deny")}
          </Button>
          <Button
            variant="primary"
            disabled={busy() || settling() || provider() === null}
            onClick={() => void answer(true)}
          >
            {t("permissions.approve")}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text measure>
          {chat() === null ? t("permissions.introNoChat") : t("permissions.intro", { chat: chat() ?? "" })}
        </Text>
        <List label={t("tools.label")}>
          <ListItem title={what()} details={days()} />
        </List>
        <Quote label={t("permissions.reason")}>{reason()}</Quote>
        <Show when={provider()} fallback={<Banner tone="danger">{t("permissions.noHost")}</Banner>}>
          {(h) => <Banner tone="warning">{t("permissions.host", { host: h() })}</Banner>}
        </Show>
        <Show when={failed()}>
          <Banner tone="danger">{t("permissions.failed")}</Banner>
        </Show>
        <Show when={permissions.pending().length > 1}>
          <Text tone="muted">{t("permissions.more", { count: permissions.pending().length - 1 })}</Text>
        </Show>
      </Stack>
    </Dialog>
  );
}
