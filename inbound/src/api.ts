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
import { ingest, type ParsedInbound } from "./ingest";
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
import { resolveRegistryIdentity, type Scope, type TokenResolution } from "./sendidentity";
import { readBodyCapped, PayloadTooLargeError } from "./body";
import { handleMobileconfig } from "./mobileconfig";
import { handleMtaSts } from "./mtasts";

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

  // MTA-STS policy (#197, RFC 8461), served on the mta-sts.<domain> host. ANONYMOUS
  // by design: senders fetch it over HTTPS with NO auth, so it is handled BEFORE the
  // token gate and must never be token-gated. Dark by default -- returns 404 unless
  // MTA_STS_MODE is configured (see docs/MTA-STS.md). The route is wired to the
  // mta-sts host in the supervised deploy window, not in this worker's default routes.
  if (request.method === "GET" && path === "/.well-known/mta-sts.txt") {
    return handleMtaSts(request, env);
  }

  // SMTP submission auth check (#68). Gated by the TRANSPORT token, NOT the
  // mailbox API token: the submission relay is an infra seam, not an API client
  // (CONTRACT section 5/9). Handled before the API-token gate below so the relay
  // never needs the mailbox API token to validate a login.
  if (request.method === "POST" && path === "/api/smtp-auth") {
    return handleSmtpAuth(request, env);
  }

  // The out-of-Worker inbound driver (CONTRACT section 2, #22/#29): POST /ingest
  // accepts a ParsedInbound JSON body from a transport that does NOT run inside CF
  // Email Routing (postern-relay's SMTP intake). It sits OUTSIDE /api/, gated by
  // the TRANSPORT token (an infra seam, not the mailbox API token), so it is
  // handled before the API-token gate below -- mirroring /api/smtp-auth. No
  // forward() here: forwarding is in-Worker only (it needs the live
  // ForwardableEmailMessage; section 2). A non-POST is a clean 405.
  if (path === "/ingest") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed", message: "POST only" }, 405);
    }
    return handleIngest(request, env, ctx);
  }

  // Everything under /api (and the back-compat /send alias) requires a token.
  const isApi = path === "/send" || path.startsWith("/api/");
  if (!isApi) return json({ ok: false, error: "not_found" }, 404);

  // Resolve the presented bearer to its scope (read / send / both), then authorize
  // per route/method (#85). An absent or unknown token is 401; a known token used
  // outside its scope is 403. With only POSTERN_API_TOKEN set it resolves to `both`
  // and every route is permitted, exactly as before this change.
  const resolution = await resolveToken(request, env);
  if (resolution === null) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const need = requiredScope(request.method, path);
  if (need !== null && !scopeSatisfies(resolution.scope, need)) {
    return json({ ok: false, error: "forbidden", message: `requires ${need} scope` }, 403);
  }

  try {
    // --- write: send ---
    if (request.method === "POST" && (path === "/api/send" || path === "/send")) {
      const body = await readJson<SendRequest>(request);
      const result = await send(env, body, ctx, resolution.identity);
      return json({ ok: true, ...result });
    }

    // --- write: reply ---
    if (request.method === "POST" && path === "/api/reply") {
      const body = await readJson<ReplyRequest>(request);
      const result = await reply(env, body, ctx, resolution.identity);
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

    // --- read: per-user Apple .mobileconfig profile (#187, iOS Mail one-tap setup) ---
    // Read-scoped: the profile bakes in NO password (iOS prompts on install), so it
    // emits no secret. Non-GET is a clean 405 (a valid token reaches here; an
    // unauthenticated request is 401 at the token gate above, auth before method).
    if (path === "/api/mobileconfig") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "method_not_allowed", message: "GET only" }, 405);
      }
      return handleMobileconfig(request, env);
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
      // Optional direction filter (#128): validate strictly (inbound|outbound), so
      // a typo is a clean 400 rather than a silently-ignored filter.
      const dirParam = url.searchParams.get("direction");
      if (dirParam !== null && dirParam !== "inbound" && dirParam !== "outbound") {
        return json(
          { ok: false, error: "E_VALIDATION_ERROR", message: "direction must be inbound or outbound" },
          400,
        );
      }
      const page = await store.search(env, {
        q,
        mode: modeParam as "fts" | "semantic" | "hybrid" | undefined,
        direction: dirParam === null ? undefined : dirParam,
        limit: parseLimit(url),
        cursor: url.searchParams.get("cursor") ?? undefined,
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

// POST /ingest: the out-of-Worker inbound driver (CONTRACT section 2). Transport-
// token gated and FAIL-CLOSED -- transportAuthorized returns false when
// POSTERN_TRANSPORT_TOKEN is unbound, so an unset secret refuses (never opens).
// Reads the body through the M7 streaming cap (413 on over-cap), parses the
// ParsedInbound JSON (from + to required; attachment content is base64 over JSON,
// decoded to ArrayBuffer here), and hands to ingest(). The M8 fidelity fields
// (toHeader/cc/sender/replyTo/rawSize) flow through ingest()'s mapping untouched.
async function handleIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!transportAuthorized(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  try {
    const body = await readJson<unknown>(request);
    const parsed = parseIngestBody(body);
    const result = await ingest(env, parsed, ctx);
    return json({
      ok: true,
      messageId: result.messageId,
      stored: result.stored,
      merged: result.merged,
      threadId: result.threadId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// Validate + normalize an /ingest JSON body into a ParsedInbound. from + to are
// required (E_FIELD_MISSING); attachment `content` is standard base64 over JSON
// and is decoded to an ArrayBuffer (malformed base64 = E_VALIDATION_ERROR). auth
// is optional -- an absent/partial verdict set defaults to none, i.e. ingest()'s
// allowlist-only trust path (an SMTP transport gets no implicit pass).
function parseIngestBody(raw: unknown): ParsedInbound {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MailboxError("E_VALIDATION_ERROR", "request body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  const from = typeof b.from === "string" ? b.from.trim() : "";
  const to = typeof b.to === "string" ? b.to.trim() : "";
  if (!from || !to) {
    throw new MailboxError("E_FIELD_MISSING", "from and to are required");
  }

  const parsed: ParsedInbound = { from, to };
  if (typeof b.messageId === "string") parsed.messageId = b.messageId;
  if (typeof b.subject === "string") parsed.subject = b.subject;
  if (typeof b.date === "string") parsed.date = b.date;
  if (typeof b.inReplyTo === "string") parsed.inReplyTo = b.inReplyTo;
  if (Array.isArray(b.references)) {
    parsed.references = b.references.filter((r): r is string => typeof r === "string");
  }
  if (typeof b.text === "string") parsed.text = b.text;
  if (typeof b.html === "string") parsed.html = b.html;
  // M8 envelope fidelity v2 (section 10.4): raw decoded header strings + wire size.
  if (typeof b.toHeader === "string") parsed.toHeader = b.toHeader;
  if (typeof b.cc === "string") parsed.cc = b.cc;
  if (typeof b.sender === "string") parsed.sender = b.sender;
  if (typeof b.replyTo === "string") parsed.replyTo = b.replyTo;
  if (typeof b.rawSize === "number" && Number.isFinite(b.rawSize)) parsed.rawSize = b.rawSize;

  if (b.auth && typeof b.auth === "object" && !Array.isArray(b.auth)) {
    const a = b.auth as Record<string, unknown>;
    parsed.auth = {
      spf: typeof a.spf === "string" ? a.spf : undefined,
      dkim: typeof a.dkim === "string" ? a.dkim : undefined,
      dmarc: typeof a.dmarc === "string" ? a.dmarc : undefined,
    };
  }

  if (b.attachments !== undefined) {
    if (!Array.isArray(b.attachments)) {
      throw new MailboxError("E_VALIDATION_ERROR", "attachments must be an array");
    }
    const out: NonNullable<ParsedInbound["attachments"]> = [];
    for (let i = 0; i < b.attachments.length; i++) {
      const item = b.attachments[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new MailboxError("E_VALIDATION_ERROR", `attachment ${i} must be an object`);
      }
      const at = item as Record<string, unknown>;
      if (typeof at.content !== "string" || at.content === "") {
        throw new MailboxError("E_FIELD_MISSING", `attachment ${i} content (base64) is required`);
      }
      let content: ArrayBuffer;
      try {
        content = base64ToArrayBuffer(at.content);
      } catch {
        throw new MailboxError("E_VALIDATION_ERROR", `attachment ${i} content is not valid base64`);
      }
      out.push({
        filename: typeof at.filename === "string" ? at.filename : undefined,
        mimeType: typeof at.mimeType === "string" ? at.mimeType : undefined,
        content,
      });
    }
    if (out.length) parsed.attachments = out;
  }

  return parsed;
}

// Decode standard base64 (matching the relay's StdEncoding) to an ArrayBuffer.
// atob throws on invalid input, which the caller maps to a clean E_VALIDATION_ERROR.
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Constant-time Bearer compare against the TRANSPORT token (POSTERN_TRANSPORT_TOKEN),
// the infra-seam credential, distinct from the mailbox API token.
function transportAuthorized(request: Request, env: Env): boolean {
  const token = env.POSTERN_TRANSPORT_TOKEN || "";
  const auth = request.headers.get("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token.length > 0 && timingSafeEqual(got, token);
}

// --- Per-function token scopes (#85) + per-identity send registry (#28) ---

// `Scope` (read / send / both) is defined in ./sendidentity (the canonical home for
// the token-resolution types) and imported above. `both` is the egalitarian default
// (one key sends and receives, the back-compat path); `read` and `send` are the
// per-function hardening that bounds a leaked token's blast radius.

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
  if (method === "GET" && path === "/api/mobileconfig") return "read";
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

// Resolve the Authorization bearer to a scope (and, for a registry token, a bound
// identity), or null if it matches nothing. The token is read from the Authorization
// header only, never the URL/query.
//
// Two stages, in order:
//   1. The static, named scope tokens (both / read / send), compared constant-time.
//      Each slot holds a SET of tokens (#154): a comma-separated list, entries
//      trimmed, empties dropped, so multiple consumers of the same function each
//      hold their OWN independently-rotatable value. A single bare value (no
//      comma) is a one-element set, exactly the pre-#154 behavior. The loops do
//      not break on a match, so the check does not leak WHICH slot or WHICH set
//      member matched via timing; per-token LENGTH may leak (tokens are
//      high-entropy), the bytes must not. Precedence is fixed (both, then read,
//      then send): distinct values are expected, so at most one matches, but on an
//      accidental value collision the more-permissive `both` wins, to avoid
//      locking out the primary key. A static match carries NO bound identity
//      (back-compat: From falls back to req.from / DEFAULT_FROM, validated
//      against ALLOWED_FROM_DOMAIN).
//   2. Only if no static token matched, the per-identity send registry (#28): hash
//      the presented Bearer and look it up. A hit grants `send` scope with an
//      AUTHORITATIVE bound From; a miss is an unknown token (the caller returns 401).
async function resolveToken(request: Request, env: Env): Promise<TokenResolution | null> {
  const auth = request.headers.get("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (got.length === 0) return null;

  const candidates: Array<[Scope, string[]]> = [
    ["both", tokenSet(env.POSTERN_API_TOKEN || env.RELAY_TOKEN)],
    ["read", tokenSet(env.POSTERN_API_TOKEN_READ)],
    ["send", tokenSet(env.POSTERN_API_TOKEN_SEND)],
  ];

  let matched: Scope | null = null;
  for (const [scope, tokens] of candidates) {
    // Compare against EVERY set member unconditionally (no early exit, never ===)
    // and OR the results, so which member matched does not leak via timing.
    let eq = false;
    for (const token of tokens) {
      const memberEq = timingSafeEqual(got, token);
      eq = eq || memberEq;
    }
    if (eq && matched === null) matched = scope;
  }
  if (matched !== null) return { scope: matched };

  // No static match: consult the per-identity send registry. A hit is a known
  // per-member token -> send scope with an authoritative bound From; a miss (incl. an
  // entry whose From is off ALLOWED_FROM_DOMAIN, denied at resolve time) falls through
  // to null (the caller maps that to 401, unknown token).
  const allowedDomain = (env.ALLOWED_FROM_DOMAIN || "skyphusion.org").toLowerCase();
  const identity = await resolveRegistryIdentity(got, env.POSTERN_SEND_IDENTITIES, allowedDomain);
  if (identity) return { scope: "send", identity };
  return null;
}

// The body cap is enforced while READING the stream (#196, audit F6): the
// declared Content-Length is fast-rejected, and a chunked / header-less body
// is counted chunk by chunk and aborted the moment the cap is crossed, so the
// guard holds regardless of framing (see ./body).
async function readJson<T>(request: Request): Promise<T> {
  let text: string;
  try {
    text = await readBodyCapped(request, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      throw new MailboxError("E_PAYLOAD_TOO_LARGE", "request body too large", 413);
    }
    throw err;
  }
  try {
    return JSON.parse(text) as T;
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

// Parse a static token slot into its configured SET (#154): comma-separated,
// each entry trimmed, empties dropped (stray commas / whitespace are ignored).
// A single bare value (no comma) is a one-element set, so pre-#154 configs
// behave identically. A comma is therefore not a valid character inside a token
// value. The empty string is never a member, so an absent slot matches nothing.
function tokenSet(slot: string | undefined): string[] {
  return (slot ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
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
