// The mailbox HTTP API (docs/CONTRACT.md section 4). The write half (send/reply,
// #26) and just enough of the read half to make M2 verifiable end to end
// (get one message, get a thread). The full M1 read surface (list/search/
// pagination, #24/#25) attaches to the same store next.
//
// Token-gated, constant-time compared. The default posture is egalitarian: one
// mailbox token (POSTERN_API_TOKEN) sends AND receives. Optionally an operator can
// provision per-function scoped tokens (#85) to bound a leaked credential's blast
// radius: POSTERN_API_TOKEN_READ reaches only the read door (GET messages/search/
// threads/attachments), POSTERN_API_TOKEN_SEND only the write door (POST send/
// reply). The unscoped POSTERN_API_TOKEN stays a `both` token, so with only it set
// the whole surface behaves exactly as before. Credential-admin routes are the
// most privileged and are reachable ONLY by a `both` token.

import * as store from "./store";
import { send, reply, MailboxError, type SendRequest, type ReplyRequest } from "./mailbox";
import { serveWebmail } from "./webmail";
import {
  authenticate,
  upsert as upsertCredential,
  remove as removeCredential,
  hashSecret,
  generateSecret,
  normalizeUsername,
} from "./smtpcreds";

// Failure codes that represent a transient upstream condition (the transport /
// provider) rather than a bad request; mapped to 502 so callers can retry.
const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"]);

