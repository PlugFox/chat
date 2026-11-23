import { useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { useAuth } from "../../auth/context";
import { errorKey } from "../../auth/errors";
import { Banner, Button, Page, Section, Stack, Text, TextField } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages/en";
import type { Providers } from "../../protocol/generated/protocol";

/** Reasons the Google callback sends back in `?error=`. */
const redirectErrors: Record<string, MessageKey> = {
  cancelled: "signIn.error.cancelled",
  failed: "signIn.error.failed",
  unavailable: "signIn.error.unavailable",
  signup_closed: "error.auth.signup_closed",
  email_unverified: "error.auth.email_unverified",
};

async function providers(): Promise<Providers> {
  const response = await fetch("/auth/providers");
  if (!response.ok) throw new Error(`providers: ${response.status}`);
  return (await response.json()) as Providers;
}

export default function SignInPage(): JSX.Element {
  const { t, locale } = useI18n();
  const { client, state } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams<{ error?: string }>();
  const [methods] = createResource(providers);
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [pending, setPending] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<MessageKey | null>(null);

  createEffect(() => {
    if (state().kind === "signed_in") navigate("/", { replace: true });
  });

  const redirectError = (): MessageKey | undefined => {
    const reason = params.error;
    return reason ? redirectErrors[reason] : undefined;
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (event: SubmitEvent) => {
    event.preventDefault();
    void run(async () => {
      setPending(await client.emailStart(email(), locale()));
      setCode("");
    });
  };

  const verify = (event: SubmitEvent) => {
    event.preventDefault();
    const id = pending();
    if (!id) return;
    void run(() => client.emailVerify(id, email(), code(), locale()));
  };

  return (
    <Page title={t("signIn.title")}>
      <Text tone="muted" measure>
        {t("signIn.intro")}
      </Text>
      <Show when={redirectError()}>{(key) => <Banner tone="danger">{t(key())}</Banner>}</Show>
      <Switch>
        <Match when={methods.loading}>
          <Text tone="muted">{t("signIn.loading")}</Text>
        </Match>
        <Match when={methods.error}>
          <Banner tone="danger">{t("error.network")}</Banner>
        </Match>
        <Match when={methods() && !methods()?.google && !methods()?.email}>
          <Banner tone="warning">{t("signIn.none")}</Banner>
        </Match>
      </Switch>
      <Show when={methods()?.google}>
        <Button variant="primary" size="lg" block onClick={() => window.location.assign("/auth/google/start")}>
          {t("signIn.google")}
        </Button>
      </Show>
      <Show when={methods()?.email}>
        <Section title={t("signIn.email.title")}>
          <Show when={error()}>{(key) => <Banner tone="danger">{t(key())}</Banner>}</Show>
          <Show
            when={pending()}
            fallback={
              <Stack as="form" gap="md" onSubmit={sendCode}>
                <TextField
                  label={t("signIn.email.label")}
                  type="email"
                  autocomplete="email"
                  required
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                />
                <Button type="submit" variant="primary" disabled={busy()}>
                  {t("signIn.email.send")}
                </Button>
              </Stack>
            }
          >
            <Stack as="form" gap="md" onSubmit={verify}>
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
              <Button type="submit" variant="primary" disabled={busy()}>
                {t("signIn.code.submit")}
              </Button>
              <Stack direction="row" wrap gap="sm">
                <Button
                  variant="ghost"
                  disabled={busy()}
                  onClick={() =>
                    void run(async () => {
                      setPending(await client.emailStart(email(), locale()));
                    })
                  }
                >
                  {t("signIn.code.resend")}
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>
                  {t("signIn.code.other")}
                </Button>
              </Stack>
            </Stack>
          </Show>
        </Section>
      </Show>
    </Page>
  );
}
