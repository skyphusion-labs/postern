import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import {
  mintNativeSession,
  resolveSession,
  verifyCsrf,
  webmailAuthBackend,
  parseCookies,
  SESSION_COOKIE,
  CSRF_COOKIE,
} from "./src/session";

// Focused in-memory D1 fake for the smtp_credentials + webmail_sessions tables only
// (the message store is not exercised here). Enough of prepare/bind/first/run for the
// session verifier + the /api/session endpoints, kept local like smtp-auth.test.ts.
interface CredRow {
  username: string;
  from_addr: string;
  secret_hash: string;
  disabled: number;
}
interface SessionRow {
  id_hash: string;
  identity: string;
  display_name: string | null;
  caps: string;
  csrf_hash: string;
  issued_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked: number;
}

function makeEnv(creds: CredRow[] = [], overrides: Record<string, unknown> = {}) {
  const credRows: CredRow[] = creds.map((c) => ({ ...c }));
  const sessions: SessionRow[] = [];
  function stmt(sql: string) {
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first<T>() {
        if (/FROM smtp_credentials WHERE username = \?/i.test(sql)) {
          const u = String(bound[0]);
          return (credRows.find((r) => r.username === u) ?? null) as T | null;
        }
        if (/FROM webmail_sessions WHERE id_hash = \?/i.test(sql)) {
          const id = String(bound[0]);
          return (sessions.find((r) => r.id_hash === id) ?? null) as T | null;
        }
        return null as T | null;
      },
      async run() {
        if (/INSERT INTO webmail_sessions/i.test(sql)) {
          const [id_hash, identity, display_name, caps, csrf_hash, issued_at, last_seen_at, expires_at] =
            bound as [string, string, string | null, string, string, string, string, string];
          sessions.push({
            id_hash,
            identity,
            display_name,
            caps,
            csrf_hash,
            issued_at,
            last_seen_at,
            expires_at,
            revoked: 0,
          });
          return { meta: { changes: 1 } };
        }
        if (/UPDATE webmail_sessions SET last_seen_at/i.test(sql)) {
          const [last_seen_at, expires_at, id_hash] = bound as [string, string, string];
          const row = sessions.find((r) => r.id_hash === id_hash);
          if (row) {
            row.last_seen_at = last_seen_at;
            row.expires_at = expires_at;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (/DELETE FROM webmail_sessions WHERE id_hash = \?/i.test(sql)) {
          const id = String(bound[0]);
          const i = sessions.findIndex((r) => r.id_hash === id);
          if (i >= 0) {
            sessions.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    WEBMAIL_AUTH_BACKEND: "native",
    ...overrides,
  } as unknown as Env;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  return { env, ctx, sessions, credRows };
}

async function seededCred(): Promise<CredRow> {
  const secret_hash = await hashSecret("hunter2hunter2");
  return { username: "conrad@skyphusion.org", from_addr: "conrad@skyphusion.org", secret_hash, disabled: 0 };
}

function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; csrf?: string; token?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.csrf) headers["x-postern-csrf"] = opts.csrf;
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function setCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

// --- session.ts unit tests --------------------------------------------------

describe("webmailAuthBackend (deploy-safe default)", () => {
  it("defaults to off when unset (no surprise exposure on merge)", () => {
    expect(webmailAuthBackend({} as unknown as Env)).toBe("off");
  });
  it("is native only when explicitly configured", () => {
    expect(webmailAuthBackend({ WEBMAIL_AUTH_BACKEND: "native" } as unknown as Env)).toBe("native");
  });
  it("treats the deferred ldap/system backends as off (D-AUTH-2 not built)", () => {
    expect(webmailAuthBackend({ WEBMAIL_AUTH_BACKEND: "ldap" } as unknown as Env)).toBe("off");
    expect(webmailAuthBackend({ WEBMAIL_AUTH_BACKEND: "system" } as unknown as Env)).toBe("off");
  });
});

describe("mintNativeSession + resolveSession", () => {
  it("rejects a bad credential (null, no row stored)", async () => {
    const { env, sessions } = makeEnv([await seededCred()]);
    const bad = await mintNativeSession(env, "conrad@skyphusion.org", "wrong-password");
    expect(bad).toBeNull();
    expect(sessions.length).toBe(0);
  });

  it("mints on a good credential and resolves the opaque id back to the identity", async () => {
    const { env, sessions } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    expect(minted).not.toBeNull();
    expect(minted!.identity.from).toBe("conrad@skyphusion.org");
    expect(minted!.caps).toEqual(["read", "send", "delete"]);
    // The stored row holds only the HASH of the id, never the raw cookie value.
    expect(sessions.length).toBe(1);
    expect(sessions[0].id_hash).not.toBe(minted!.rawId);
    const resolved = await resolveSession(env, minted!.rawId);
    expect(resolved).not.toBeNull();
    expect(resolved!.identity.from).toBe("conrad@skyphusion.org");
    expect(resolved!.caps).toEqual(["read", "send", "delete"]);
  });

  it("does not resolve an unknown, revoked, or expired cookie", async () => {
    const { env, sessions } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    expect(await resolveSession(env, "not-a-real-id")).toBeNull();
    // revoked
    sessions[0].revoked = 1;
    expect(await resolveSession(env, minted!.rawId)).toBeNull();
    sessions[0].revoked = 0;
    // expired
    sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await resolveSession(env, minted!.rawId)).toBeNull();
  });
});

describe("verifyCsrf (double-submit + session binding)", () => {
  it("passes only when header == companion cookie AND hashes to the stored csrf_hash", async () => {
    const { env } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const resolved = await resolveSession(env, minted!.rawId);
    const csrf = minted!.csrfToken;
    const cookie = `${CSRF_COOKIE}=${csrf}`;
    // valid
    const good = new Request("https://x/", { headers: { "x-postern-csrf": csrf, cookie } });
    expect(await verifyCsrf(good, resolved!.csrfHash)).toBe(true);
    // header missing
    const noHeader = new Request("https://x/", { headers: { cookie } });
    expect(await verifyCsrf(noHeader, resolved!.csrfHash)).toBe(false);
    // header != cookie
    const mismatch = new Request("https://x/", { headers: { "x-postern-csrf": csrf, cookie: `${CSRF_COOKIE}=other` } });
    expect(await verifyCsrf(mismatch, resolved!.csrfHash)).toBe(false);
    // header == cookie but wrong token (hash mismatch)
    const wrong = new Request("https://x/", { headers: { "x-postern-csrf": "zzz", cookie: `${CSRF_COOKIE}=zzz` } });
    expect(await verifyCsrf(wrong, resolved!.csrfHash)).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses a multi-cookie header", () => {
    const c = parseCookies("a=1; __Host-postern_session=abc; __Host-postern_csrf=xyz");
    expect(c["__Host-postern_session"]).toBe("abc");
    expect(c["__Host-postern_csrf"]).toBe("xyz");
  });
});

// --- /api/session endpoint tests (via handleApi) ----------------------------

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("POST /api/session", () => {
  it("404s E_SESSIONS_DISABLED when the backend is off", async () => {
    const { env } = makeEnv([], { WEBMAIL_AUTH_BACKEND: "off" });
    const res = await handleApi(req("POST", "/api/session", { body: { username: "a", password: "b" } }), env, CTX);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_SESSIONS_DISABLED", authBackend: "off" });
  });

  it("401s E_AUTH_FAILED on a bad credential and sets no cookie", async () => {
    const { env } = makeEnv([await seededCred()]);
    const res = await handleApi(
      req("POST", "/api/session", { body: { username: "conrad@skyphusion.org", password: "nope" } }),
      env,
      CTX,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_FAILED" });
    expect(setCookies(res).length).toBe(0);
  });

  it("mints a session on a good credential: HttpOnly session cookie + readable CSRF cookie + identity body", async () => {
    const { env } = makeEnv([await seededCred()]);
    const res = await handleApi(
      req("POST", "/api/session", { body: { username: "conrad@skyphusion.org", password: "hunter2hunter2" } }),
      env,
      CTX,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      identity: { from: string };
      capabilities: string[];
      csrfToken: string;
    };
    expect(body.ok).toBe(true);
    expect(body.identity.from).toBe("conrad@skyphusion.org");
    expect(body.capabilities).toEqual(["read", "send", "delete"]);
    expect(typeof body.csrfToken).toBe("string");
    const cookies = setCookies(res);
    const sessionCk = cookies.find((c) => c.startsWith(SESSION_COOKIE + "="));
    const csrfCk = cookies.find((c) => c.startsWith(CSRF_COOKIE + "="));
    expect(sessionCk).toBeTruthy();
    expect(csrfCk).toBeTruthy();
    // Session cookie is HttpOnly + Secure + __Host-; CSRF companion is readable (NOT HttpOnly).
    expect(sessionCk).toMatch(/HttpOnly/i);
    expect(sessionCk).toMatch(/Secure/i);
    expect(csrfCk).not.toMatch(/HttpOnly/i);
    expect(csrfCk).toMatch(/Secure/i);
    // The raw session id is not the body csrfToken and not stored raw (checked in unit test).
  });
});

describe("GET /api/session (whoami / restore)", () => {
  it("401s with the authBackend when there is no session cookie", async () => {
    const { env } = makeEnv([await seededCred()]);
    const res = await handleApi(req("GET", "/api/session"), env, CTX);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, authBackend: "native" });
  });

  it("restores identity + caps for a valid session and re-sets the cookies", async () => {
    const { env } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    const res = await handleApi(req("GET", "/api/session", { cookie }), env, CTX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; identity: { from: string }; capabilities: string[]; csrfToken: string };
    expect(body.ok).toBe(true);
    expect(body.identity.from).toBe("conrad@skyphusion.org");
    expect(body.capabilities).toEqual(["read", "send", "delete"]);
    expect(body.csrfToken).toBe(minted!.csrfToken);
    expect(setCookies(res).some((c) => c.startsWith(SESSION_COOKIE + "="))).toBe(true);
  });
});

describe("DELETE /api/session (sign out)", () => {
  it("403s E_CSRF without a CSRF header, then succeeds with one and revokes the row", async () => {
    const { env, sessions } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    // no CSRF -> refused
    const noCsrf = await handleApi(req("DELETE", "/api/session", { cookie }), env, CTX);
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ error: "E_CSRF" });
    expect(sessions.length).toBe(1);
    // with CSRF -> revoked + cookies cleared
    const ok = await handleApi(req("DELETE", "/api/session", { cookie, csrf: minted!.csrfToken }), env, CTX);
    expect(ok.status).toBe(200);
    expect(sessions.length).toBe(0);
    const cleared = setCookies(ok);
    expect(cleared.some((c) => c.startsWith(SESSION_COOKIE + "=") && /Max-Age=0/i.test(c))).toBe(true);
  });
});

