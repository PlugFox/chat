import { test as base, expect, type Page, type Route } from "@playwright/test";
import { FakeKeys, type SeededAccount, seededAccount } from "./fake-keys";

/** Every route behind sign-in; the UI kit holds every component and variant. */
export const pages = [
  "/",
  "/notes",
  "/notes/new",
  "/registers",
  "/registers/body.weight",
  "/saved",
  "/settings",
  "/settings/general",
  "/settings/providers",
  "/settings/keys",
  "/settings/account",
  "/settings/devices",
  "/settings/activity",
  "/settings/access",
  "/provider",
  "/ui-kit",
] as const;

export const themes = ["light", "dark", "amoled"] as const;

/** Opens a page with an explicit theme saved, as a returning user would. */
export async function open(page: Page, path: string, theme?: (typeof themes)[number]): Promise<void> {
  if (theme) {
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  }
  await page.goto(path);
  await expect(page.locator("h1:visible")).toBeVisible();
  // A remembered device unlocks by itself; wait for the page behind the keys.
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
}

/** Unlocks with the recovery key and remembers the device, so later loads unlock by themselves. */
export async function unlock(page: Page, words: string, remember = true): Promise<void> {
  await page.goto("/");
  // Locators by role, not by text: this runs in every UI language.
  const field = page.getByRole("textbox");
  await field.fill(words);
  if (remember) await page.getByRole("checkbox").check();
  await field.press("Enter");
  await expect(page.getByRole("checkbox")).toBeHidden();
}

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 840;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The `/auth` API as the test build sees it: there is no server behind
 * `vite preview`, so these routes answer from memory. `signedIn` decides what
 * the refresh cookie would say; signing in with the code `12345678` works.
 */
export class FakeAuth {
  signedIn: boolean;
  readonly requests: string[] = [];

  constructor(signedIn: boolean) {
    this.signedIn = signedIn;
  }

  async install(page: Page): Promise<void> {
    await page.route("**/auth/**", (route) => this.handle(route));
  }

  private grant() {
    return {
      access_token: "test-access-token",
      expires_at: Date.now() + HOUR,
      user_id: "0190d2c4-8b7e-7000-8000-000000000001",
      session_id: "0190d2c4-8b7e-7000-8000-00000000000a",
    };
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const key = `${request.method()} ${path}`;
    this.requests.push(key);
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body });
    const now = Date.now();
    switch (key) {
      case "GET /auth/providers":
        return json(200, { google: true, email: true });
      case "POST /auth/refresh":
        return this.signedIn
          ? json(200, this.grant())
          : json(401, { code: "auth.signed_out", message: "signed out", retry: false });
      case "POST /auth/email/start":
        return json(202, { pending_id: "0190d2c4-8b7e-7000-8000-0000000000ff" });
      case "POST /auth/email/verify": {
        const body = request.postDataJSON() as { code: string };
        if (body.code !== "12345678") {
          return json(400, { code: "auth.code_invalid", message: "", retry: false });
        }
        this.signedIn = true;
        return json(200, this.grant());
      }
      case "POST /auth/sign-out":
        this.signedIn = false;
        return route.fulfill({ status: 204 });
      case "PUT /auth/session":
        return route.fulfill({ status: 204 });
      case "GET /auth/sessions":
        return json(200, {
          sessions: [
            session("0190d2c4-8b7e-7000-8000-00000000000a", true, "Chrome", now),
            session("0190d2c4-8b7e-7000-8000-00000000000b", false, "Firefox", now - 2 * DAY),
          ],
        });
      case "GET /auth/identities":
        return json(200, {
          identities: [
            identity("0190d2c4-8b7e-7000-8000-0000000000c1", "email", "ann@example.com", now - 30 * DAY),
            identity("0190d2c4-8b7e-7000-8000-0000000000c2", "google", "ann@gmail.example", now - 3 * DAY),
          ],
        });
      case "GET /auth/audit":
        return json(200, {
          events: [
            audit(3, "auth.signed_in", { provider: "google" }, now - HOUR),
            audit(2, "session.revoked", { reason: "device_replaced" }, now - DAY),
            audit(1, "account.created", {}, now - 30 * DAY),
          ],
          next_before: null,
        });
      default:
        return json(404, { code: "not_found", message: key, retry: false });
    }
  }
}

function session(id: string, current: boolean, browser: string, lastSeen: number) {
  return {
    id,
    current,
    provider: "email",
    device_id: null,
    user_agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${browser}/120.0`,
    ip: "203.0.113.7",
    country: "DE",
    timezone: "Europe/Berlin",
    locale: "en",
    client_version: null,
    created_at: lastSeen - DAY,
    last_seen_at: lastSeen,
  };
}

function identity(id: string, provider: string, email: string, created: number) {
  return { id, provider, email, email_verified: true, created_at: created, last_used_at: created };
}

function audit(id: number, kind: string, details: object, at: number) {
  return { id, kind, session_id: null, ip: "203.0.113.7", country: "DE", user_agent: null, details, created_at: at };
}

/**
 * The keys behind the sign-in: `unlocked` (an account whose device is
 * remembered, so pages open unlocked), `locked` (an account, not unlocked in
 * this browser) or `new` (no keys yet).
 */
export type VaultSeed = "unlocked" | "locked" | "new";

/**
 * Signed in and unlocked by default; `test.use({ signedIn: false })` starts at
 * the sign-in screen, `test.use({ vault: "new" })` at key setup.
 */
export const test = base.extend<{
  signedIn: boolean;
  vault: VaultSeed;
  auth: FakeAuth;
  seed: SeededAccount | null;
  keys: FakeKeys;
  /** The recovery words of the seeded account. */
  words: string;
}>({
  signedIn: [true, { option: true }],
  vault: ["unlocked", { option: true }],
  auth: async ({ signedIn }, use) => {
    await use(new FakeAuth(signedIn));
  },
  seed: async ({ vault }, use) => {
    await use(vault === "new" ? null : await seededAccount());
  },
  keys: async ({ seed }, use) => {
    const keys = new FakeKeys();
    keys.account = seed?.account ?? null;
    keys.scopeKeys = seed?.scopeKeys ?? [];
    await use(keys);
  },
  words: async ({ seed }, use) => {
    await use(seed?.words ?? "");
  },
  page: async ({ page, auth, keys, seed, signedIn, vault }, use) => {
    await auth.install(page);
    await keys.install(page);
    if (signedIn && vault === "unlocked" && seed) await unlock(page, seed.words);
    await use(page);
  },
});

export { expect };
