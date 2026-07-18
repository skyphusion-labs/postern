// Webmail v2 session store (#351, epic #338, contract docs/design/webmail-v2-contracts.md
// section 1). A webmail session is a short-lived, DERIVED capability grant with an
// HttpOnly cookie custody and instant server-side revocation -- NOT a second identity
// store. It is minted by verifying an EXISTING credential (phase 2: `native`, the
// smtp_credentials PBKDF2 the submission relay already uses) and resolves to the SAME
// { caps, bound identity } shape a Bearer token does (contract 1.2/1.8), so downstream
// authorization learns no new concept: a session is a third way to arrive at
// { scope/caps, identity }, alongside static tokens and the send registry.
//
// Custody (contract 1.4): an HttpOnly, Secure, SameSite=Lax, same-origin cookie holds
// an OPAQUE server-side session id. We store only the sha256 HASH of that id (same
// discipline as the send registry storing token hashes), so a read of the sessions
// table yields no usable cookie. HttpOnly means an XSS through rendered email cannot
// read the credential; the opaque id is a handle to a server row, so revocation is
// instant (contract D-AUTH-1 / D-SESSION-STORE-1).
//
// CSRF (contract 1.6): a readable companion cookie __Host-postern_csrf carries the raw
// synchronizer token; every state-changing request must echo it in X-Postern-CSRF, and
// the server checks the header EQUALS the companion cookie (double-submit) AND hashes to
// the session row csrf_hash (session binding). Both must pass.
//
// Directory (ldap/system) login is contract 1.9 / decision D-AUTH-2: DEFERRED and
// Conrad-gated, NOT built here. Phase 2 recognizes `native` and `off` only.

import { authenticate } from "./smtpcreds";
import { sha256Hex } from "./sendidentity";
import type { BoundIdentity } from "./sendidentity";

export const SESSION_COOKIE = "__Host-postern_session";
export const CSRF_COOKIE = "__Host-postern_csrf";
export const CSRF_HEADER = "x-postern-csrf";

// The auth backend that mints a session. Phase 2: `native` (smtp_credentials) or
// `off` (no session endpoint; BYO-token only). `ldap`/`system` are contract 1.9,
// deferred (D-AUTH-2), so they are treated as `off` here until that phase lands --
// an honest "sessions disabled", never a half-built directory bind.
export type AuthBackend = "native" | "off";

// DELIBERATE deploy-safety default (design-conformance note D3): UNSET => `off`, not
// `native`. This repo auto-deploys to a live shared store with real smtp_credentials
// rows; defaulting to `native` would silently turn every submission password into a
// webmail session on merge. A self-hoster opts in with WEBMAIL_AUTH_BACKEND=native.
export function webmailAuthBackend(env: Env): AuthBackend {
  const raw = (env.WEBMAIL_AUTH_BACKEND || "").trim().toLowerCase();
  return raw === "native" ? "native" : "off";
}

// Windows (contract 1.5.3). Idle window + absolute cap; expires_at = min(last_seen +
// idle, issued + absolute). Sliding refresh is throttled so a burst writes the row at
// most once per REFRESH_THROTTLE_S (bounds D1 write amplification, C8).
const DEFAULT_IDLE_S = 30 * 60;         // 30 minutes
const DEFAULT_ABSOLUTE_S = 12 * 60 * 60; // 12 hours
const REFRESH_THROTTLE_S = 60;

function idleSeconds(env: Env): number {
  return posInt(env.WEBMAIL_SESSION_IDLE_SECONDS, DEFAULT_IDLE_S);
}
function absoluteSeconds(env: Env): number {
  return posInt(env.WEBMAIL_SESSION_ABSOLUTE_SECONDS, DEFAULT_ABSOLUTE_S);
}
function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// The native session capability set (design-conformance note D2, contract 4). A
// normal hosted account gets read + send + delete (delete meaning empty-its-own-Trash
// within the one shared mailbox, #352) but NOT admin (never reindex or credential
// provisioning; admin is held only by a `both` token). Carried as a SET so the
// authorization gate checks membership rather than collapsing to the single Scope enum.
const NATIVE_SESSION_CAPS = ["read", "send", "delete"];