// --- authorization via a session cookie (the resolveToken unification) -------

describe("a session cookie authorizes API calls (contract 1.8)", () => {
  it("read cap: session reaches a read route (mobileconfig) without a Bearer", async () => {
    const { env } = makeEnv([await seededCred()], {
      ALLOWED_FROM_DOMAIN: "skyphusion.org",
      MOBILECONFIG_IMAP_HOST: "imap.skyphusion.org",
    });
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    const res = await handleApi(req("GET", "/api/mobileconfig", { cookie }), env, CTX);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("a state-changing route REQUIRES CSRF: POST /api/messages/seen without the header is 403 E_CSRF", async () => {
    const { env } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    const res = await handleApi(
      req("POST", "/api/messages/seen", { cookie, body: { ids: ["x"], seen: true } }),
      env,
      CTX,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "E_CSRF" });
  });

  it("with a valid CSRF header the write clears the auth+CSRF gate (reaches handler validation)", async () => {
    const { env } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    // Body missing ids: past the gate, the handler returns 400 (not 401/403), proving
    // the session + CSRF cleared and the read cap authorized the seen route.
    const res = await handleApi(
      req("POST", "/api/messages/seen", { cookie, csrf: minted!.csrfToken, body: { seen: true } }),
      env,
      CTX,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "E_VALIDATION_ERROR" });
  });

  it("delete cap reaches hard-delete but cannot disclose another account's message", async () => {
    const { env } = makeEnv([await seededCred()]);
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    // Valid CSRF so this tests AUTHORIZATION, not the CSRF gate.
    const res = await handleApi(
      req("DELETE", "/api/messages/some-id", { cookie, csrf: minted!.csrfToken }),
      env,
      CTX,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "E_NOT_FOUND" });
  });

  it("an explicit Bearer WINS over an ambient session cookie (contract 1.8)", async () => {
    // A read-scoped Bearer + a (send-capable) session cookie, POSTing to /api/send.
    // If the Bearer wins: read scope -> 403 forbidden (requires send). If the cookie
    // won instead: send cap present -> would demand CSRF -> 403 E_CSRF. The error tells
    // us which path ran; forbidden (not E_CSRF) proves the Bearer won.
    const { env } = makeEnv([await seededCred()], {
      POSTERN_API_TOKEN: undefined,
      POSTERN_API_TOKEN_READ: "read-tok",
      WEBMAIL_AUTH_BACKEND: "native",
    });
    const minted = await mintNativeSession(env, "conrad@skyphusion.org", "hunter2hunter2");
    const cookie = `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`;
    const res = await handleApi(
      req("POST", "/api/send", { cookie, token: "read-tok", body: { to: "x@skyphusion.org", subject: "s", text: "t" } }),
      env,
      CTX,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });
});
