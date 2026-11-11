import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { realEnv } from "./realdb";

// The sign-in throttle counts every attempt, including attempts sent at the same time.
// Each attempt reserves its slot atomically BEFORE the verify, so a burst of N guesses
// is counted as N and at most MAX of them reach the verifier. Real sqlite engine from
// schema.sql, through the real handleApi. Covers sign-in, change password, first-run
// setup, and the Worker-side throttle on /api/smtp-auth.

const ORIGIN = "https://postern.example";
const USER = "conrad@skyphusion.org";
const PASSWORD = "correct-horse-battery";
const TRANSPORT = "transport-token-0123456789";
const SETUP_TOKEN = "setup-token-0123456789abcdef0123456789";
const MAX = 5;
const BURST = 40;

async function setup(overrides: Record<string, unknown> = {}) {
  const r = realEnv({
    WEBMAIL_AUTH_BACKEND: "native",
    WEBMAIL_AUTH_MAX_FAILURES: String(MAX),
    POSTERN_TRANSPORT_TOKEN: TRANSPORT,
    ...overrides,
  });
  const seed = async (username = USER, password = PASSWORD) => {
    r.raw
      .prepare("INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run(username, username, await hashSecret(password), "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z");
  };
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handleApi(
      new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      r.env,
      r.ctx,
    );
  const signIn = (password: string, username = USER, ip = "203.0.113.9") =>
    call("/api/session", { username, password }, { "cf-connecting-ip": ip });
  const smtpAuth = async (username: string, secret: string) =>
    (await (await call("/api/smtp-auth", { username, secret }, { authorization: `Bearer ${TRANSPORT}` })).json()) as Record<string, unknown>;
  const counter = (key: string) =>
    r.raw.prepare("SELECT failures, locked_until FROM webmail_auth_failures WHERE scope_key = ?").get(key) as
      | { failures: number; locked_until: string | null }
      | undefined;
  return { ...r, seed, call, signIn, smtpAuth, counter };
}

const tally = (statuses: number[]) =>
  statuses.reduce<Record<number, number>>((t, s) => ({ ...t, [s]: (t[s] ?? 0) + 1 }), {});

describe("sign-in counts a concurrent burst in full", () => {
  it(`${BURST} guesses at once: at most ${MAX} reach the verifier, the rest are 429, and the account locks`, async () => {
    const s = await setup();
    await s.seed();
    const res = await Promise.all(Array.from({ length: BURST }, () => s.signIn("wrong-password-x")));
    const t = tally(res.map((r) => r.status));
    expect(t[401], JSON.stringify(t)).toBe(MAX);
    expect(t[429], JSON.stringify(t)).toBe(BURST - MAX);
    expect(s.counter("a:" + USER)?.failures).toBe(MAX);
    expect(s.counter("a:" + USER)?.locked_until, "the account is locked").toBeTruthy();
    // The right password is refused while the lock holds.
    expect((await s.signIn(PASSWORD)).status).toBe(429);
  });

  it("a burst that ends with the right password: the right password does not get past the budget", async () => {
    const s = await setup();
    await s.seed();
    const attempts = Array.from({ length: BURST }, (_, i) => (i === BURST - 1 ? PASSWORD : "wrong-password-x"));
    const res = await Promise.all(attempts.map((p) => s.signIn(p)));
    const reached = res.filter((r) => r.status === 401 || r.status === 200).length;
    expect(reached, "attempts that reached the verifier").toBeLessThanOrEqual(MAX);
    expect(res.at(-1)!.status, "the last attempt is past the budget").toBe(429);
  });

  it("CONTROL: sequential guesses still trip at the threshold, and a clean sign-in leaves nothing counted", async () => {
    const s = await setup();
    await s.seed();
    expect((await s.signIn(PASSWORD)).status).toBe(200);
    expect(s.counter("a:" + USER), "account row cleared").toBeUndefined();
    expect(s.counter("i:203.0.113.9")?.failures ?? 0, "a success is not a client-IP failure").toBe(0);
    for (let i = 0; i < MAX; i++) expect((await s.signIn("wrong-password-x")).status).toBe(401);
    expect((await s.signIn("wrong-password-x")).status).toBe(429);
  });

  it("successful sign-ins from one address do not spend that address's budget", async () => {
    const s = await setup();
    await s.seed();
    await s.seed("other@skyphusion.org", PASSWORD);
    for (let i = 0; i < MAX - 1; i++) expect((await s.signIn("wrong-password-x")).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await s.signIn(PASSWORD, "other@skyphusion.org")).status).toBe(200);
    expect(s.counter("i:203.0.113.9")?.failures).toBe(MAX - 1);
  });
});

