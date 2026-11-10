import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";

// #790: human account management (contract docs/design/webmail-v2-contracts.md 1.10).
// Admin routes, the legacy upsert fixes, sessions that follow the account, per-row hash
// upgrade, and the self-service change password. Run against a REAL sqlite database
// built from schema.sql (the session-hardening.test.ts harness), because every
// property here lives or dies on actual SQL: a conditional update, a join, a keyset.

const ADMIN = "admin-both-token-0123456789";
const READ = "read-only-token-0123456789";
const PASSWORD = "correct-horse-battery";
const USER = "alice@skyphusion.org";
const ORIGIN = "https://postern.example";
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
  const env = {
    DB: { prepare },
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_API_TOKEN: ADMIN,
    POSTERN_API_TOKEN_READ: READ,
    ...overrides,
  } as unknown as Env;
  return { env, raw: db };
}

async function seed(db: DatabaseSync, username = USER, password = PASSWORD, hash?: string): Promise<void> {
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?)",
  ).run(username, username, hash ?? (await hashSecret(password)), "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z");
}

function call(env: Env, method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return handleApi(new Request(ORIGIN + path, { method, headers, body }), env, CTX);
}

interface Signed { id: string; csrf: string; body: Record<string, unknown> }

function cookieValue(res: Response, name: string): string {
  for (const c of res.headers.getSetCookie()) {
    if (c.startsWith(name + "=")) return c.slice(name.length + 1).split(";")[0];
  }
  return "";
}

async function signIn(env: Env, username = USER, password = PASSWORD): Promise<Signed> {
  const res = await call(env, "POST", "/api/session", { body: { username, password } });
  expect(res.status).toBe(200);
  return { id: cookieValue(res, SESSION_COOKIE), csrf: cookieValue(res, CSRF_COOKIE), body: await res.json() };
}

