/**
 * Account sections of the settings page (docs/auth.md): sign-in methods,
 * signed-in devices, activity, sign-out and account deletion.
 */
import { useNavigate, useSearchParams } from "@solidjs/router";
import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import { AuthHttpError } from "../../auth/client";
import { useAuth } from "../../auth/context";
import { errorKey } from "../../auth/errors";
import {
  Banner,
  Button,
  Dialog,
  List,
  ListItem,
  Section,
  Stack,
  Text,
  TextField,
} from "../../design-system/components";
import { describeAgent } from "../../i18n/agent";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages/en";
import type {
  AuditEntry,
  AuditPage,
  Identities,
  IdentityInfo,
  SessionInfo,
  Sessions,
} from "../../protocol/generated/protocol";

function useFormat() {
  const { locale } = useI18n();
  return {
    date: (ms: number) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(ms),
    country: (code: string) => new Intl.DisplayNames([locale()], { type: "region" }).of(code) ?? code,
  };
}

export function IdentitiesSection(): JSX.Element {
  const { t, locale } = useI18n();
  const { client } = useAuth();
  const format = useFormat();
  const [params, setParams] = useSearchParams<{ linked?: string }>();
  const [list, { refetch }] = createResource(() => client.call<Identities>("GET", "/auth/identities"));
  const [error, setError] = createSignal<MessageKey | null>(null);
  const [notice, setNotice] = createSignal<MessageKey | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [pending, setPending] = createSignal<string | null>(null);

  const name = (identity: IdentityInfo) =>
    identity.email ?? t(identity.provider === "google" ? "settings.identity.google" : "settings.identity.email");

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorKey(e));
    }
  };

  const remove = (identity: IdentityInfo) =>
    attempt(async () => {
      await client.call("DELETE", `/auth/identities/${identity.id}`);
      await refetch();
    });

  const startEmail = (event: SubmitEvent) => {
    event.preventDefault();
    void attempt(async () => {
      setPending(await client.emailStart(email(), locale(), true));
    });
  };

  const verifyEmail = (event: SubmitEvent) => {
    event.preventDefault();
    const id = pending();
    if (!id) return;
    void attempt(async () => {
      await client.linkEmailVerify(id, email(), code());
      setPending(null);
      setAdding(false);
      setEmail("");
      setCode("");
      setNotice("settings.identity.emailAdded");
      await refetch();
    });
  };

  return (
    <Section title={t("settings.identities")} flat>
      <Show when={params.linked}>
        {(result) => (
          <Banner tone={result() === "in_use" ? "danger" : "success"}>
            {t("settings.identity.linked", { result: result() })}
          </Banner>
        )}
      </Show>
      <Show when={notice()}>{(key) => <Banner tone="success">{t(key())}</Banner>}</Show>
      <Show when={error()}>{(key) => <Banner tone="danger">{t(key())}</Banner>}</Show>
      <Show when={list()}>
        {(identities) => (
          <List label={t("settings.identities")}>
            <For each={identities().identities}>
              {(identity) => (
                <ListItem
                  title={name(identity)}
                  badge={t(identity.provider === "google" ? "settings.identity.google" : "settings.identity.email")}
                  details={[
                    t("settings.identity.added", { date: format.date(identity.created_at) }),
                    ...(identity.email_verified ? [] : [t("settings.identity.unverified")]),
                  ]}
                  actions={
                    <Show when={identities().identities.length > 1}>
                      <Button
                        variant="ghost"
                        aria-label={t("settings.identity.removeLabel", { name: name(identity) })}
                        onClick={() => void remove(identity)}
                      >
                        {t("settings.identity.remove")}
                      </Button>
                    </Show>
                  }
                />
              )}
            </For>
          </List>
        )}
      </Show>
      <Stack direction="row" wrap gap="sm">
        <Button
          icon="link"
          onClick={() => {
            setParams({ linked: undefined });
            window.location.assign("/auth/google/start?link=true");
          }}
        >
          {t("settings.identity.linkGoogle")}
        </Button>
        <Show when={!adding()}>
          <Button icon="mail" onClick={() => setAdding(true)}>
            {t("settings.identity.addEmail")}
          </Button>
        </Show>
      </Stack>
      <Show when={adding()}>
        <Show
          when={pending()}
          fallback={
            <Stack as="form" gap="md" onSubmit={startEmail}>
              <TextField
                label={t("signIn.email.label")}
                type="email"
                autocomplete="email"
                required
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
              <Stack direction="row" wrap gap="sm">
                <Button type="submit" variant="primary">
                  {t("signIn.email.send")}
                </Button>
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  {t("common.cancel")}
                </Button>
              </Stack>
            </Stack>
          }
        >
          <Stack as="form" gap="md" onSubmit={verifyEmail}>
            <TextField
              label={t("signIn.code.label")}
              hint={t("signIn.code.hint", { email: email() })}
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]{8}"
              maxLength={8}
              required
              mono
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))}
            />
            <Stack direction="row" wrap gap="sm">
              <Button type="submit" variant="primary">
                {t("common.save")}
              </Button>
              <Button variant="ghost" onClick={() => setPending(null)}>
                {t("common.cancel")}
              </Button>
            </Stack>
          </Stack>
        </Show>
      </Show>
    </Section>
  );
}