describe("change password counts a concurrent burst in full", () => {
  it(`${BURST} wrong current passwords at once: at most ${MAX} reach the verifier`, async () => {
    const s = await setup();
    await s.seed();
    const signed = await s.signIn(PASSWORD);
    expect(signed.status).toBe(200);
    const cookie = (name: string) => signed.headers.getSetCookie().find((c) => c.startsWith(name + "="))!.split(";")[0];
    const csrf = cookie(CSRF_COOKIE).slice(CSRF_COOKIE.length + 1);
    const headers = { cookie: `${cookie(SESSION_COOKIE)}; ${cookie(CSRF_COOKIE)}`, "x-postern-csrf": csrf };
    const res = await Promise.all(
      Array.from({ length: BURST }, () =>
        s.call("/api/session/password", { currentPassword: "wrong-password-x", newPassword: "a-brand-new-password" }, headers),
      ),
    );
    const t = tally(res.map((r) => r.status));
    expect(t[401], JSON.stringify(t)).toBe(MAX);
    expect(t[429], JSON.stringify(t)).toBe(BURST - MAX);
  });
});

describe("first-run setup counts a concurrent burst in full", () => {
  it(`${BURST} wrong setup tokens at once: at most ${MAX} reach the compare`, async () => {
    const s = await setup({ POSTERN_SETUP_TOKEN: SETUP_TOKEN });
    const body = { setupToken: "wrong-setup-token-0123456789abcdef0123", username: USER, displayName: "Owner", password: PASSWORD };
    const res = await Promise.all(Array.from({ length: BURST }, () => s.call("/api/setup", body, { "cf-connecting-ip": "203.0.113.9" })));
    const t = tally(res.map((r) => r.status));
    expect(t[401], JSON.stringify(t)).toBe(MAX);
    expect(t[429], JSON.stringify(t)).toBe(BURST - MAX);
  });
});

describe("/api/smtp-auth is throttled at the Worker, on the canonical username", () => {
  it(`locks after ${MAX} wrong secrets: the right secret is then refused as E_AUTH_THROTTLED`, async () => {
    const s = await setup();
    await s.seed();
    for (let i = 0; i < MAX; i++) expect(await s.smtpAuth(USER, "wrong-password-x")).toEqual({ ok: false, error: "E_AUTH_FAILED" });
    expect(await s.smtpAuth(USER, PASSWORD)).toMatchObject({ ok: false, error: "E_AUTH_THROTTLED" });
  });

  it(`${BURST} wrong secrets at once: at most ${MAX} reach the verifier`, async () => {
    const s = await setup();
    await s.seed();
    const res = await Promise.all(Array.from({ length: BURST }, () => s.smtpAuth(USER, "wrong-password-x")));
    const failed = res.filter((b) => b.error === "E_AUTH_FAILED").length;
    expect(failed).toBe(MAX);
    expect(res.filter((b) => b.error === "E_AUTH_THROTTLED").length).toBe(BURST - MAX);
  });

  it("variants that reach the same account share ONE budget (case, surrounding space, U+FEFF)", async () => {
    const s = await setup();
    await s.seed();
    const variants = ["Conrad@Skyphusion.org", " conrad@skyphusion.org", "\uFEFFconrad@skyphusion.org", "conrad@skyphusion.org\t", "CONRAD@SKYPHUSION.ORG"];
    expect(variants.length).toBe(MAX);
    for (const v of variants) expect((await s.smtpAuth(v, "wrong-password-x")).error).toBe("E_AUTH_FAILED");
    expect(await s.smtpAuth(USER, PASSWORD)).toMatchObject({ ok: false, error: "E_AUTH_THROTTLED" });
  });

  it("one credential, one budget: guesses at smtp-auth lock webmail sign-in too", async () => {
    const s = await setup();
    await s.seed();
    for (let i = 0; i < MAX; i++) await s.smtpAuth(USER, "wrong-password-x");
    expect((await s.signIn(PASSWORD)).status).toBe(429);
  });

  it("CONTROL: below the budget the right secret authenticates and clears the count", async () => {
    const s = await setup();
    await s.seed();
    for (let i = 0; i < MAX - 1; i++) await s.smtpAuth(USER, "wrong-password-x");
    expect(await s.smtpAuth(USER, PASSWORD)).toEqual({ ok: true, from: USER });
    expect(s.counter("a:" + USER)).toBeUndefined();
  });
});
