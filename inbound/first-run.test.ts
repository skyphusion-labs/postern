import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";

// #791: which webmail backend is on when WEBMAIL_AUTH_BACKEND is unset, and the
// first-run POST /api/setup (contract docs/design/webmail-v2-contracts.md 1.10.6 and
// 1.10.7). Real sqlite from schema.sql: the atomic first-user insert and the
// "any user?" read are SQL, and a fake would only agree with itself.

const ORIGIN = "https://postern.example";
const TOKEN = "setup-token-0123456789abcdef0123456789";
const PASSWORD = "first-admin-password";
const USER = "owner@skyphusion.org";
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function realEnv(overrides: Record<string, unknown> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  function prepare(sql: string) {
    const stmt = db.prepare(sql);
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async all<T>() {
        return { results: stmt.all(...(bound as never[])) as unknown as T[] };
      },
      async first<T>() {
        return (stmt.get(...(bound as never[])) ?? null) as T | null;
      },
      async run() {
        const result = stmt.run(...(bound as never[]));
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  const env = { DB: { prepare }, ALLOWED_FROM_DOMAIN: "skyphusion.org", ...overrides } as unknown as Env;
  return { env, raw: db };
}

async function seed(db: DatabaseSync, username = "alice@skyphusion.org", disabled = 0): Promise<void> {
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(username, username, await hashSecret(PASSWORD), disabled, "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z");
}

function call(env: Env, method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return handleApi(new Request(ORIGIN + path, { method, headers, body }), env, CTX);
}

function cookieValue(res: Response, name: string): string {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(name + "=")) return c.slice(name.length + 1).split(";")[0];
  return "";
}

async function discovery(env: Env) {
  const res = await call(env, "GET", "/api/session");
  expect(res.status).toBe(401);
  return await res.json();
}

const SETUP = { setupToken: TOKEN, username: USER, displayName: "Owner", password: PASSWORD };
const users = (db: DatabaseSync) => (db.prepare("SELECT COUNT(*) AS n FROM smtp_credentials").get() as { n: number }).n;

describe("#791 which backend is on (contract 1.10.6)", () => {
  it("unset, no users, no setup token: off (BYO-token gate), sign-in refused", async () => {
    const { env } = realEnv();
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "off", setupRequired: false });
    const res = await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "E_SESSIONS_DISABLED" });
  });

  it("unset with a user: native, and the user signs in", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "native", setupRequired: false });
    const res = await call(env, "POST", "/api/session", { body: { username: "alice@skyphusion.org", password: PASSWORD } });
    expect(res.status).toBe(200);
    const cookie = `${SESSION_COOKIE}=${cookieValue(res, SESSION_COOKIE)}`;
    expect((await call(env, "GET", "/api/folders", { headers: { cookie } })).status).toBe(200);
  });

  it("unset, no users, setup armed: native with setupRequired", async () => {
    const { env } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN });
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "native", setupRequired: true });
  });

  it("only a DISABLED user still counts as a user: native, setup closed", async () => {
    const { env, raw } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN });
    await seed(raw, "alice@skyphusion.org", 1);
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "native", setupRequired: false });
    const res = await call(env, "POST", "/api/setup", { body: SETUP });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "E_SETUP_COMPLETE" });
  });

  it("explicit off always wins: no sign-in, no setup, an existing cookie is ignored", async () => {
    const on = realEnv();
    await seed(on.raw);
    const signed = await call(on.env, "POST", "/api/session", { body: { username: "alice@skyphusion.org", password: PASSWORD } });
    const cookie = `${SESSION_COOKIE}=${cookieValue(signed, SESSION_COOKIE)}`;
    const off = { ...(on.env as unknown as Record<string, unknown>), WEBMAIL_AUTH_BACKEND: "off", POSTERN_SETUP_TOKEN: TOKEN } as unknown as Env;
    expect(await discovery(off)).toEqual({ ok: false, authBackend: "off", setupRequired: false });
    expect((await call(off, "GET", "/api/folders", { headers: { cookie } })).status).toBe(401);
    const who = await call(off, "GET", "/api/session", { headers: { cookie } });
    expect(who.status).toBe(401);
    expect(await who.json()).toEqual({ ok: false, authBackend: "off", setupRequired: false });
    expect((await call(off, "POST", "/api/session", { body: { username: "alice@skyphusion.org", password: PASSWORD } })).status).toBe(404);
    on.raw.prepare("DELETE FROM smtp_credentials").run();
    expect((await call(off, "POST", "/api/setup", { body: SETUP })).status).toBe(404);
  });

  it("explicit native with no users and no token: native, nothing to set up", async () => {
    const { env } = realEnv({ WEBMAIL_AUTH_BACKEND: "native" });
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "native", setupRequired: false });
  });

  it("the deferred ldap/system values and a typo are off", async () => {
    for (const v of ["ldap", "system", "nativ"]) {
      const { env, raw } = realEnv({ WEBMAIL_AUTH_BACKEND: v });
      await seed(raw);
      expect(((await discovery(env)) as { authBackend: string }).authBackend).toBe("off");
    }
  });
});

