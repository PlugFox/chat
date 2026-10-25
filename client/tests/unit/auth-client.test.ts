import { describe, expect, it } from "vitest";
import { AuthClient, type AuthDeps, type ChannelLike, type LocksLike } from "../../src/auth/client";

const HOUR = 3_600_000;

/** One browser: a lock and a broadcast channel shared by its tabs, and a server. */
function browser(server: (method: string, path: string, init: RequestInit) => Response | Promise<Response>) {
  let now = 1_000_000;
  const calls: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const locks: LocksLike = {
    request(_name, callback) {
      const run = queue.then(callback);
      queue = run.catch(() => undefined);
      return run;
    },
  };
  const channels: ChannelLike[] = [];
  const tab = (): AuthClient => {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage(message) {
        for (const other of channels) {
          // Synchronous here; browsers deliver later, which the server's grace window covers.
          if (other !== channel) other.onmessage?.({ data: message });
        }
      },
    };
    channels.push(channel);
    const deps: AuthDeps = {
      fetch: async (path, init) => {
        calls.push(`${init.method} ${path}`);
        return server(init.method ?? "GET", path, init);
      },
      locks,
      channel,
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => undefined,
      device: () => ({ device_id: "00000000-0000-7000-8000-000000000001", timezone: "UTC" }),
    };
    return new AuthClient(deps);
  };
  return { tab, calls, advance: (ms: number) => (now += ms), now: () => now };
}

let issued = 0;
function grant(now: number) {
  issued += 1;
  return Response.json({
    access_token: `token-${issued}`,
    expires_at: now + HOUR,
    user_id: "u",
    session_id: "s",
  });
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const signedOut = () => json(401, { code: "auth.signed_out", message: "", retry: false });

describe("AuthClient", () => {
  it("is signed in when the cookie refreshes, signed out otherwise", async () => {
    const yes = browser((_m, _p) => grant(0)).tab();
    await yes.start();
    expect(yes.current).toEqual({ kind: "signed_in", userId: "u", sessionId: "s" });

    const no = browser(() => signedOut()).tab();
    await no.start();
    expect(no.current.kind).toBe("signed_out");
  });

  it("refreshes once for two tabs that need a token at the same time", async () => {
    let clock = () => 0;
    const b = browser(async (_m, path) => {
      // Slow enough that the second tab waits on the lock.
      await new Promise((r) => setTimeout(r, 10));
      return path === "/auth/refresh" ? grant(clock()) : json(404, {});
    });
    clock = b.now;
    const [one, two] = [b.tab(), b.tab()];
    const [a, c] = await Promise.all([one.accessToken(true), two.accessToken(true)]);
    expect(b.calls.filter((c) => c === "POST /auth/refresh")).toHaveLength(1);
    expect(a.token).toBe(c.token);
  });

  it("uses a fresh token without asking the server", async () => {
    const b = browser(() => grant(1_000_000));
    const tab = b.tab();
    await tab.start();
    await tab.accessToken(false);
    await tab.accessToken(false);
    expect(b.calls).toEqual(["POST /auth/refresh"]);
    b.advance(HOUR - 30_000);
    await tab.accessToken(false);
    expect(b.calls).toHaveLength(2);
  });

  it("retries a call once with a forced refresh after 401", async () => {
    let first = true;
    const b = browser((_m, path) => {
      if (path === "/auth/refresh") return grant(1_000_000);
      if (first) {
        first = false;
        return json(401, { code: "auth.invalid_token", message: "", retry: false });
      }
      return json(200, { sessions: [] });
    });
    const tab = b.tab();
    await tab.start();
    await expect(tab.call("GET", "/auth/sessions")).resolves.toEqual({ sessions: [] });
    expect(b.calls).toEqual(["POST /auth/refresh", "GET /auth/sessions", "POST /auth/refresh", "GET /auth/sessions"]);
  });

  it("signs every tab out together", async () => {
    let session = true;
    const b = browser((_m, path) => {
      if (path === "/auth/sign-out") session = false;
      if (path === "/auth/refresh") return session ? grant(1_000_000) : signedOut();
      return new Response(null, { status: 204 });
    });
    const [one, two] = [b.tab(), b.tab()];
    await one.start();
    await two.start();
    await one.signOut();
    await new Promise((r) => setTimeout(r, 0));
    expect([one.current.kind, two.current.kind]).toEqual(["signed_out", "signed_out"]);
    await expect(two.accessToken(false)).rejects.toMatchObject({ code: "auth.signed_out" });
  });

  it("reports the device after an email sign-in", async () => {
    const bodies: unknown[] = [];
    const b = browser((_m, path, init) => {
      if (init.body) bodies.push(JSON.parse(String(init.body)));
      if (path === "/auth/email/verify") return grant(1_000_000);
      if (path === "/auth/session") return new Response(null, { status: 204 });
      return json(404, {});
    });
    const tab = b.tab();
    await tab.emailVerify("p", "ann@example.com", "12345678", "ru");
    expect(tab.current.kind).toBe("signed_in");
    expect(b.calls).toEqual(["POST /auth/email/verify", "PUT /auth/session"]);
    expect(bodies[1]).toEqual({ device_id: "00000000-0000-7000-8000-000000000001", timezone: "UTC", locale: "ru" });
  });

  it("keeps the state on a network error and names it", async () => {
    const tab = browser(() => {
      throw new TypeError("offline");
    }).tab();
    await tab.start();
    expect(tab.current.kind).toBe("signed_out");
    await expect(tab.refresh(true)).rejects.toMatchObject({ code: "network" });
  });
});