function withSession(s: Signed, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${s.id}; ${CSRF_COOKIE}=${s.csrf}`, "x-postern-csrf": s.csrf, ...extra };
}

async function whoami(env: Env, s: Signed): Promise<number> {
  return (await call(env, "GET", "/api/session", { headers: withSession(s) })).status;
}

function row(db: DatabaseSync, username = USER) {
  return db.prepare("SELECT * FROM smtp_credentials WHERE username = ?").get(username) as Record<string, unknown> | undefined;
}

function sessionCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM webmail_sessions").get() as { n: number }).n;
}

// --- admin routes -------------------------------------------------------------

describe("#790 admin user management (both token)", () => {
  it("creates a user with a generated password returned once, and lists it without any hash", async () => {
    const { env, raw } = realEnv();
    const res = await call(env, "POST", "/api/admin/users", { token: ADMIN, body: { username: "Bob@Skyphusion.org", displayName: "Bob" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown>; password: string };
    expect(body.user).toEqual({
      username: "bob@skyphusion.org", from: "bob@skyphusion.org", displayName: "Bob", disabled: false,
      createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect(body.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const stored = row(raw, "bob@skyphusion.org")!;
    expect(String(stored.secret_hash)).toMatch(/^pbkdf2\$210000\$/);
    expect(String(stored.secret_hash)).not.toContain(body.password);

    const list = await call(env, "GET", "/api/admin/users", { token: ADMIN });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain("pbkdf2");
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toMatchObject({ ok: true, users: [{ username: "bob@skyphusion.org" }], nextCursor: null });

    // The generated password signs in, and the session carries the display name.
    const s = await signIn(env, "bob@skyphusion.org", body.password);
    expect(s.body.identity).toEqual({ from: "bob@skyphusion.org", displayName: "Bob" });
  });

  it("does not return a password it did not generate", async () => {
    const { env } = realEnv();
    const res = await call(env, "POST", "/api/admin/users", { token: ADMIN, body: { username: USER, password: PASSWORD } });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("password");
  });

  it("never overwrites an existing user: 409 and the hash is untouched", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const before = row(raw)!.secret_hash;
    const res = await call(env, "POST", "/api/admin/users", { token: ADMIN, body: { username: USER, password: "another-long-password" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_CONFLICT" });
    expect(row(raw)!.secret_hash).toBe(before);
  });

  it("validates username, password policy and sender domain before writing anything", async () => {
    const { env, raw } = realEnv();
    const cases: Array<[unknown, number, string]> = [
      [{ username: "bad user@skyphusion.org" }, 400, "E_VALIDATION_ERROR"],
      [{ username: "-lead@skyphusion.org" }, 400, "E_VALIDATION_ERROR"],
      [{ username: "x".repeat(255) }, 400, "E_VALIDATION_ERROR"],
      [{ username: USER, password: "short" }, 400, "E_PASSWORD_POLICY"],
      [{ username: USER, password: USER.toUpperCase() }, 400, "E_PASSWORD_POLICY"],
      [{ username: USER, password: "y".repeat(257) }, 400, "E_PASSWORD_POLICY"],
      [{ username: USER, from: "alice@evil.example" }, 400, "E_SENDER_NOT_ALLOWED"],
      [{ username: USER, displayName: "bad\nname" }, 400, "E_VALIDATION_ERROR"],
      [{}, 400, "E_FIELD_MISSING"],
    ];
    for (const [body, status, error] of cases) {
      const res = await call(env, "POST", "/api/admin/users", { token: ADMIN, body });
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), status]);
      expect(await res.json()).toMatchObject({ ok: false, error });
    }
    expect((raw.prepare("SELECT COUNT(*) AS n FROM smtp_credentials").get() as { n: number }).n).toBe(0);
  });

  it("refuses a read token and a signed-in session (admin is held only by both)", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    expect((await call(env, "GET", "/api/admin/users", { token: READ })).status).toBe(403);
    const s = await signIn(env);
    expect((await call(env, "GET", "/api/admin/users", { headers: withSession(s) })).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/users", { headers: withSession(s), body: { username: "eve@skyphusion.org" } })).status).toBe(403);
    expect((await call(env, "GET", "/api/admin/users")).status).toBe(401);
  });

  it("pages the list by username with a keyset cursor", async () => {
    const { env, raw } = realEnv();
    for (const u of ["c@skyphusion.org", "a@skyphusion.org", "b@skyphusion.org"]) await seed(raw, u, PASSWORD, "pbkdf2$1$AA==$AA==");
    const p1 = (await (await call(env, "GET", "/api/admin/users?limit=2", { token: ADMIN })).json()) as { users: Array<{ username: string }>; nextCursor: string };
    expect(p1.users.map((u) => u.username)).toEqual(["a@skyphusion.org", "b@skyphusion.org"]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await (await call(env, "GET", `/api/admin/users?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, { token: ADMIN })).json()) as { users: Array<{ username: string }>; nextCursor: string | null };
    expect(p2.users.map((u) => u.username)).toEqual(["c@skyphusion.org"]);
    expect(p2.nextCursor).toBeNull();
    for (const bad of ["0", "501", "abc"]) {
      expect((await call(env, "GET", `/api/admin/users?limit=${bad}`, { token: ADMIN })).status).toBe(400);
    }
  });

  it("shows one user, and says 404 for an unknown one", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const ok = await call(env, "GET", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, user: { username: USER, disabled: false } });
    const miss = await call(env, "GET", "/api/admin/users/nobody%40skyphusion.org", { token: ADMIN });
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ error: "E_NOT_FOUND" });
    expect((await call(env, "GET", "/api/admin/users/%E0%A4%A", { token: ADMIN })).status).toBe(400);
  });

  it("disable ends the sessions and refuses sign-in; enable restores the same password", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    expect(await whoami(env, s)).toBe(200);

    const off = await call(env, "PATCH", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN, body: { disabled: true } });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, user: { disabled: true }, sessionsEnded: 1 });
    expect(await whoami(env, s)).toBe(401);
    const refused = await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ ok: false, error: "E_AUTH_FAILED" });

    const on = await call(env, "PATCH", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN, body: { disabled: false } });
    expect(await on.json()).toMatchObject({ user: { disabled: false }, sessionsEnded: 0 });
    await signIn(env);
  });

  it("PATCH changes the display name without ending sessions, and refuses an empty body", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    const res = await call(env, "PATCH", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN, body: { displayName: "Alice A" } });
    expect(await res.json()).toMatchObject({ user: { displayName: "Alice A" }, sessionsEnded: 0 });
    expect(await whoami(env, s)).toBe(200);
    expect((await call(env, "PATCH", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN, body: {} })).status).toBe(400);
    expect((await call(env, "PATCH", "/api/admin/users/nobody%40skyphusion.org", { token: ADMIN, body: { disabled: true } })).status).toBe(404);
  });

  it("a from change ends the sessions (the bound identity moved)", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    const res = await call(env, "PATCH", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN, body: { from: "alice.a@skyphusion.org" } });
    expect(await res.json()).toMatchObject({ user: { from: "alice.a@skyphusion.org" }, sessionsEnded: 1 });
    expect(await whoami(env, s)).toBe(401);
    const s2 = await signIn(env);
    expect(s2.body.identity).toMatchObject({ from: "alice.a@skyphusion.org" });
  });

  it("reset password: old fails, new works, sessions end, the account lockout clears", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "2" });
    await seed(raw);
    const s = await signIn(env);
    await call(env, "POST", "/api/session", { body: { username: USER, password: "wrong-guess-1" } });
    await call(env, "POST", "/api/session", { body: { username: USER, password: "wrong-guess-2" } });
    expect((await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } })).status).toBe(429);

    const res = await call(env, "POST", `/api/admin/users/${encodeURIComponent(USER)}/password`, { token: ADMIN, body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { password: string; sessionsEnded: number };
    expect(body.sessionsEnded).toBe(1);
    expect(await whoami(env, s)).toBe(401);
    expect((await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } })).status).toBe(401);
    await signIn(env, USER, body.password);

    const chosen = await call(env, "POST", `/api/admin/users/${encodeURIComponent(USER)}/password`, { token: ADMIN, body: { password: "a-chosen-new-password" } });
    expect(await chosen.json()).not.toHaveProperty("password");
    expect((await call(env, "POST", `/api/admin/users/${encodeURIComponent(USER)}/password`, { token: ADMIN, body: { password: "short" } })).status).toBe(400);
    expect((await call(env, "POST", "/api/admin/users/nobody%40skyphusion.org/password", { token: ADMIN, body: {} })).status).toBe(404);
  });

  it("delete ends the sessions and a second delete is 404", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    const res = await call(env, "DELETE", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN });
    expect(await res.json()).toEqual({ ok: true, deleted: USER, sessionsEnded: 1 });
    expect(await whoami(env, s)).toBe(401);
    expect(sessionCount(raw)).toBe(0);
    expect((await call(env, "DELETE", `/api/admin/users/${encodeURIComponent(USER)}`, { token: ADMIN })).status).toBe(404);
  });

  it("caps the admin body at 4 KiB", async () => {
    const { env } = realEnv();
    const res = await call(env, "POST", "/api/admin/users", { token: ADMIN, raw: JSON.stringify({ username: USER, pad: "x".repeat(5000) }) });
    expect(res.status).toBe(413);
  });
});