describe("#791 POST /api/setup (contract 1.10.7)", () => {
  it("creates the first user with the chosen password and signs them in", async () => {
    const { env, raw } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN });
    const res = await call(env, "POST", "/api/setup", { body: SETUP });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true, setup: true,
      user: { username: USER, from: USER, displayName: "Owner", disabled: false },
      identity: { from: USER, displayName: "Owner" },
      capabilities: ["read", "send", "delete", "organize"],
    });
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    const id = cookieValue(res, SESSION_COOKIE);
    expect(id).toBeTruthy();
    expect(cookieValue(res, CSRF_COOKIE)).toBe(body.csrfToken);
    expect((await call(env, "GET", "/api/session", { headers: { cookie: `${SESSION_COOKIE}=${id}` } })).status).toBe(200);
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "native", setupRequired: false });
    expect((await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } })).status).toBe(200);
    // Closed for good.
    const again = await call(env, "POST", "/api/setup", { body: { ...SETUP, username: "mallory@skyphusion.org" } });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "E_SETUP_COMPLETE" });
    expect(users(raw)).toBe(1);
  });

  it("a wrong setup token is 401, counted, and locks out (even the right token) at the threshold", async () => {
    const { env, raw } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN, WEBMAIL_AUTH_MAX_FAILURES: "3" });
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 3; i++) {
      const res = await call(env, "POST", "/api/setup", { headers: ip, body: { ...SETUP, setupToken: `wrong-${i}-0123456789abcdef0123456789` } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "E_AUTH_FAILED" });
    }
    const locked = await call(env, "POST", "/api/setup", { headers: ip, body: SETUP });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(users(raw)).toBe(0);
    const keys = (raw.prepare("SELECT scope_key FROM webmail_auth_failures ORDER BY scope_key").all() as Array<{ scope_key: string }>).map((r) => r.scope_key);
    expect(keys).toEqual(["i:203.0.113.9", "s:setup"]);
  });

  it("after setup, any further attempt is 409 before the token is even compared", async () => {
    const { env, raw } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN });
    await seed(raw);
    const res = await call(env, "POST", "/api/setup", { body: { ...SETUP, setupToken: "wrong-0123456789abcdef0123456789" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "E_SETUP_COMPLETE" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM webmail_auth_failures").get()).toEqual({ n: 0 });
  });

  it("a short setup token arms nothing", async () => {
    const { env } = realEnv({ POSTERN_SETUP_TOKEN: "too-short" });
    expect(await discovery(env)).toEqual({ ok: false, authBackend: "off", setupRequired: false });
    expect((await call(env, "POST", "/api/setup", { body: { ...SETUP, setupToken: "too-short" } })).status).toBe(404);
  });

  it("no setup token configured: the route does not exist", async () => {
    const { env } = realEnv();
    const res = await call(env, "POST", "/api/setup", { body: SETUP });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "E_NOT_FOUND" });
  });

  it("refuses cross-site, oversized, incomplete and weak requests before touching the token", async () => {
    const { env, raw } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN });
    const cases: Array<[Parameters<typeof call>[3], number, string]> = [
      [{ headers: { "sec-fetch-site": "cross-site" }, body: SETUP }, 403, "E_CROSS_ORIGIN"],
      [{ headers: { origin: "https://evil.example" }, body: SETUP }, 403, "E_CROSS_ORIGIN"],
      [{ raw: JSON.stringify({ ...SETUP, pad: "x".repeat(5000) }) }, 413, "E_PAYLOAD_TOO_LARGE"],
      [{ raw: "{" }, 400, "E_VALIDATION_ERROR"],
      [{ body: { ...SETUP, password: undefined } }, 400, "E_FIELD_MISSING"],
      [{ body: { ...SETUP, setupToken: undefined } }, 400, "E_FIELD_MISSING"],
      [{ body: { ...SETUP, password: "short" } }, 400, "E_PASSWORD_POLICY"],
      [{ body: { ...SETUP, username: "bad user" } }, 400, "E_VALIDATION_ERROR"],
      [{ body: { ...SETUP, from: "owner@evil.example" } }, 400, "E_SENDER_NOT_ALLOWED"],
    ];
    for (const [opts, status, error] of cases) {
      const res = await call(env, "POST", "/api/setup", opts);
      expect([error, res.status]).toEqual([error, status]);
      expect(await res.json()).toMatchObject({ ok: false, error });
    }
    expect(users(raw)).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM webmail_auth_failures").get()).toEqual({ n: 0 });
    expect((await call(env, "GET", "/api/setup")).status).toBe(405);
  });

  it("two racing setups produce exactly one user", async () => {
    const { env, raw } = realEnv({ POSTERN_SETUP_TOKEN: TOKEN });
    const [a, b] = await Promise.all([
      call(env, "POST", "/api/setup", { body: SETUP }),
      call(env, "POST", "/api/setup", { body: { ...SETUP, username: "rival@skyphusion.org" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(users(raw)).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM webmail_sessions").get() as { n: number }).n).toBe(1);
  });
});