export function SessionsSection(): JSX.Element {
  const { t } = useI18n();
  const { client } = useAuth();
  const format = useFormat();
  const [list, { refetch }] = createResource(() => client.call<Sessions>("GET", "/auth/sessions"));
  const [error, setError] = createSignal<MessageKey | null>(null);

  const device = (session: SessionInfo) => {
    const agent = describeAgent(session.user_agent);
    return agent ? t("settings.session.agent", agent) : t("settings.session.unknownDevice");
  };

  const details = (session: SessionInfo) => [
    t("settings.session.signedIn", { provider: session.provider, date: format.date(session.created_at) }),
    t("settings.session.lastSeen", { date: format.date(session.last_seen_at) }),
    ...(session.country ? [format.country(session.country)] : []),
    ...(session.ip ? [t("settings.session.ip", { ip: session.ip })] : []),
  ];

  const revoke = async (session: SessionInfo) => {
    setError(null);
    try {
      await client.call("DELETE", `/auth/sessions/${session.id}`);
      await refetch();
    } catch (e) {
      setError(errorKey(e));
    }
  };

  return (
    <>
      <Show when={error()}>{(key) => <Banner tone="danger">{t(key())}</Banner>}</Show>
      <Show when={list()}>
        {(sessions) => (
          <List label={t("settings.sessions")}>
            <For each={sessions().sessions}>
              {(session) => (
                <ListItem
                  title={device(session)}
                  {...(session.current ? { badge: t("settings.session.current") } : {})}
                  details={details(session)}
                  actions={
                    <Show when={!session.current}>
                      <Button
                        variant="ghost"
                        aria-label={t("settings.session.revokeLabel", { device: device(session) })}
                        onClick={() => void revoke(session)}
                      >
                        {t("settings.session.revoke")}
                      </Button>
                    </Show>
                  }
                />
              )}
            </For>
          </List>
        )}
      </Show>
    </>
  );
}

function auditText(t: ReturnType<typeof useI18n>["t"], entry: AuditEntry): string {
  const d = entry.details;
  const provider = typeof d["provider"] === "string" ? d["provider"] : "email";
  const reason = typeof d["reason"] === "string" ? d["reason"] : "other";
  switch (entry.kind) {
    case "account.created":
      return t("audit.account.created");
    case "auth.signed_in":
      return t("audit.auth.signed_in", { provider });
    case "auth.sign_in_failed":
      return t("audit.auth.sign_in_failed");
    case "auth.code_sent":
      return t("audit.auth.code_sent");
    case "session.revoked":
      return t("audit.session.revoked", { reason });
    case "identity.linked":
      return t("audit.identity.linked", { provider });
    case "identity.unlinked":
      return t("audit.identity.unlinked", { provider });
    case "keys.setup":
      return t("audit.keys.setup");
    case "keys.wrap_added":
      return t("audit.keys.wrap_added", { method: String(d["method"] ?? "other") });
    case "keys.wrap_removed":
      return t("audit.keys.wrap_removed", { method: String(d["method"] ?? "other") });
    case "keys.recovery_rotated":
      return t("audit.keys.recovery_rotated");
    case "link.completed":
      return t("audit.link.completed");
    case "chat.created":
      return t("audit.chat.created");
    case "chat.archived":
      return t("audit.chat.archived");
    case "chat.unarchived":
      return t("audit.chat.unarchived");
    case "chat.deleted":
      return t("audit.chat.deleted");
    default:
      return t("audit.unknown");
  }
}