// Cap the JSON body so a single request cannot exhaust worker memory. CF Email
// Sending caps a message near 25 MiB; bound a little above so a max-size message
// still passes.
const MAX_BODY_BYTES = 30 * 1024 * 1024;

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && (path === "/" || path === "/health")) {
    return json({ ok: true, service: "postern" });
  }

  // The read-only webmail (the human browser door, complementing the IMAP proxy).
  // Public: the page carries no secret; the operator enters their API origin +
  // token client-side and it is used only for the token-gated /api calls below.
  if (request.method === "GET" && (path === "/webmail" || path === "/webmail/")) {
    return serveWebmail();
  }

  // SMTP submission auth check (#68). Gated by the TRANSPORT token, NOT the
  // mailbox API token: the submission relay is an infra seam, not an API client
  // (CONTRACT section 5/9). Handled before the API-token gate below so the relay
  // never needs the mailbox API token to validate a login.
  if (request.method === "POST" && path === "/api/smtp-auth") {
    return handleSmtpAuth(request, env);
  }

  // Everything under /api (and the back-compat /send alias) requires a token.
  const isApi = path === "/send" || path.startsWith("/api/");
  if (!isApi) return json({ ok: false, error: "not_found" }, 404);

  // Resolve the presented bearer to its scope (read / send / both), then authorize
  // per route/method (#85). An absent or unknown token is 401; a known token used
  // outside its scope is 403. With only POSTERN_API_TOKEN set it resolves to `both`
  // and every route is permitted, exactly as before this change.
  const scope = resolveScope(request, env);
  if (scope === null) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const need = requiredScope(request.method, path);
  if (need !== null && !scopeSatisfies(scope, need)) {
    return json({ ok: false, error: "forbidden", message: `requires ${need} scope` }, 403);
  }

  try {
    // --- write: send ---
    if (request.method === "POST" && (path === "/api/send" || path === "/send")) {
      const body = await readJson<SendRequest>(request);
      const result = await send(env, body, ctx);
      return json({ ok: true, ...result });
    }

    // --- write: reply ---
    if (request.method === "POST" && path === "/api/reply") {
      const body = await readJson<ReplyRequest>(request);
      const result = await reply(env, body, ctx);
      return json({ ok: true, ...result });
    }

    // --- admin: provision / rotate an SMTP submission credential (#68) ---
    // Operator action, gated by a `both`-scoped mailbox token (this block is past
    // the scope check above). Mints or rotates a per-user submission credential and
    // returns the secret ONCE; only the PBKDF2 hash is stored.
    if (request.method === "POST" && path === "/api/admin/smtp-credentials") {
      return await handleCredentialUpsert(request, env);
    }

    // --- admin: backfill / re-embed the mailbox into Vectorize (#116 ws4) ---
    // Operator action (both-scoped). Processes ONE keyset page per call and returns
    // a cursor; a thin runner loops until done. Idempotent (deterministic vector
    // ids overwrite), so safe to resume/repeat; dryRun counts the cost first.
    if (request.method === "POST" && path === "/api/admin/reindex") {
      return await handleReindex(request, env);
    }

    // --- admin: revoke an SMTP submission credential ---
    const credMatch =
      request.method === "DELETE" ? /^\/api\/admin\/smtp-credentials\/(.+)$/.exec(path) : null;
    if (credMatch) {
      const username = decodeURIComponent(credMatch[1]);
      const deleted = await removeCredential(env, username);
      if (!deleted) return json({ ok: false, error: "E_NOT_FOUND", message: "no such credential" }, 404);
      return json({ ok: true, deleted: normalizeUsername(username) });
    }

    // --- read: list / filter ---
    if (request.method === "GET" && (path === "/api/messages" || path === "/api/messages/")) {
      const page = await store.list(env, parseListQuery(url));
      return json({ ok: true, ...page });
    }

    // --- read: search ---
    if (request.method === "GET" && path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ ok: false, error: "E_FIELD_MISSING", message: "q is required" }, 400);
      const modeParam = url.searchParams.get("mode") ?? undefined;
      // #128: an optional direction filter, mirroring /api/messages. An invalid
      // value is ignored (treated as unset), not an error.
      const dir = url.searchParams.get("direction");
      const page = await store.search(env, {
        q,
        mode: modeParam as "fts" | "semantic" | "hybrid" | undefined,
        limit: parseLimit(url),
        cursor: url.searchParams.get("cursor") ?? undefined,
        direction: dir === "inbound" || dir === "outbound" ? dir : undefined,
      });
      return json({ ok: true, ...page });
    }

    // --- read: attachment bytes ---
    // GET /api/messages/{id}/attachments/{i} -- stream the i-th attachment from R2.
    // Matched before the single-message handler since that one also starts with
    // /api/messages/. The id may itself contain no slash (message-ids are addr-like),
    // so split on the literal /attachments/ segment.
    const attMatch = request.method === "GET" ? /^\/api\/messages\/(.+)\/attachments\/(\d+)$/.exec(path) : null;
    if (attMatch) {
      const id = decodeURIComponent(attMatch[1]);
      const index = Number(attMatch[2]);
      const att = await store.getAttachment(env, id, index);
      if (!att) return json({ ok: false, error: "E_NOT_FOUND", message: "attachment not found" }, 404);
      // Force a download with a sanitized filename; never echo the raw filename
      // into the header unescaped (header-injection / quote-break safe).
      const safeName = (att.filename || `attachment-${index}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
      return new Response(att.body, {
        status: 200,
        headers: {
          "content-type": att.mime || "application/octet-stream",
          "content-disposition": `attachment; filename="${safeName}"`,
          "content-length": String(att.size),
          // Untrusted bytes: do not let the browser sniff/execute them inline.
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }

    // --- read: one message ---
    if (request.method === "GET" && path.startsWith("/api/messages/")) {
      const id = decodeURIComponent(path.slice("/api/messages/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "message id required" }, 400);
      const msg = await store.get(env, id);
      if (!msg) return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      return json({ ok: true, message: msg });
    }

    // --- read: a thread ---
    if (request.method === "GET" && path.startsWith("/api/threads/")) {
      const id = decodeURIComponent(path.slice("/api/threads/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "thread id required" }, 400);
      const messages = await store.thread(env, id);
      return json({ ok: true, threadId: id, messages });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseListQuery(url: URL): import("./store").ListQuery {
  const p = url.searchParams;
  const dir = p.get("direction");
  return {
    to: p.get("to") ?? undefined,
    from: p.get("from") ?? undefined,
    thread: p.get("thread") ?? undefined,
    direction: dir === "inbound" || dir === "outbound" ? dir : undefined,
    q: p.get("q") ?? undefined,
    limit: parseLimit(url),
    cursor: p.get("cursor") ?? undefined,
  };
}

// Email shape check (linear, no ReDoS) mirroring mailbox.ts, used to validate a
// provisioned bound From identity.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

// POST /api/smtp-auth: the submission relay validates a client login here. Gated
// by the transport token. Returns { ok:true, from } on success (the bound From
// identity the daemon then enforces), { ok:false } on a bad credential.
async function handleSmtpAuth(request: Request, env: Env): Promise<Response> {
  if (!transportAuthorized(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  let body: { username?: unknown; secret?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; secret?: unknown };
  } catch {
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
  }
  const username = typeof body.username === "string" ? body.username : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!username || !secret) {
    return json({ ok: false, error: "E_FIELD_MISSING", message: "username and secret are required" }, 400);
  }
  const from = await authenticate(env, username, secret);
  if (!from) {
    // Valid transport token but a bad credential: 200 ok:false, so the relay maps
    // it to an SMTP 535 (auth failed) and not to its own config error (401).
    return json({ ok: false, error: "E_AUTH_FAILED" });
  }
  return json({ ok: true, from });
}

// POST /api/admin/smtp-credentials: create or rotate a credential. The secret is
// returned once in the response (so the operator can hand it to the user) and is
// otherwise only stored as a PBKDF2 hash, never logged.
async function handleCredentialUpsert(request: Request, env: Env): Promise<Response> {
  let body: { username?: unknown; from?: unknown; secret?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; from?: unknown; secret?: unknown };
  } catch {
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
  }
  const username = normalizeUsername(typeof body.username === "string" ? body.username : "");
  if (!username) return json({ ok: false, error: "E_FIELD_MISSING", message: "username is required" }, 400);

  const fromAddr = (typeof body.from === "string" && body.from.trim() ? body.from.trim() : username).toLowerCase();
  const allowedDomain = (env.ALLOWED_FROM_DOMAIN || "skyphusion.org").toLowerCase();
  if (!EMAIL_RE.test(fromAddr) || fromAddr.split("@")[1] !== allowedDomain) {
    return json(
      { ok: false, error: "E_SENDER_NOT_ALLOWED", message: `from must be a valid address on @${allowedDomain}` },
      400,
    );
  }

  let secret = typeof body.secret === "string" ? body.secret : "";
  if (secret && secret.length < 12) {
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: "secret must be at least 12 characters" }, 400);
  }
  if (!secret) secret = generateSecret();

  const hash = await hashSecret(secret);
  await upsertCredential(env, username, fromAddr, hash, new Date().toISOString());
  return json({ ok: true, username, from: fromAddr, secret });
}

// POST /api/admin/reindex: backfill the Vectorize index over the existing mailbox
// (#116 ws4). Processes one keyset page per call (await the embeds so the page
// finishes inside request limits) and returns a cursor; the runner loops until
// done:true. Body: { cursor?, limit?, dryRun? }. Idempotent (deterministic vector
// ids overwrite); dryRun totals the chunk count WITHOUT embedding.
async function handleReindex(request: Request, env: Env): Promise<Response> {
  let body: { cursor?: unknown; limit?: unknown; dryRun?: unknown } = {};
  if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
    }
  }
  const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const dryRun = body.dryRun === true;
  const result = await store.reindexPage(env, { cursor, limit, dryRun });
  return json({ ok: true, ...result });
}

// Constant-time Bearer compare against the TRANSPORT token (POSTERN_TRANSPORT_TOKEN),
// the infra-seam credential, distinct from the mailbox API token.
function transportAuthorized(request: Request, env: Env): boolean {
  const token = env.POSTERN_TRANSPORT_TOKEN || "";
  const auth = request.headers.get("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token.length > 0 && timingSafeEqual(got, token);
}

// --- Per-function token scopes (#85) ---

// The scope a presented mailbox token carries. `both` is the egalitarian default
// (one key sends and receives, the back-compat path); `read` and `send` are the
// optional per-function hardening that bounds a leaked token's blast radius.
type Scope = "read" | "send" | "both";

// The scope a route/method demands. `admin` (credential provisioning) is strictly
// more privileged than send and is satisfied ONLY by a `both` token.
type RouteScope = "read" | "send" | "admin";

// Map the method+path to the scope it requires, mirroring the route table in
// handleApi exactly. Returns null for any path with no API handler, so (once the
// token itself is valid) it falls through to the same 404 as before.
function requiredScope(method: string, path: string): RouteScope | null {
  if (method === "POST" && (path === "/api/send" || path === "/send")) return "send";
  if (method === "POST" && path === "/api/reply") return "send";
  if (method === "POST" && path === "/api/admin/smtp-credentials") return "admin";
  if (method === "DELETE" && /^\/api\/admin\/smtp-credentials\/(.+)$/.test(path)) return "admin";
  // Reindex/backfill is the most privileged: a new /api/admin/* path is NOT
  // covered automatically (unknown paths fall through to null), so it is mapped
  // here explicitly as `admin` -- a read or send token must never reach it (#85).
  if (method === "POST" && path === "/api/admin/reindex") return "admin";
  if (method === "GET" && (path === "/api/messages" || path === "/api/messages/")) return "read";
  if (method === "GET" && path === "/api/search") return "read";
  // Single message and the /attachments/{i} sub-route both live under here.
  if (method === "GET" && path.startsWith("/api/messages/")) return "read";
  if (method === "GET" && path.startsWith("/api/threads/")) return "read";
  return null;
}

// A `both` token satisfies every route; a scoped token satisfies only its own
// kind. `admin` is satisfied solely by `both`: read/send tokens cannot reach the
// credential-provisioning routes.
function scopeSatisfies(have: Scope, need: RouteScope): boolean {
  if (have === "both") return true;
  if (need === "read") return have === "read";
  if (need === "send") return have === "send";
  return false; // admin: only `both`
}

// Resolve the Authorization bearer to the scope of the configured token it matches,
// or null if it matches none. The token is read from the Authorization header only,
// never the URL/query. Every configured token is compared constant-time and the
// loop does not break on a match, so the check does not leak WHICH token matched
// via timing; the token LENGTH may leak (tokens are high-entropy), the bytes must
// not. Precedence is fixed (both, then read, then send): distinct per-function
// values are expected, so at most one matches, but on an accidental value
// collision the more-permissive `both` wins to avoid locking out the primary key.
function resolveScope(request: Request, env: Env): Scope | null {
  const auth = request.headers.get("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (got.length === 0) return null;

  const candidates: Array<[Scope, string]> = [
    ["both", env.POSTERN_API_TOKEN || env.RELAY_TOKEN || ""],
    ["read", env.POSTERN_API_TOKEN_READ || ""],
    ["send", env.POSTERN_API_TOKEN_SEND || ""],
  ];

  let matched: Scope | null = null;
  for (const [scope, token] of candidates) {
    const eq = token.length > 0 && timingSafeEqual(got, token);
    if (eq && matched === null) matched = scope;
  }
  return matched;
}

async function readJson<T>(request: Request): Promise<T> {
  const declaredLen = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    throw new MailboxError("E_PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new MailboxError("E_VALIDATION_ERROR", "invalid JSON body");
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof MailboxError) {
    return json({ ok: false, error: err.code, message: err.message }, err.status);
  }
  // Errors thrown by the EMAIL binding / transport carry a .code (E_* string).
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : "send failed";
  const status = RETRYABLE.has(code) ? 502 : 400;
  return json({ ok: false, error: code, message }, status);
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "E_INTERNAL_SERVER_ERROR";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Constant-time compare so the auth check does not leak the token byte by byte
// via timing. Length may leak (tokens are high-entropy); the bytes must not.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