export interface SessionResolution {
  identity: BoundIdentity;   // the bound From (authoritative sender for this session)
  caps: string[];            // granted capability set, e.g. ["read","send"]
  csrfHash: string;          // sha256hex of the session synchronizer token
  expiresAt: string;         // ISO8601
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

// --- opaque id + hashing ----------------------------------------------------

// 32 bytes of CSPRNG entropy, base64url (no +/=), so the value is a clean cookie token.
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- cookie helpers ---------------------------------------------------------

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Build a Set-Cookie for the __Host- session cookie (HttpOnly). The __Host- prefix
// forces Secure + Path=/ + no Domain, so the cookie cannot be scoped to a parent
// domain or set over plaintext. SameSite=Lax so a top-level navigation to /webmail
// still carries it; writes are additionally CSRF-gated.
function sessionCookie(value: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}
// The companion CSRF cookie is READABLE by JS (not HttpOnly): the page reads it and
// echoes it in X-Postern-CSRF (double-submit). Same __Host- hardening otherwise.
function csrfCookie(value: string, maxAgeS: number): string {
  return `${CSRF_COOKIE}=${value}; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}
function clearCookie(name: string, httpOnly: boolean): string {
  const flags = httpOnly ? "HttpOnly; " : "";
  return `${name}=; ${flags}Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// --- mint / resolve / revoke ------------------------------------------------

interface Minted {
  rawId: string;
  csrfToken: string;
  identity: BoundIdentity;
  caps: string[];
  expiresAt: string;
}

// Verify a native credential and mint a session row. Returns null on a bad credential
// (the caller maps that to a single indistinguishable E_AUTH_FAILED). A fresh opaque id
// is minted every time (session-fixation resistance, contract 1.6): a client-supplied
// id is never adopted.
export async function mintNativeSession(
  env: Env,
  username: string,
  password: string,
): Promise<Minted | null> {
  const from = await authenticate(env, username, password);
  if (!from) return null;

  const rawId = randomToken();
  const csrfToken = randomToken();
  const idHash = await sha256Hex(rawId);
  const csrfHash = await sha256Hex(csrfToken);
  const now = Date.now();
  const idle = idleSeconds(env);
  const absolute = absoluteSeconds(env);
  const issuedAt = new Date(now).toISOString();
  const expiresMs = Math.min(now + idle * 1000, now + absolute * 1000);
  const expiresAt = new Date(expiresMs).toISOString();
  const caps = NATIVE_SESSION_CAPS.slice();

  await env.DB.prepare(
    `INSERT INTO webmail_sessions
       (id_hash, identity, display_name, caps, csrf_hash, issued_at, last_seen_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(idHash, from, null, caps.join(","), csrfHash, issuedAt, issuedAt, expiresAt)
    .run();

  return { rawId, csrfToken, identity: { from }, caps, expiresAt };
}

// Resolve a presented session cookie to its { identity, caps, csrfHash, expiresAt }, or
// null if absent / unknown / revoked / expired. Performs the throttled sliding refresh
// (contract 1.5.3): bump last_seen_at + expires_at only when last_seen is more than
// REFRESH_THROTTLE_S stale, so a burst of requests writes the row at most once a minute.
// expires_at is re-capped at issued_at + absolute, so the absolute cap always holds.
export async function resolveSession(env: Env, rawId: string): Promise<SessionResolution | null> {
  if (!rawId) return null;
  const idHash = await sha256Hex(rawId);
  const row = await env.DB.prepare(
    `SELECT id_hash, identity, display_name, caps, csrf_hash, issued_at, last_seen_at, expires_at, revoked
       FROM webmail_sessions WHERE id_hash = ? LIMIT 1`,
  )
    .bind(idHash)
    .first<SessionRow>();
  if (!row) return null;
  if (row.revoked) return null;

  const now = Date.now();
  const expMs = Date.parse(row.expires_at);
  if (Number.isFinite(expMs) && now >= expMs) return null; // expired: inert until swept

  const identity: BoundIdentity = { from: row.identity };
  if (row.display_name) identity.displayName = row.display_name;
  const caps = row.caps.split(",").map((c) => c.trim()).filter(Boolean);
  let expiresAt = row.expires_at;

  // Throttled sliding refresh.
  const lastSeenMs = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeenMs) || now - lastSeenMs > REFRESH_THROTTLE_S * 1000) {
    const issuedMs = Date.parse(row.issued_at);
    const idle = idleSeconds(env);
    const absolute = absoluteSeconds(env);
    const cap = Number.isFinite(issuedMs) ? issuedMs + absolute * 1000 : now + absolute * 1000;
    const newExpMs = Math.min(now + idle * 1000, cap);
    expiresAt = new Date(newExpMs).toISOString();
    await env.DB.prepare(
      `UPDATE webmail_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?`,
    )
      .bind(new Date(now).toISOString(), expiresAt, idHash)
      .run();
  }

  return { identity, caps, csrfHash: row.csrf_hash, expiresAt };
}

// Revoke the session behind a presented cookie (instant, contract 1.5.3). Deletes the
// row so a re-presented cookie resolves to 401.
export async function revokeSession(env: Env, rawId: string): Promise<void> {
  if (!rawId) return;
  const idHash = await sha256Hex(rawId);
  await env.DB.prepare(`DELETE FROM webmail_sessions WHERE id_hash = ?`).bind(idHash).run();
}

// Sweep expired / revoked rows (contract 1.5.3: a cron-triggerable prune). Rows are
// inert before sweeping (resolveSession rejects them); this is housekeeping only.
// Wiring a scheduled trigger is infra (later); exported so it can be called.
export async function pruneExpiredSessions(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM webmail_sessions WHERE revoked = 1 OR expires_at <= ?`,
  )
    .bind(new Date(Date.now()).toISOString())
    .run();
  return res.meta?.changes ?? 0;
}

// --- CSRF -------------------------------------------------------------------

// Double-submit + session binding (contract 1.6). The presented X-Postern-CSRF header
// must (1) be non-empty, (2) EQUAL the readable __Host-postern_csrf companion cookie
// (a cross-site caller can neither read the cookie nor set a custom header), and (3)
// hash to the session row csrf_hash (binds the token to THIS session). All three hold.
export async function verifyCsrf(request: Request, csrfHash: string): Promise<boolean> {
  const header = (request.headers.get(CSRF_HEADER) || "").trim();
  if (!header) return false;
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookie = cookies[CSRF_COOKIE] || "";
  if (!timingSafeEqual(header, cookie)) return false;
  const presentedHash = await sha256Hex(header);
  return timingSafeEqual(presentedHash, csrfHash);
}

// Read the raw session id from the request cookie (or "" if absent).
export function sessionCookieValue(request: Request): string {
  return parseCookies(request.headers.get("cookie"))[SESSION_COOKIE] || "";
}

// --- the /api/session endpoints ---------------------------------------------

// Handle POST/GET/DELETE /api/session and POST /api/session/refresh. Same-origin only;
// NOT Bearer-gated (login carries no token), so api.ts routes here BEFORE the token
// gate, mirroring /api/smtp-auth. State-changing verbs (DELETE, refresh) are CSRF-gated
// here (they are past the generic gate). Returns null for a path this does not own.
export async function handleSession(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/api/session" && path !== "/api/session/refresh") return null;

  const backend = webmailAuthBackend(env);
  const idle = idleSeconds(env);

  if (path === "/api/session" && request.method === "POST") {
    if (backend === "off") {
      return sjson({ ok: false, error: "E_SESSIONS_DISABLED", authBackend: "off" }, 404);
    }
    let body: { username?: unknown; password?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return sjson({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
    }
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      return sjson({ ok: false, error: "E_FIELD_MISSING", message: "username and password are required" }, 400);
    }
    const minted = await mintNativeSession(env, username, password);
    if (!minted) {
      // Constant-time verify + dummy-hash path (smtpcreds.authenticate) means a
      // bad user and a bad password are indistinguishable: one error, no enumeration.
      return sjson({ ok: false, error: "E_AUTH_FAILED" }, 401);
    }
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", sessionCookie(minted.rawId, idle));
    h.append("set-cookie", csrfCookie(minted.csrfToken, idle));
    return new Response(
      JSON.stringify({
        ok: true,
        identity: { from: minted.identity.from, displayName: minted.identity.displayName },
        capabilities: minted.caps,
        expiresAt: minted.expiresAt,
        csrfToken: minted.csrfToken,
      }),
      { status: 200, headers: h },
    );
  }

  if (path === "/api/session" && request.method === "GET") {
    // whoami / restore. Unauthenticated returns 401 with the authBackend so the client
    // can distinguish sessions-disabled (off -> show BYO-token gate) from logged-out
    // (native -> show the sign-in form). Leaks no identity.
    const rawId = sessionCookieValue(request);
    const resolved = rawId ? await resolveSession(env, rawId) : null;
    if (!resolved) {
      return sjson({ ok: false, authBackend: backend }, 401);
    }
    // Re-set both cookies with a fresh sliding Max-Age so a reload never strands the
    // session or the CSRF companion (contract 1.5.1). The server stores only hashes and
    // cannot re-mint the raw CSRF token, so it echoes the incoming companion cookie; if
    // it is absent the client must re-login to obtain a new one (rare edge).
    const csrfRaw = parseCookies(request.headers.get("cookie"))[CSRF_COOKIE] || "";
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", sessionCookie(rawId, idle));
    if (csrfRaw) h.append("set-cookie", csrfCookie(csrfRaw, idle));
    return new Response(
      JSON.stringify({
        ok: true,
        identity: { from: resolved.identity.from, displayName: resolved.identity.displayName },
        capabilities: resolved.caps,
        expiresAt: resolved.expiresAt,
        csrfToken: csrfRaw || undefined,
      }),
      { status: 200, headers: h },
    );
  }

  if (path === "/api/session" && request.method === "DELETE") {
    // Sign out. State-changing, so CSRF-gated (double-submit + session binding). A
    // logged-in client always holds the companion cookie, so this never strands it.
    const rawId = sessionCookieValue(request);
    const resolved = rawId ? await resolveSession(env, rawId) : null;
    if (resolved && !(await verifyCsrf(request, resolved.csrfHash))) {
      return sjson({ ok: false, error: "E_CSRF" }, 403);
    }
    if (rawId) await revokeSession(env, rawId);
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", clearCookie(SESSION_COOKIE, true));
    h.append("set-cookie", clearCookie(CSRF_COOKIE, false));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
  }

  if (path === "/api/session/refresh" && request.method === "POST") {
    // Explicit extend. Sliding refresh also happens on any authed request; this is the
    // deliberate call. CSRF-gated.
    const rawId = sessionCookieValue(request);
    const resolved = rawId ? await resolveSession(env, rawId) : null;
    if (!resolved) return sjson({ ok: false, error: "E_AUTH_FAILED" }, 401);
    if (!(await verifyCsrf(request, resolved.csrfHash))) {
      return sjson({ ok: false, error: "E_CSRF" }, 403);
    }
    const csrfRaw = parseCookies(request.headers.get("cookie"))[CSRF_COOKIE] || "";
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", sessionCookie(rawId, idle));
    if (csrfRaw) h.append("set-cookie", csrfCookie(csrfRaw, idle));
    return new Response(
      JSON.stringify({ ok: true, expiresAt: resolved.expiresAt }),
      { status: 200, headers: h },
    );
  }

  return sjson({ ok: false, error: "method_not_allowed", message: "unsupported method" }, 405);
}

function sjson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Constant-time string compare (length may leak; bytes must not).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