export function ActivitySection(): JSX.Element {
  const { t } = useI18n();
  const { client } = useAuth();
  const format = useFormat();
  const [entries, setEntries] = createSignal<AuditEntry[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const load = async (before: number | null) => {
    const query = before === null ? "" : `&before=${before}`;
    const page = await client.call<AuditPage>("GET", `/auth/audit?limit=20${query}`);
    setEntries((current) => [...current, ...page.events]);
    setNext(page.next_before);
    return page;
  };
  const [first] = createResource(() => load(null));

  return (
    <>
      <Show when={first.error}>
        <Banner tone="danger">{t(errorKey(first.error))}</Banner>
      </Show>
      <Show when={first() && entries().length === 0}>
        <Text tone="muted">{t("settings.activity.empty")}</Text>
      </Show>
      <Show when={entries().length > 0}>
        <List label={t("settings.activity")}>
          <For each={entries()}>
            {(entry) => (
              <ListItem
                title={auditText(t, entry)}
                details={[
                  format.date(entry.created_at),
                  ...(entry.country ? [format.country(entry.country)] : []),
                  ...(entry.ip ? [t("settings.session.ip", { ip: entry.ip })] : []),
                ]}
              />
            )}
          </For>
        </List>
      </Show>
      <Show when={next()}>
        {(before) => (
          <Button variant="ghost" onClick={() => void load(before())}>
            {t("settings.activity.more")}
          </Button>
        )}
      </Show>
    </>
  );
}

export function SignOutButton(): JSX.Element {
  const { t } = useI18n();
  const { client } = useAuth();
  return (
    <Stack direction="row">
      <Button icon="logout" onClick={() => void client.signOut()}>
        {t("settings.signOut")}
      </Button>
    </Stack>
  );
}

export function DeleteSection(): JSX.Element {
  const { t } = useI18n();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [error, setError] = createSignal<MessageKey | null>(null);
  const [reauth, setReauth] = createSignal(false);
  const phrase = () => t("settings.delete.phrase");

  const remove = async () => {
    setError(null);
    try {
      await client.call("DELETE", "/auth/account");
      client.forget();
      navigate("/sign-in", { replace: true });
    } catch (e) {
      setReauth(e instanceof AuthHttpError && e.code === "auth.reauth_required");
      setError(errorKey(e));
    }
  };

  return (
    <Section title={t("settings.delete")} flat>
      <Text measure>{t("settings.delete.intro")}</Text>
      <Stack direction="row">
        <Button variant="danger" icon="delete" onClick={() => setOpen(true)}>
          {t("settings.delete.button")}
        </Button>
      </Stack>
      <Dialog
        open={open()}
        title={t("settings.delete.dialogTitle")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Show
              when={reauth()}
              fallback={
                <Button variant="danger" disabled={typed().trim() !== phrase()} onClick={() => void remove()}>
                  {t("settings.delete.confirm")}
                </Button>
              }
            >
              <Button variant="primary" onClick={() => void client.signOut()}>
                {t("settings.delete.reauth")}
              </Button>
            </Show>
          </>
        }
      >
        <Stack gap="md">
          <Text>{t("settings.delete.intro")}</Text>
          <Show when={error()}>{(key) => <Banner tone="danger">{t(key())}</Banner>}</Show>
          <TextField
            label={t("settings.delete.confirmLabel", { phrase: phrase() })}
            autocomplete="off"
            value={typed()}
            onInput={(e) => setTyped(e.currentTarget.value)}
          />
        </Stack>
      </Dialog>
    </Section>
  );
}