// --- the legacy upsert --------------------------------------------------------

describe("#790 POST /api/admin/smtp-credentials (back-compat upsert)", () => {
  it("honors the `password` field the route contract declares", async () => {
    const { env } = realEnv();
    const res = await call(env, "POST", "/api/admin/smtp-credentials", { token: ADMIN, body: { username: USER, password: PASSWORD } });
    expect(res.status).toBe(200);
    await signIn(env);
  });

  it("still honors `secret`, and refuses both when they differ", async () => {
    const { env } = realEnv();
    expect((await call(env, "POST", "/api/admin/smtp-credentials", { token: ADMIN, body: { username: USER, secret: PASSWORD } })).status).toBe(200);
    await signIn(env);
    const both = await call(env, "POST", "/api/admin/smtp-credentials", { token: ADMIN, body: { username: USER, secret: PASSWORD, password: "a-different-password" } });
    expect(both.status).toBe(400);
  });

  it("a rotation ends the user's sessions", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    await call(env, "POST", "/api/admin/smtp-credentials", { token: ADMIN, body: { username: USER, password: "rotated-password-1" } });
    expect(await whoami(env, s)).toBe(401);
  });

  it("the legacy delete ends the user's sessions", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    expect((await call(env, "DELETE", `/api/admin/smtp-credentials/${encodeURIComponent(USER)}`, { token: ADMIN })).status).toBe(200);
    expect(await whoami(env, s)).toBe(401);
  });

  it("reads through the body cap", async () => {
    const { env } = realEnv();
    const res = await call(env, "POST", "/api/admin/smtp-credentials", { token: ADMIN, raw: JSON.stringify({ username: USER, pad: "x".repeat(300_000) }) });
    expect(res.status).toBe(413);
  });
});

