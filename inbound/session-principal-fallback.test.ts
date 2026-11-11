import { describe, it, expect, vi, afterEach } from "vitest";
import { handleApi } from "./src/api";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { realEnv } from "./realdb";

// #854 M2 / #905: a webmail sign-in looks up (or creates) the human principal behind the
// session. A failure on the principal side must never block the sign-in itself: the mint
// falls back to today's behaviour, a session with no principal, and the #740 S5
// self-service routes then ask for a fresh sign-in. Real sqlite engine, through handleApi.

const ADMIN = "test-token"; // realdb's static both token
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const PASSWORD = "correct-horse-battery";

type Json = Record<string, unknown>;

async function setup() {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native" });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined || method === "GET" ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json, res };
  };
  expect((await call("POST", "/api/admin/users", { token: ADMIN, body: { username: ALICE, password: PASSWORD } })).status).toBe(201);
  return { ...r, call };
}

afterEach(() => vi.restoreAllMocks());

describe("#854 a sign-in survives a failure on the principal side", () => {
  it("the credentials table is unreadable: sign-in still succeeds, the session has no principal, S5 asks to re-auth", async () => {
    const s = await setup();
    s.raw.exec("ALTER TABLE credentials RENAME TO credentials_offline");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await s.call("POST", "/api/session", { body: { username: ALICE, password: PASSWORD } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(err.mock.calls.some((c) => String(c[0]).includes("session principal lookup failed"))).toBe(true);
    expect(s.raw.prepare("SELECT principal_id FROM webmail_sessions").get()).toEqual({ principal_id: null });
    // The mail door works; the self-service door asks for a fresh sign-in.
    const get = (n: string) => res.res.headers.getSetCookie().find((c) => c.startsWith(n + "="))!.split(";")[0];
    const headers = { cookie: `${get(SESSION_COOKIE)}; ${get(CSRF_COOKIE)}` };
    expect((await s.call("GET", "/api/session", { headers })).status).toBe(200);
    const self = await s.call("GET", "/api/delegations/mine", { headers });
    expect([self.status, self.body.error]).toEqual([401, "E_REAUTH_REQUIRED"]);
  });

  it("a wrong password is still refused while the principal side is down (the fallback never allows)", async () => {
    const s = await setup();
    s.raw.exec("ALTER TABLE credentials RENAME TO credentials_offline");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await s.call("POST", "/api/session", { body: { username: ALICE, password: "wrong-password-x" } })).status).toBe(401);
  });

  it("CONTROL: with the principal side healthy, the session names its principal", async () => {
    const s = await setup();
    expect((await s.call("POST", "/api/session", { body: { username: ALICE, password: PASSWORD } })).status).toBe(200);
    expect(String((s.raw.prepare("SELECT principal_id FROM webmail_sessions").get() as Json).principal_id)).toMatch(/^prn_/);
  });
});