// --- sessions follow the account ---------------------------------------------

describe("#790 a session resolves only while its account is active", () => {
  it("a disable written straight to the table (the sign-in/disable race) still kills the session", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    raw.prepare("UPDATE smtp_credentials SET disabled = 1 WHERE username = ?").run(USER);
    expect(await whoami(env, s)).toBe(401);
    expect((await call(env, "GET", "/api/folders", { headers: withSession(s) })).status).toBe(401);
  });

  it("a deleted row kills the session even if its session row survived", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    raw.prepare("DELETE FROM smtp_credentials WHERE username = ?").run(USER);
    expect(await whoami(env, s)).toBe(401);
  });

  it("stores the minting username on the session row", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    await signIn(env, "  ALICE@skyphusion.org ");
    expect((raw.prepare("SELECT username FROM webmail_sessions").get() as { username: string }).username).toBe(USER);
  });
});

// --- enumeration and the hash upgrade ------------------------------------------

describe("#790 no enumeration, per-row hash upgrade", () => {
  it("unknown, disabled and wrong-password sign-ins are indistinguishable", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    await seed(raw, "off@skyphusion.org");
    raw.prepare("UPDATE smtp_credentials SET disabled = 1 WHERE username = ?").run("off@skyphusion.org");
    const answers = [];
    for (const [u, p] of [[USER, "wrong-password-x"], ["ghost@skyphusion.org", PASSWORD], ["off@skyphusion.org", PASSWORD]]) {
      const res = await call(env, "POST", "/api/session", { body: { username: u, password: p } });
      answers.push([res.status, await res.text(), [...res.headers.keys()].sort().join(",")]);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("upgrades a low-iteration hash on a successful sign-in, and only then", async () => {
    const { env, raw } = realEnv();
    const weak = await lowIterationHash(PASSWORD, 1000);
    await seed(raw, USER, PASSWORD, weak);
    await call(env, "POST", "/api/session", { body: { username: USER, password: "wrong-password-x" } });
    expect(row(raw)!.secret_hash).toBe(weak);
    await signIn(env);
    expect(String(row(raw)!.secret_hash)).toMatch(/^pbkdf2\$210000\$/);
    await signIn(env); // still the same password
  });
});

async function lowIterationHash(secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

// --- self-service change password ------------------------------------------------

describe("#790 POST /api/session/password", () => {
  const NEW = "a-brand-new-password";

  it("changes the password, rotates THIS session and ends the others", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const here = await signIn(env);
    const other = await signIn(env);
    const res = await call(env, "POST", "/api/session/password", {
      headers: withSession(here), body: { currentPassword: PASSWORD, newPassword: NEW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const rotated = { id: cookieValue(res, SESSION_COOKIE), csrf: cookieValue(res, CSRF_COOKIE), body };
    expect(rotated.id).toBeTruthy();
    expect(rotated.id).not.toBe(here.id);
    expect(rotated.csrf).not.toBe(here.csrf);
    // Two sessions, change on one: ONE other session ended; the caller's own is rotated,
    // not counted (contract 1.10.5).
    expect(body).toMatchObject({ ok: true, csrfToken: rotated.csrf, sessionsEnded: 1, identity: { from: USER } });

    expect(await whoami(env, here)).toBe(401);   // fixation: the pre-change id is dead
    expect(await whoami(env, other)).toBe(401);  // other devices signed out
    expect(await whoami(env, rotated)).toBe(200);
    expect(sessionCount(raw)).toBe(1);
    expect((await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } })).status).toBe(401);
    await signIn(env, USER, NEW);
  });

  it("with no other session, sessionsEnded is 0 (the caller's rotation is not an ending)", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const only = await signIn(env);
    const res = await call(env, "POST", "/api/session/password", {
      headers: withSession(only), body: { currentPassword: PASSWORD, newPassword: NEW },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionsEnded: 0 });
    expect(await whoami(env, only)).toBe(401);
    expect(sessionCount(raw)).toBe(1);
  });

  it("a wrong current password is 401, is counted, and does not sign the caller out", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    const res = await call(env, "POST", "/api/session/password", { headers: withSession(s), body: { currentPassword: "wrong-password-x", newPassword: NEW } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "E_AUTH_FAILED" });
    expect(await whoami(env, s)).toBe(200);
    const fail = raw.prepare("SELECT failures FROM webmail_auth_failures WHERE scope_key = ?").get("a:" + USER) as { failures: number };
    expect(fail.failures).toBe(1);
  });

  it("shares the sign-in brute-force budget: guessing here locks sign-in too", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "3" });
    await seed(raw);
    const s = await signIn(env);
    for (let i = 0; i < 3; i++) {
      expect((await call(env, "POST", "/api/session/password", { headers: withSession(s), body: { currentPassword: `guess-number-${i}`, newPassword: NEW } })).status).toBe(401);
    }
    const locked = await call(env, "POST", "/api/session/password", { headers: withSession(s), body: { currentPassword: PASSWORD, newPassword: NEW } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(env, "POST", "/api/session", { body: { username: USER, password: PASSWORD } })).status).toBe(429);
  });

  it("refuses without CSRF, with a mismatched CSRF, and cross-site", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    const body = { currentPassword: PASSWORD, newPassword: NEW };
    const noHeader = { cookie: `${SESSION_COOKIE}=${s.id}; ${CSRF_COOKIE}=${s.csrf}` };
    expect((await call(env, "POST", "/api/session/password", { headers: noHeader, body })).status).toBe(403);
    const forged = await call(env, "POST", "/api/session/password", { headers: { ...noHeader, "x-postern-csrf": "forged" }, body });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ error: "E_CSRF" });
    const cross = await call(env, "POST", "/api/session/password", { headers: withSession(s, { "sec-fetch-site": "cross-site" }), body });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ error: "E_CROSS_ORIGIN" });
    await signIn(env); // password unchanged
  });

  it("refuses a Bearer caller and an anonymous one", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    const bearer = await call(env, "POST", "/api/session/password", { token: ADMIN, headers: withSession(s), body: { currentPassword: PASSWORD, newPassword: NEW } });
    expect(bearer.status).toBe(403);
    expect(await bearer.json()).toMatchObject({ error: "E_SESSION_REQUIRED" });
    const anon = await call(env, "POST", "/api/session/password", { body: { currentPassword: PASSWORD, newPassword: NEW } });
    expect(anon.status).toBe(401);
  });

  it("a session minted before migration 0015 must sign in again", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    raw.prepare("UPDATE webmail_sessions SET username = NULL").run();
    const res = await call(env, "POST", "/api/session/password", { headers: withSession(s), body: { currentPassword: PASSWORD, newPassword: NEW } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "E_REAUTH_REQUIRED" });
  });

  it("policy failures are 400 and count nothing", async () => {
    const { env, raw } = realEnv();
    await seed(raw);
    const s = await signIn(env);
    for (const newPassword of ["short", PASSWORD, USER]) {
      const res = await call(env, "POST", "/api/session/password", { headers: withSession(s), body: { currentPassword: PASSWORD, newPassword } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "E_PASSWORD_POLICY" });
    }
    expect((await call(env, "POST", "/api/session/password", { headers: withSession(s), body: { currentPassword: PASSWORD } })).status).toBe(400);
    expect((await call(env, "POST", "/api/session/password", { headers: withSession(s), raw: "{" })).status).toBe(400);
    expect((await call(env, "POST", "/api/session/password", { headers: withSession(s), raw: JSON.stringify({ pad: "x".repeat(5000) }) })).status).toBe(413);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM webmail_auth_failures").get()).toEqual({ n: 0 });
  });
});

// --- migration 0015 -------------------------------------------------------------

describe("#790 migration 0015 (upgrade path)", () => {
  it("adds the columns on a database built from the earlier migrations", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["0004_smtp_credentials.sql", "0010_webmail_sessions.sql", "0015_human_accounts.sql"]) {
      db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), "utf8"));
    }
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("webmail_sessions")).toContain("username");
    expect(cols("smtp_credentials")).toContain("display_name");
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    const freshCols = (t: string) => (fresh.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
    expect(freshCols("webmail_sessions")).toEqual(cols("webmail_sessions").sort());
    expect(freshCols("smtp_credentials")).toEqual(cols("smtp_credentials").sort());
  });
});
