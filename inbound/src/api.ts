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

import PostalMime from "postal-mime";
import * as store from "./store";
import { cleanBody, htmlToText, ingest, normalizeMessageId, type ParsedInbound } from "./ingest";
import { toArrayBuffer } from "./headers";
import {
  send,
  reply,
  MailboxError,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type SendAttachment,
  type SendRequest,
  type ReplyRequest,
} from "./mailbox";
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
// The route table is DATA (#417): ONE declaration that the scope gate below derives
// from and that every non-TypeScript seam reads as contracts/api-*.json. This used to
// be an if-chain further down this file, which is precisely the knowledge every client
// had to re-derive by reading this source once and then never re-check.
import { requiredScope, scopeSatisfies, type RouteScope } from "./routes";
import {
  handleSession,
  resolveSession,
  verifyCsrf,
  sessionCookieValue,
  webmailAuthBackend,
} from "./session";
import { roleMap, rolesForViewer } from "./roles";
import { readBodyCapped, readBytesCapped, PayloadTooLargeError } from "./body";
import { handleMobileconfig } from "./mobileconfig";
import { handleMtaSts } from "./mtasts";

// Failure codes that represent a transient upstream condition (the transport /
// provider) rather than a bad request; mapped to 502 so callers can retry.
const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"]);

// Cap the JSON body so a single request cannot exhaust worker memory. CF Email
// Sending caps a message near 25 MiB; bound a little above so a max-size message
// still passes.
const MAX_BODY_BYTES = 30 * 1024 * 1024;

// The DECODED size an /api/imap/import APPEND may carry (#493). Checked BEFORE
// PostalMime parses, so what the parser can be handed is bounded by a stated
// number instead of by 4/3 of the JSON body cap. Sized to refuse nothing that can
// reach this handler today: rawMime rides inside the JSON body (bounded by
// MAX_BODY_BYTES) and base64 spends 4 bytes per 3, so the largest payload that can
// arrive at all already decodes to about 22.5 MiB. 22 MiB sits just under that,
// which also keeps the guard REACHABLE -- a request that clears the body cap can
// still cross it -- so the refusal is provable through the real handler instead of
// being dead code. Raising the APPEND ceiling means moving MAX_BODY_BYTES and this
// together, in that order.
export const MAX_IMPORT_MIME_BYTES = 22 * 1024 * 1024;

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Uptime probe. Only /health is the probe surface; keep / as a human landing
  // (SEO + demo root) that points at webmail without dumping JSON at browsers.
  // HEAD matches GET status/headers (no body) so uptime bots that HEAD do not 404.
  if ((request.method === "GET" || request.method === "HEAD") && path === "/health") {
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return json({ ok: true, service: "postern" });
  }
  if ((request.method === "GET" || request.method === "HEAD") && path === "/") {
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return serveDemoLanding(url);
  }

  // The webmail door (compose/reply/read, the human browser door, complementing the IMAP proxy).
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

  // Webmail session endpoints (#351): sign in / whoami / sign out / refresh. Same-
  // origin and NOT Bearer-gated (login carries no token), so handled BEFORE the token
  // gate, mirroring /api/smtp-auth. handleSession owns CSRF for its state-changing
  // verbs. It returns null only for a path it does not own (guarded here already).
  if (path === "/api/session" || path === "/api/session/refresh") {
    // #429: this dispatch sits BEFORE the try/catch that wraps every gated route, so an
    // unexpected throw here (a genuine D1 outage inside mintNativeSession, past the
    // fail-closed throttle answer) escaped route-level error mapping entirely and
    // surfaced as an unmapped runtime failure. Give the session path the same envelope.
    //
    // The #409 fail-closed answers are RESPONSES, not throws: an unreadable throttle
    // store returns 503 E_AUTH_UNAVAILABLE and a rejected credential returns 401, and
    // both return straight through this block untouched. What is caught here is only
    // what would otherwise have escaped, which is why wrapping cannot swallow them.
    let sres: Response | null;
    try {
      sres = await handleSession(request, env);
    } catch (err) {
      return preGateErrorResponse(err, "session", "session unavailable");
    }
    if (sres) return sres;
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
  // A session-authed state-changing request must carry a valid CSRF token (double-
  // submit + session binding, contract 1.6). Bearer-authed requests are unaffected (a
  // token is not ambient the way a cookie is). Reads are cookie+SameSite protected.
  if (resolution.viaSession && isStateChanging(request.method)) {
    if (!resolution.csrfHash || !(await verifyCsrf(request, resolution.csrfHash))) {
      return json({ ok: false, error: "E_CSRF", message: "missing or invalid CSRF token" }, 403);
    }
  }
  const need = requiredScope(request.method, path);
  if (need !== null && !authorize(resolution, need)) {
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

    // --- read-state: mark messages (un)read (#seen) ---
    // POST /api/messages/seen { ids: string[], seen: boolean } -> { updated }. This
    // backs the IMAP \Seen flag (the read door STOREs it) and a webmail "mark read",
    // so a human can tell new mail from mail already read. It is a `read`-scoped route
    // (see requiredScope): marking read is a side effect of READING the mailbox, so a
    // read-only token -- what the IMAP proxy commonly holds -- can manage its own read
    // state without being handed send/admin power. Idempotent; unknown ids are skipped.
    if (request.method === "POST" && path === "/api/messages/seen") {
      const body = await readJson<{ ids?: unknown; seen?: unknown; for?: unknown }>(request);
      if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) {
        return json({ ok: false, error: "E_VALIDATION_ERROR", message: "ids must be an array of message ids" }, 400);
      }
      if (typeof body.seen !== "boolean") {
        return json({ ok: false, error: "E_FIELD_MISSING", message: "seen (boolean) is required" }, 400);
      }
      // Optional per-recipient scope (#350): `for` a bare address makes the mark a
      // per-recipient override (message_seen_by), never touching the row-level
      // messages.seen; omitted = legacy estate behavior, unchanged. Validated as a
      // bare address so a malformed value is a clean 400, not a silent no-op.
      let forRecipient: string | undefined;
      if (body.for !== undefined && body.for !== null) {
        if (typeof body.for !== "string" || !EMAIL_RE.test(body.for.trim())) {
          return json({ ok: false, error: "E_VALIDATION_ERROR", message: "for must be a bare email address" }, 400);
        }
        forRecipient = body.for.trim().toLowerCase();
      }
      // Viewer binding under bound-identity auth (#410 / #544). Under a session or a
      // registry token with the `read` cap, the viewer is the BOUND identity, never a
      // caller-supplied address: cannot write another account read-state override
      // (`for: someone-else@`) nor flip ROW-LEVEL messages.seen estate-wide by omitting
      // `for`. A mismatched explicit `for` is refused rather than silently rewritten.
      //
      // Static estate Bearer tokens (POSTERN_API_TOKEN / _READ / IMAP door) are
      // UNTOUCHED: they stay estate-scoped and may pass `for` (#350/#357).
      let viewer: string | readonly string[] | undefined;
      const boundMember = boundReadMember(resolution);
      if (boundMember) {
        const bound = boundMember.trim().toLowerCase();
        if (forRecipient && forRecipient !== bound) {
          return json(
            { ok: false, error: "E_FORBIDDEN", message: "for must match the session identity" },
            403,
          );
        }
        forRecipient = bound;
        // Reachability is the SET (identity plus its role queues, #425) so a member can
        // mark queue mail read; the override written is still keyed to the ONE person
        // above. Widening what you may touch is not widening whose state you write.
        viewer = sessionReadScope(env, resolution);
      }
      const updated = await store.setSeen(env, body.ids as string[], body.seen, forRecipient, viewer);
      return json({ ok: true, updated });
    }

    if (request.method === "POST" && path === "/api/messages/flags") {
      const body = await readJson<{ ids?: unknown; set?: unknown }>(request);
      if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) {
        return json({ ok: false, error: "E_VALIDATION_ERROR", message: "ids must be an array of message ids" }, 400);
      }
      if (!body.set || typeof body.set !== "object" || Array.isArray(body.set)) {
        return json({ ok: false, error: "E_VALIDATION_ERROR", message: "set must be an object" }, 400);
      }
      const raw = body.set as Record<string, unknown>;
      if ((raw.flagged !== undefined && typeof raw.flagged !== "boolean") ||
          (raw.answered !== undefined && typeof raw.answered !== "boolean") ||
          (raw.flagged === undefined && raw.answered === undefined)) {
        return json({ ok: false, error: "E_VALIDATION_ERROR", message: "set requires boolean flagged and/or answered" }, 400);
      }
      // Bound reader (session or registry with read cap, #544): only touch own mail.
      // Static estate tokens omit viewer and keep IMAP/operator estate behavior.
      const flagViewer = boundReadMember(resolution);
      const updated = await store.setFlags(
        env,
        body.ids as string[],
        { flagged: raw.flagged as boolean | undefined, answered: raw.answered as boolean | undefined },
        flagViewer,
      );
      return json({ ok: true, updated });
    }

    if (request.method === "POST" && path === "/api/messages/move") {
      const body = await readJson<{ ids?: unknown; mailbox?: unknown }>(request);
      if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) {
        return json({ ok: false, error: "E_VALIDATION_ERROR", message: "ids must be an array of message ids" }, 400);
      }
      if (body.mailbox !== null && body.mailbox !== "archive" && body.mailbox !== "trash" && body.mailbox !== "junk") {
        return json({ ok: false, error: "E_VALIDATION_ERROR", message: "mailbox must be archive, trash, junk, or null" }, 400);
      }
      const moveViewer = boundReadMember(resolution);
      const updated = await store.moveMessages(
        env,
        body.ids as string[],
        body.mailbox,
        moveViewer,
      );
      return json({ ok: true, updated });
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

    // --- admin: reproject / projected_size backfill (#507) ---
    // A PROJECTION_VERSION bump invalidates every cached size at once and nothing
    // refills them, so without this sweep the IMAP door hydrates a whole message for
    // every RFC822.SIZE on pre-existing mail. Idempotent, one keyset page per call.
    if (request.method === "POST" && path === "/api/admin/reproject") {
      return await handleReproject(request, env);
    }

    // --- admin: reconcile / orphan-vector audit (#134, READ-ONLY) ---
    // Operator action (both-scoped). Enumerates the EXPECTED vector id set from D1
    // and diffs it against the live index to report the orphan count + a sampled
    // cause (a vs b). Vectorize has no list API, so the orphan SET is sampled, not
    // fully enumerable. NEVER deletes: the prune is a separate, Conrad-supervised step.
    if (request.method === "POST" && path === "/api/admin/reconcile") {
      return await handleReconcile(request, env);
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
      const sessionIdentity = sessionViewer(resolution);
      const role = roleReadScope(env, sessionIdentity, url.searchParams);
      const query = parseListQuery(url, sessionIdentity);
      if (role) applyRoleScope(query, role, sessionIdentity as string);
      else if (sessionIdentity) query.viewer = sessionIdentity;
      const page = await store.list(env, query);
      return json({ ok: true, ...page });
    }

    // --- operator: the parsed role-membership map (#425) ---
    // CONFIG, not mail: which addresses are queues and who is on them. Since #438 this
    // map is the SINGLE source (the door reads it through /api/imap/roles rather than
    // parsing a mirror var), so this route is no longer a drift-diff surface; it is the
    // operator read of the one map, which is what makes a membership question answerable
    // without shelling into a container. `both`-scoped like the other operator routes, so
    // a webmail session can never reach it. An unusable config reports an EMPTY map,
    // exactly what every read path serves, so this can never claim a membership the
    // mailbox is not honoring.
    if (request.method === "GET" && path === "/api/roles") {
      return json({ ok: true, roles: roleProjection(env) });
    }

    if (request.method === "GET" && path === "/api/folders") {
      // Viewer for unread counts: ANY bound identity wins (a session, or a
      // per-identity send token), and an unbound BYO read token (IMAP / operator) may
      // pass ?to= the same way list/search do (#350/#352). The per-identity-token case
      // is what makes this boundViewer and not sessionViewer; see both helpers.
      const viewer = boundViewer(resolution) ?? url.searchParams.get("to") ?? undefined;
      // Role queues are enumerated ONLY for a bound session (#425). A static token is
      // estate-scoped already and reads role mail through its own door, so handing it a
      // role rail would add a concept without adding reach. This response is a
      // convenience projection, never the authorization: every role read is checked
      // again at its own route against the same membership map.
      const roles = resolution.viaSession ? rolesForViewer(env, viewer) : [];
      return json({ ok: true, folders: await store.folders(env, viewer, roles) });
    }

    // Dedicated IMAP-service write seam. The `imap` token authenticates the door;
    // the door asserts the already-authenticated account identity explicitly.
    if (path === "/api/imap/drafts" || path.startsWith("/api/imap/drafts/")) {
      return await handleImapDrafts(request, url, path, env);
    }
    if (request.method === "POST" && path === "/api/imap/import") {
      return await handleImapImport(request, env, ctx);
    }

    // --- the IMAP door reads MEMBERSHIP from here (#438) ---
    // The door used to parse its own POSTERN_IMAP_VIEWER_ROLES, a verbatim mirror of
    // POSTERN_VIEWER_ROLES, so one fact was configured twice and the two could disagree
    // about who is on a queue. The Worker map is now the only source and the door reads
    // it per login. Gated on the least-privilege `imap` door token, not `admin`: a proxy
    // should not need credential-provisioning and estate-delete power to learn a
    // membership. An unusable config projects an EMPTY map here just as it does on every
    // read path, so the door inherits the whole-map refusal by construction instead of
    // re-implementing it and drifting.
    if (request.method === "GET" && path === "/api/imap/roles") {
      return json({ ok: true, roles: roleProjection(env) });
    }

    // Server-side drafts are identity-owned. Static operator tokens are deliberately
    // insufficient because no trustworthy owner can be derived from them.
    if (path === "/api/drafts" || path.startsWith("/api/drafts/")) {
      const identity = resolution.identity?.from;
      if (!identity) throw new MailboxError("E_IDENTITY_REQUIRED", "drafts require a bound identity", 403);
      const suffix = path.slice("/api/drafts".length);
      if (request.method === "GET" && suffix === "") {
        return json({ ok: true, drafts: await store.listDrafts(env, identity) });
      }
      if (request.method === "POST" && suffix === "") {
        const input = draftInput(await readJson<Record<string, unknown>>(request));
        const id = crypto.randomUUID();
        const result = await store.putDraft(env, id, identity, input);
        return json({ ok: true, id, draft: result.draft }, 201);
      }
      const sendMatch = /^\/([^/]+)\/send$/.exec(suffix);
      if (request.method === "POST" && sendMatch) {
        const id = decodeURIComponent(sendMatch[1]);
        const draft = await store.getDraft(env, id, identity);
        if (!draft) return json({ ok: false, error: "E_NOT_FOUND", message: "draft not found" }, 404);
        const staged = await store.loadDraftAttachments(env, id, identity);
        const attachments: SendAttachment[] = staged.map((attachment) => ({
          content: arrayBufferToBase64(attachment.content),
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        }));
        let result;
        if ((draft.composeMode === "reply" || draft.composeMode === "replyAll") && draft.sourceMessageId) {
          result = await reply(env, {
            messageId: draft.sourceMessageId,
            mode: draft.composeMode,
            quoteOriginal: true,
            text: draft.bodyText ?? undefined,
            html: draft.bodyHtml ?? undefined,
            bcc: draft.bcc ? splitRecipientInput(draft.bcc) : undefined,
            attachments,
          }, ctx, resolution.identity);
        } else {
          if (!draft.to) throw new MailboxError("E_FIELD_MISSING", "draft recipient required");
          result = await send(env, {
            to: splitRecipientInput(draft.to),
            cc: draft.cc ? splitRecipientInput(draft.cc) : undefined,
            bcc: draft.bcc ? splitRecipientInput(draft.bcc) : undefined,
            subject: draft.subject ?? "",
            text: draft.bodyText ?? undefined,
            html: draft.bodyHtml ?? undefined,
            attachments,
            ...(draft.composeMode === "forward" && draft.sourceMessageId
              ? { forwardMessageId: draft.sourceMessageId }
              : {}),
          }, ctx, resolution.identity);
        }
        // Delete only after dispatch + sent-copy storage succeeds. Every validation,
        // transport, or storage failure leaves the draft and staged bytes retryable.
        await store.deleteDraft(env, id, identity);
        return json({ ok: true, ...result });
      }
      const attachmentListMatch = /^\/([^/]+)\/attachments$/.exec(suffix);
      if (attachmentListMatch) {
        const id = decodeURIComponent(attachmentListMatch[1]);
        if (!(await store.getDraft(env, id, identity))) {
          return json({ ok: false, error: "E_NOT_FOUND", message: "draft not found" }, 404);
        }
        if (request.method === "GET") {
          return json({ ok: true, attachments: await store.listDraftAttachments(env, id, identity) });
        }
        if (request.method === "POST") {
          const usage = await store.draftAttachmentUsage(env, id, identity);
          if (usage.count >= MAX_ATTACHMENTS) {
            throw new MailboxError("E_VALIDATION_ERROR", `too many attachments (max ${MAX_ATTACHMENTS})`);
          }
          let content: ArrayBuffer;
          try {
            content = await readBytesCapped(request, MAX_ATTACHMENT_BYTES);
          } catch (error) {
            if (error instanceof PayloadTooLargeError) {
              throw new MailboxError("E_PAYLOAD_TOO_LARGE", "attachment exceeds 25 MiB", 413);
            }
            throw error;
          }
          if (content.byteLength === 0) throw new MailboxError("E_FIELD_MISSING", "attachment body is required");
          if (usage.bytes + content.byteLength > MAX_ATTACHMENT_BYTES) {
            throw new MailboxError("E_PAYLOAD_TOO_LARGE", "draft attachments exceed 25 MiB", 413);
          }
          const rawName = request.headers.get("x-postern-filename") ?? "";
          const filename = decodeHeaderValue(rawName, "filename");
          const mime = (request.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
          if (/[\r\n]/.test(filename) || /[\r\n]/.test(mime)) {
            throw new MailboxError("E_VALIDATION_ERROR", "attachment metadata contains line breaks");
          }
          const attachment = await store.putDraftAttachment(env, id, identity, {
            ...(filename ? { filename } : {}),
            mime,
            content,
          });
          const committedUsage = await store.draftAttachmentUsage(env, id, identity);
          if (committedUsage.count > MAX_ATTACHMENTS || committedUsage.bytes > MAX_ATTACHMENT_BYTES) {
            await store.deleteDraftAttachment(env, id, identity, attachment.id);
            throw new MailboxError(
              "E_PAYLOAD_TOO_LARGE",
              committedUsage.count > MAX_ATTACHMENTS
                ? `too many attachments (max ${MAX_ATTACHMENTS})`
                : "draft attachments exceed 25 MiB",
              413,
            );
          }
          return json({ ok: true, attachment }, 201);
        }
      }
      const attachmentItemMatch = /^\/([^/]+)\/attachments\/([^/]+)$/.exec(suffix);
      if (request.method === "DELETE" && attachmentItemMatch) {
        const id = decodeURIComponent(attachmentItemMatch[1]);
        const attachmentId = decodeURIComponent(attachmentItemMatch[2]);
        const deleted = await store.deleteDraftAttachment(env, id, identity, attachmentId);
        return deleted
          ? json({ ok: true, deleted: attachmentId })
          : json({ ok: false, error: "E_NOT_FOUND", message: "draft attachment not found" }, 404);
      }
      const itemMatch = /^\/([^/]+)$/.exec(suffix);
      if (itemMatch) {
        const id = decodeURIComponent(itemMatch[1]);
        if (request.method === "GET") {
          const draft = await store.getDraft(env, id, identity);
          return draft
            ? json({ ok: true, draft })
            : json({ ok: false, error: "E_NOT_FOUND", message: "draft not found" }, 404);
        }
        if (request.method === "PUT") {
          // IDOR boundary (#355): a bound identity must not create-or-overwrite a
          // draft id owned by someone else. Mirror the IMAP PUT check (403) so
          // both doors share the same ownership gate; putDraft also refuses.
          const owner = await store.getDraftOwner(env, id);
          if (owner !== null && owner !== identity.toLowerCase()) {
            return json({ ok: false, error: "E_FORBIDDEN", message: "draft belongs to another identity" }, 403);
          }
          const body = await readJson<Record<string, unknown>>(request);
          const result = await store.putDraft(
            env,
            id,
            identity,
            draftInput(body),
            typeof body.updatedAt === "string" ? body.updatedAt : undefined,
          );
          return result.conflict
            ? json({ ok: false, error: "E_CONFLICT", current: result.draft }, 409)
            : json({ ok: true, draft: result.draft });
        }
        if (request.method === "DELETE") {
          const deleted = await store.deleteDraft(env, id, identity);
          return deleted
            ? json({ ok: true, deleted: id })
            : json({ ok: false, error: "E_NOT_FOUND", message: "draft not found" }, 404);
        }
      }
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
      // Optional field selector (#212, substr): which column(s) the substring
      // matches. Validated strictly; ignored by the non-substr modes.
      const fieldParam = url.searchParams.get("field");
      if (fieldParam !== null && fieldParam !== "subject" && fieldParam !== "body" && fieldParam !== "text") {
        return json(
          { ok: false, error: "E_VALIDATION_ERROR", message: "field must be subject, body, or text" },
          400,
        );
      }
      const after = url.searchParams.get("after") ?? undefined;
      const before = url.searchParams.get("before") ?? undefined;
      const hasAttParam = url.searchParams.get("hasAttachment");
      if (hasAttParam !== null && hasAttParam !== "0" && hasAttParam !== "1" &&
          hasAttParam !== "true" && hasAttParam !== "false") {
        return json(
          { ok: false, error: "E_VALIDATION_ERROR", message: "hasAttachment must be 0|1|true|false" },
          400,
        );
      }
      const seenParam = url.searchParams.get("seen");
      if (seenParam !== null && seenParam !== "0" && seenParam !== "1" &&
          seenParam !== "true" && seenParam !== "false") {
        return json(
          { ok: false, error: "E_VALIDATION_ERROR", message: "seen must be 0|1|true|false" },
          400,
        );
      }
      // Viewer-relative view (#403), same rules as /api/messages: refuses an
      // unknown value, refuses lens+direction, refuses a lens with no viewer.
      const sessionIdentity = sessionViewer(resolution);
      // Role queue (#425): searching INSIDE a role view stays scoped to the queue, with
      // read state still keyed on the member -- the same swap the list route makes, so
      // the two edges cannot drift apart on what a role view is.
      const role = roleReadScope(env, sessionIdentity, url.searchParams);
      const lens = role
        ? ("inbox" as const)
        : parseViewLens(
            url.searchParams,
            Boolean(sessionIdentity || url.searchParams.get("to")?.trim()),
          );
      // Whose seen state to render (#404): same parameter, same rules, both endpoints.
      const seenFor = role ? sessionIdentity : parseSeenFor(url.searchParams, sessionIdentity);
      const page = await store.search(env, {
        q,
        mode: modeParam as "fts" | "substr" | "semantic" | "hybrid" | undefined,
        field: fieldParam === null ? undefined : fieldParam,
        direction: dirParam === null ? undefined : dirParam,
        lens,
        seenFor,
        // Viewer scope (#350): recipient-relative INBOX + effective seen, mirroring
        // /api/messages?to=. Unvalidated like list's `to` (a bare address filter).
        to: role ?? url.searchParams.get("to") ?? undefined,
        // Sender filter (#366): same lower(from_addr) LIKE as /api/messages?from=.
        from: url.searchParams.get("from") ?? undefined,
        // Durable-folder scope (#352/#354), same values as /api/messages?mailbox=.
        mailbox: url.searchParams.get("mailbox") ?? undefined,
        after,
        before,
        hasAttachment: hasAttParam === null ? undefined : hasAttParam === "1" || hasAttParam === "true",
        seen: seenParam === null ? undefined : seenParam === "1" || seenParam === "true",
        // A role read drops the account viewer: the queue IS the scope, and the account
        // boundary would otherwise intersect it down to the member own mail (#425).
        viewer: role ? undefined : sessionIdentity,
        limit: parseLimit(url),
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return json({ ok: true, ...page });
    }

    // --- read: recent recipients (D-CONTACTS-1 / #354) ---
    // Bound identity (session or per-identity token) wins. Unbound BYO must pass
    // an explicit viewer=; omitting it is a 400, never an estate-wide dump.
    if (request.method === "GET" && path === "/api/recipients/recent") {
      const bound = resolution.identity?.from?.trim().toLowerCase() || "";
      const explicit = (url.searchParams.get("viewer") ?? url.searchParams.get("to") ?? "")
        .trim()
        .toLowerCase();
      if (explicit && !EMAIL_RE.test(explicit)) {
        return json(
          { ok: false, error: "E_VALIDATION_ERROR", message: "viewer must be an email address" },
          400,
        );
      }
      const identity = bound || explicit;
      if (!identity) {
        return json(
          {
            ok: false,
            error: "E_IDENTITY_REQUIRED",
            message: "recent recipients require a bound identity or viewer=",
          },
          400,
        );
      }
      const recipients = await store.recentRecipients(env, identity, parseLimit(url) ?? 25);
      return json({ ok: true, recipients });
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
      const attScope = sessionReadScope(env, resolution);
      if (attScope && !(await store.messageAccessible(env, id, attScope))) {
        return json({ ok: false, error: "E_NOT_FOUND", message: "attachment not found" }, 404);
      }
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

    // --- delete: one message (admin-scoped; bundled Vectorize tombstone, #278) ---
    if (request.method === "DELETE" && path.startsWith("/api/messages/") && !path.includes("/attachments/")) {
      const id = decodeURIComponent(path.slice("/api/messages/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "message id required" }, 400);
      if (resolution.viaSession && resolution.identity &&
          !(await store.messageAccessible(env, id, resolution.identity.from, true))) {
        return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      }
      const deleted = await store.deleteMessage(env, id, ctx);
      if (!deleted) return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      return json({ ok: true, deleted: id });
    }

    // --- read: one message ---
    if (request.method === "GET" && path.startsWith("/api/messages/")) {
      const id = decodeURIComponent(path.slice("/api/messages/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "message id required" }, 400);
      // Read scope is the SET (#425): a message opened from a role view is reachable
      // because the viewer is a MEMBER of that queue, not because the estate is open.
      const readScope = sessionReadScope(env, resolution);
      if (readScope && !(await store.messageAccessible(env, id, readScope))) {
        return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      }
      const msg = await store.get(env, id);
      if (!msg) return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
      return json({ ok: true, message: msg });
    }

    // --- read: a thread ---
    if (request.method === "GET" && path.startsWith("/api/threads/")) {
      const id = decodeURIComponent(path.slice("/api/threads/".length));
      if (!id) return json({ ok: false, error: "E_FIELD_MISSING", message: "thread id required" }, 400);
      const messages = await store.thread(env, id, sessionReadScope(env, resolution));
      return json({ ok: true, threadId: id, messages });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Every address a bound reader may READ under (#425 / #544): its own identity, plus
 *  each role queue that identity is a member of.
 *
 *  Applies to webmail sessions AND registry tokens with the `read` cap (#544). Static
 *  estate tokens (POSTERN_API_TOKEN / _READ) have no identity and return undefined --
 *  they stay estate-scoped by design (explicit operator capability).
 *
 *  Read paths only. The write paths (delete, flags, move) keep passing the single
 *  identity on purpose: the #404 ruling makes a role view read plus \Seen ONLY, so a
 *  member must not delete, file or flag mail on behalf of every other member. A role id
 *  handed to one of those routes is simply not accessible, so it is skipped exactly as
 *  an unknown id is, which is the same answer the IMAP door gives with a tagged NO. */
function sessionReadScope(env: Env, resolution: AuthResolution): string[] | undefined {
  const identity = boundReadMember(resolution);
  if (!identity) return undefined;
  return [identity, ...rolesForViewer(env, identity)];
}

/** The single mail address a resolution is bound to for READ, or undefined.
 *
 *  Sessions always bind. Registry tokens bind only when they carry the `read` cap
 *  (#544). Send-only registry tokens stay send-only (403 on list/search). */
function boundReadMember(resolution: AuthResolution): string | undefined {
  if (!resolution.identity) return undefined;
  if (resolution.viaSession) return resolution.identity.from;
  if (resolution.caps?.includes("read")) return resolution.identity.from;
  return undefined;
}

/** The ROLE queue a bound session is asking to read, or null (#425).
 *
 *  Returns non-null ONLY when the session names a `to=` that is a role address the
 *  session identity is genuinely a member of, per the server-side membership map. That
 *  makes this a strict ADDITION to the session read path: every other `to=` value falls
 *  through to the existing behavior untouched, so the open semantics decision in #422
 *  (honor `to=` inside the account boundary vs refuse it) stays entirely open, and a
 *  non-member learns nothing about whether an address is a queue -- the answer it gets
 *  is the same one it would get for any address at all.
 *
 *  A role view is the ARRIVAL view of the queue and nothing else, matching the single
 *  folder the door publishes: a role read that also names `lens=sent`, a `direction=`,
 *  or a durable `mailbox=` is refused rather than quietly reinterpreted. */
function roleReadScope(
  env: Env,
  sessionIdentity: string | undefined,
  p: URLSearchParams,
): string | null {
  if (!sessionIdentity) return null;
  const to = (p.get("to") ?? "").trim().toLowerCase();
  if (!to || to === sessionIdentity.trim().toLowerCase()) return null;
  if (!rolesForViewer(env, sessionIdentity).includes(to)) return null;
  const lens = p.get("lens");
  if (lens !== null && lens !== "inbox") {
    throw new MailboxError("E_VALIDATION_ERROR", "a role view is the inbox lens only");
  }
  if (p.get("direction") !== null) {
    throw new MailboxError(
      "E_VALIDATION_ERROR",
      "a role view is the inbox lens only: direction does not apply to a role queue",
    );
  }
  if ((p.get("mailbox") ?? "").trim()) {
    throw new MailboxError(
      "E_VALIDATION_ERROR",
      "a role queue has no durable folders: drop mailbox= from a role view",
    );
  }
  return to;
}

/** Point a read at a role QUEUE while keeping read state on the MEMBER (#425).
 *
 *  This is the door call, expressed server-side: rows come from the role arrival view
 *  (to=R, lens=inbox) and the effective-seen key is the member (seenFor=V), so
 *  "Ada read it" never renders as "the queue is handled". The account viewer is
 *  dropped, because the account boundary would otherwise intersect the queue down to
 *  the member own mail. seenFor is derived HERE, never trusted from the client. */
function applyRoleScope<
  T extends {
    to?: string;
    lens?: import("./store").ViewLens;
    direction?: "inbound" | "outbound";
    seenFor?: string;
    viewer?: string;
  },
>(query: T, role: string, member: string): T {
  query.to = role;
  query.lens = "inbox";
  query.direction = undefined;
  query.seenFor = member;
  query.viewer = undefined;
  return query;
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The stored-direction filter, validated STRICTLY (#403).
 *
 *  It used to be coerced (`dir === "inbound" || ... : undefined`), so a typo was a
 *  silently-ignored filter and the caller got the unfiltered set back as if it had
 *  been filtered -- the same false-pass class this issue is about. /api/search has
 *  always validated it; both edges now refuse identically. */
function parseDirection(p: URLSearchParams): "inbound" | "outbound" | undefined {
  const dir = p.get("direction");
  if (dir === null) return undefined;
  if (dir !== "inbound" && dir !== "outbound") {
    throw new MailboxError("E_VALIDATION_ERROR", "direction must be inbound or outbound");
  }
  return dir;
}

/** The named viewer-relative view (#403; CONTRACT 10.9).
 *
 *  `lens` and `direction` filter the SAME axis from opposite ends (a view vs the
 *  stored wire fact), so accepting both would have to silently pick a winner:
 *  refuse instead. A lens without a viewer is refused rather than degraded to the
 *  estate view, so a caller can never believe it got a viewer-scoped answer it
 *  did not get. */
function parseViewLens(p: URLSearchParams, hasViewer: boolean): import("./store").ViewLens | undefined {
  const raw = p.get("lens");
  if (raw === null) return undefined;
  if (raw !== "inbox" && raw !== "sent") {
    throw new MailboxError("E_VALIDATION_ERROR", "lens must be inbox or sent");
  }
  if (p.get("direction") !== null) {
    throw new MailboxError("E_VALIDATION_ERROR", "lens and direction are mutually exclusive");
  }
  if (!hasViewer) {
    throw new MailboxError("E_VALIDATION_ERROR", "lens requires a viewer: pass to= or use a bound session");
  }
  return raw;
}

/** WHOSE seen state to render (#404), independent of which rows come back.
 *
 *  A folder view keyed to a role address (`to=R`) needs the HUMAN reader's read/unread
 *  state, which the projection key (`viewer ?? to`) could not express. `seenFor` sets
 *  that key only; the row predicate is untouched. Absent, every read is byte-identical
 *  to before.
 *
 *  Authorization: a BOUND SESSION may only name ITSELF. Sessions are per-person, and
 *  another person's read/unread state is theirs; letting a session pass an arbitrary
 *  address would turn a rendering parameter into a peephole. Static tokens are
 *  estate-scoped by construction (they already read every row), so they may name any
 *  address, which is exactly what an operator/door read needs. */
function parseSeenFor(p: URLSearchParams, sessionIdentity?: string): string | undefined {
  const raw = p.get("seenFor");
  if (raw === null) return undefined;
  const value = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(value)) {
    throw new MailboxError("E_VALIDATION_ERROR", "seenFor must be a bare email address");
  }
  if (sessionIdentity && value !== sessionIdentity.trim().toLowerCase()) {
    throw new MailboxError(
      "E_FORBIDDEN",
      "seenFor must be the bound session identity: seen state belongs to its reader",
      403,
    );
  }
  return value;
}

function parseListQuery(url: URL, sessionIdentity?: string): import("./store").ListQuery {
  const p = url.searchParams;
  const mailbox = p.get("mailbox");
  const to = p.get("to") ?? undefined;
  return {
    to,
    seenFor: parseSeenFor(p, sessionIdentity),
    from: p.get("from") ?? undefined,
    thread: p.get("thread") ?? undefined,
    direction: parseDirection(p),
    lens: parseViewLens(p, Boolean(sessionIdentity || to?.trim())),
    mailbox: mailbox === "archive" || mailbox === "trash" || mailbox === "junk" || mailbox === "all"
      ? mailbox
      : undefined,
    q: p.get("q") ?? undefined,
    limit: parseLimit(url),
    cursor: p.get("cursor") ?? undefined,
  };
}

function draftInput(body: Record<string, unknown>): store.DraftInput {
  const text = (name: string): string | null => {
    const value = body[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new MailboxError("E_VALIDATION_ERROR", `${name} must be a string`);
    return value;
  };
  return {
    to: text("to"),
    cc: text("cc"),
    bcc: text("bcc"),
    subject: text("subject"),
    bodyText: text("bodyText"),
    bodyHtml: text("bodyHtml"),
    inReplyTo: text("inReplyTo"),
    threadId: text("threadId"),
    composeMode: draftMode(body.composeMode),
    sourceMessageId: text("sourceMessageId"),
  };
}

function draftMode(value: unknown): store.DraftComposeMode {
  if (value === undefined || value === null || value === "new") return "new";
  if (value === "reply" || value === "replyAll" || value === "forward") return value;
  throw new MailboxError("E_VALIDATION_ERROR", "composeMode must be new, reply, replyAll, or forward");
}

function splitRecipientInput(value: string): string[] {
  return value.split(/[,\n;]/).map((part) => part.trim()).filter(Boolean);
}

function decodeHeaderValue(value: string, label: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).slice(0, 255);
  } catch {
    throw new MailboxError("E_VALIDATION_ERROR", `${label} header is not valid percent-encoding`);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function requireImapIdentity(value: unknown, env: Env): string {
  if (typeof value !== "string") throw new MailboxError("E_FIELD_MISSING", "identity is required");
  const identity = value.trim().toLowerCase();
  const allowed = (env.ALLOWED_FROM_DOMAIN || "").trim().toLowerCase();
  if (!EMAIL_RE.test(identity) || (allowed && identity.split("@")[1] !== allowed)) {
    throw new MailboxError("E_IDENTITY_NOT_ALLOWED", "identity is not allowed", 403);
  }
  return identity;
}

async function handleImapDrafts(request: Request, url: URL, path: string, env: Env): Promise<Response> {
  const suffix = path.slice("/api/imap/drafts".length);
  if (request.method === "GET") {
    const identity = requireImapIdentity(url.searchParams.get("identity"), env);
    if (suffix === "") return json({ ok: true, drafts: await store.listDrafts(env, identity) });
    const match = /^\/([^/]+)$/.exec(suffix);
    if (match) {
      const draft = await store.getDraft(env, decodeURIComponent(match[1]), identity);
      return draft
        ? json({ ok: true, draft })
        : json({ ok: false, error: "E_NOT_FOUND", message: "draft not found" }, 404);
    }
  }
  if (request.method === "POST" && suffix === "") {
    const body = await readJson<Record<string, unknown>>(request);
    const identity = requireImapIdentity(body.identity, env);
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : crypto.randomUUID();
    // Client-chosen ids (IMAP APPEND) must not collide with another identity's
    // draft (#355 IDOR). putDraft also refuses; this returns a clean 403.
    const owner = await store.getDraftOwner(env, id);
    if (owner !== null && owner !== identity.toLowerCase()) {
      return json({ ok: false, error: "E_FORBIDDEN", message: "draft belongs to another identity" }, 403);
    }
    const result = await store.putDraft(env, id, identity, draftInput(body));
    return json({ ok: true, id, draft: result.draft }, 201);
  }
  const match = /^\/([^/]+)$/.exec(suffix);
  if (match && request.method === "DELETE") {
    const identity = requireImapIdentity(url.searchParams.get("identity"), env);
    const id = decodeURIComponent(match[1]);
    return (await store.deleteDraft(env, id, identity))
      ? json({ ok: true, deleted: id })
      : json({ ok: false, error: "E_NOT_FOUND", message: "draft not found" }, 404);
  }
  // PUT /api/imap/drafts/{id}: autosave revision (contract §2.4.1). Mirrors the
  // session-identity PUT /api/drafts/{id} (optimistic concurrency via updatedAt),
  // but the identity is asserted explicitly in the body (the imap door has no
  // bound Bearer identity) rather than taken from the resolved token. putDraft
  // mints a fresh per-folder uid on every write (store.ts allocateFolderUid),
  // so a revision always presents as the same draft id under a new, higher UID --
  // the IMAP door then reads that as EXPUNGE(old uid) + APPEND(new uid).
  if (match && request.method === "PUT") {
    const body = await readJson<Record<string, unknown>>(request);
    const identity = requireImapIdentity(body.identity, env);
    const id = decodeURIComponent(match[1]);
    const owner = await store.getDraftOwner(env, id);
    if (owner !== null && owner !== identity.toLowerCase()) {
      return json({ ok: false, error: "E_FORBIDDEN", message: "draft belongs to another identity" }, 403);
    }
    const result = await store.putDraft(
      env,
      id,
      identity,
      draftInput(body),
      typeof body.updatedAt === "string" ? body.updatedAt : undefined,
    );
    return result.conflict
      ? json({ ok: false, error: "E_CONFLICT", current: result.draft }, 409)
      : json({ ok: true, draft: result.draft });
  }
  return json({ ok: false, error: "E_NOT_FOUND", message: "not found" }, 404);
}

async function handleImapImport(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const identity = requireImapIdentity(body.identity, env);
  const folder = body.folder;
  if (folder !== "sent" && folder !== "archive" && folder !== "trash" && folder !== "junk") {
    throw new MailboxError("E_VALIDATION_ERROR", "folder must be sent, archive, trash, or junk");
  }
  if (typeof body.rawMime !== "string" || !body.rawMime) {
    throw new MailboxError("E_FIELD_MISSING", "rawMime base64 is required");
  }
  let raw: ArrayBuffer;
  try {
    raw = base64ToArrayBuffer(body.rawMime);
  } catch {
    throw new MailboxError("E_VALIDATION_ERROR", "rawMime is not valid base64");
  }
  // Bound the PARSER, not just the transport (#493). The cap is read off the
  // DECODED bytes and lands BEFORE parse: decoding is one linear pass the body cap
  // already bounds, while PostalMime walks the whole MIME tree and allocates per
  // part. The refusal reuses the envelope the body cap itself answers with, so the
  // door has one refusal to map, and 413 is a refusal the door turns into a tagged
  // IMAP NO -- never a 5xx, which stays reserved for transient infra and is
  // load-bearing for relay retry semantics (#429/#442).
  if (raw.byteLength > MAX_IMPORT_MIME_BYTES) {
    throw new MailboxError(
      "E_PAYLOAD_TOO_LARGE",
      `rawMime decodes to ${raw.byteLength} bytes, over the ${MAX_IMPORT_MIME_BYTES} byte import limit`,
      413,
    );
  }
  const parsed = await new PostalMime().parse(raw);
  const header = (name: string): string =>
    parsed.headers.find((h) => h.key.toLowerCase() === name)?.value ?? "";
  const from = header("from").trim();
  const fromAddress = bareAddress(from);
  const outbound = folder === "sent" || fromAddress === identity;
  if (folder === "sent" && fromAddress !== identity) {
    throw new MailboxError("E_IDENTITY_MISMATCH", "Sent APPEND From must equal identity", 403);
  }
  const toHeader = header("to").trim();
  const cc = header("cc").trim();
  const bcc = header("bcc").trim();
  const deliveredTo = outbound
    ? [...store.parseRecipients(toHeader), ...store.parseRecipients(cc), ...store.parseRecipients(bcc)]
    : [identity];
  if (outbound && deliveredTo.length === 0) {
    throw new MailboxError("E_FIELD_MISSING", "outbound APPEND requires a recipient");
  }
  // The SAME normalizer the inbound seam uses (#486): an APPENDed message keeps its
  // own Message-ID verbatim, so a Sent copy imported here and the delivered copy that
  // arrives over SMTP resolve to one identity.
  const messageId = await normalizeMessageId(env, parsed.messageId);
  const parsedDate = parsed.date ? new Date(parsed.date) : new Date();
  const date = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
  const attachments: NonNullable<store.StoreInput["attachments"]> = [];
  for (const attachment of parsed.attachments ?? []) {
    const content = toArrayBuffer(attachment.content);
    if (!content) continue;
    attachments.push({
      filename: attachment.filename || undefined,
      mimeType: attachment.mimeType || undefined,
      content,
    });
  }
  const result = await store.put(env, {
    messageId,
    direction: outbound ? "outbound" : "inbound",
    from: from || identity,
    to: toHeader || identity,
    subject: parsed.subject ?? "",
    date,
    inReplyTo: parsed.inReplyTo ?? null,
    bodyText: cleanBody(parsed.text ?? htmlToText(parsed.html ?? "")).slice(0, 32_000),
    bodyHtml: parsed.html ? parsed.html.slice(0, 512_000) : null,
    auth: { spf: "none", dkim: "none", dmarc: "none" },
    trusted: outbound,
    attachments,
    deliveredTo,
    cc: cc || null,
    bcc: outbound ? bcc || null : null,
    replyTo: header("reply-to") || null,
    wireSize: raw.byteLength,
  }, ctx);
  const mailbox = folder === "sent" ? null : folder;
  if (mailbox) await store.moveMessages(env, [messageId], mailbox);
  return json({ ok: true, ...result, mailbox }, result.stored ? 201 : 200);
}

function bareAddress(value: string): string {
  const angle = /<([^<>]+)>/.exec(value);
  return (angle?.[1] ?? value.split(",")[0] ?? "").trim().toLowerCase();
}

// Email shape check (linear, no ReDoS) mirroring mailbox.ts, used to validate a
// provisioned bound From identity.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

// POST /api/smtp-auth: the submission relay validates a client login here. Gated
// by the transport token. Returns { ok:true, from } on success (the bound From
// identity the daemon then enforces), { ok:false } on a bad credential.
async function handleSmtpAuth(request: Request, env: Env): Promise<Response> {
  // #442: this route is dispatched BEFORE the try/catch that wraps every gated route and
  // had none of its own, so an unexpected throw (a D1 outage inside authenticate(), past
  // every deliberate refusal below) escaped route-level mapping entirely. Its refusals are
  // all RESPONSES -- 401 (wrong transport token), 400 (bad body), 200 {ok:false} (bad
  // credential) -- so they return through this wrapper untouched; only what would have
  // escaped is caught. Answering 200 {ok:false} here instead would tell the relay the
  // PASSWORD was wrong (SMTP 535, and counted toward the #105 throttle), which is why the
  // envelope is a 500 the relay reads as an infra failure.
  try {
    return await smtpAuthResponse(request, env);
  } catch (err) {
    return preGateErrorResponse(err, "smtp-auth", "auth check unavailable");
  }
}

async function smtpAuthResponse(request: Request, env: Env): Promise<Response> {
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
  try {
    const text = await readBodyCapped(request, MAX_BODY_BYTES);
    if (text) body = JSON.parse(text) as typeof body;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return json({ ok: false, error: "E_PAYLOAD_TOO_LARGE", message: "request body too large" }, 413);
    }
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
  }
  const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const dryRun = body.dryRun === true;
  const result = await store.reindexPage(env, { cursor, limit, dryRun });
  return json({ ok: true, ...result });
}

// POST /api/admin/reproject: recompute projected_size over the existing mailbox after
// a PROJECTION_VERSION bump (#507). One keyset page per call, returns a cursor; the
// runner (scripts/reproject-sweep.mjs) loops until done:true. Body: { cursor?, limit?,
// dryRun?, countOnly? }. Idempotent (the same message projects to the same number);
// dryRun reports exactly what WOULD change and writes nothing.
//
// countOnly (#520): read-only aggregate census -- { total, atCurrent, notCurrent,
// projectionVersion }. No paging, no writes. The authoritative answer to "how many
// rows are still not at PROJECTION_VERSION", which the runner's start/end total
// floor (#515) can only approximate.
async function handleReproject(request: Request, env: Env): Promise<Response> {
  let body: { cursor?: unknown; limit?: unknown; dryRun?: unknown; countOnly?: unknown } = {};
  try {
    const text = await readBodyCapped(request, MAX_BODY_BYTES);
    if (text) body = JSON.parse(text) as typeof body;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return json({ ok: false, error: "E_PAYLOAD_TOO_LARGE", message: "request body too large" }, 413);
    }
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
  }
  if (body.countOnly === true) {
    const counts = await store.countProjectionStatus(env);
    return json({ ok: true, countOnly: true, ...counts });
  }
  const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const dryRun = body.dryRun === true;
  const result = await store.reprojectPage(env, { cursor, limit, dryRun });
  return json({ ok: true, ...result });
}

// POST /api/admin/reconcile: orphan-vector audit (#134). READ-ONLY -- enumerates the
// EXPECTED vector id set from D1, diffs it against the live Vectorize index, and
// reports the orphan count + a SAMPLED cause (a deleted-message vs b pre-#116 id
// scheme). Vectorize has no list API, so the orphan SET is sampled (enumerable:false),
// not fully listed. Body: { verify?, sampleSize?, includeOrphanIds? }. NEVER deletes.
async function handleReconcile(request: Request, env: Env): Promise<Response> {
  let body: { verify?: unknown; sampleSize?: unknown; includeOrphanIds?: unknown } = {};
  if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "E_VALIDATION_ERROR", message: "invalid JSON body" }, 400);
    }
  }
  const verify = body.verify === false ? false : true;
  const sampleSize = typeof body.sampleSize === "number" ? body.sampleSize : undefined;
  const includeOrphanIds = body.includeOrphanIds === true;
  const result = await store.reconcile(env, { verify, sampleSize, includeOrphanIds });
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
  // #442: the transport gate moves INSIDE the try so nothing on this route can throw past
  // the envelope, and an unexpected throw now answers a fixed 500 instead of going through
  // errorResponse. That branch echoes err.message and answers 400 for any error whose code
  // is not in RETRYABLE -- on the MAIL path a 400 reads as a permanent reject, and the
  // echoed text is internal detail put on the wire (the relay logs the response body
  // verbatim). Deliberate refusals are unchanged: 401 unauthorized, and the MailboxErrors
  // parseIngestBody throws (E_FIELD_MISSING, E_VALIDATION_ERROR, E_PAYLOAD_TOO_LARGE) still
  // map through errorResponse with their own status.
  try {
    if (!transportAuthorized(request, env)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
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
    return preGateErrorResponse(err, "ingest", "ingest unavailable");
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

// `requiredScope` and `scopeSatisfies` are imported from ./routes above (#417): the
// route table is the single source and the gate derives from it, so there is no
// second copy of this mapping that can be wrong. inbound/route-table.test.ts keeps a
// verbatim copy of the if-chain that used to live here and asserts the derived
// function still answers identically over every route plus adversarial paths, so the
// migration is proved faithful and any future edit to the table that would move the
// AUTH GATE fails against the recorded original. `Scope` still lives in
// ./sendidentity (the canonical home for the token-resolution types).

// An authenticated resolution: a Bearer token (scope, optional bound identity) OR an
// ambient webmail session (an explicit capability SET + bound identity + csrf binding).
// `caps`, when present, is the authoritative grant and the gate checks membership; a
// Bearer resolution has no `caps` and is checked via scopeSatisfies on `scope`.
interface AuthResolution extends TokenResolution {
  caps?: string[];
  viaSession?: boolean;
  csrfHash?: string;
}

// Resolve the ambient webmail session cookie to an AuthResolution, or null. Consulted
// only when no Authorization header is present (Bearer wins, contract 1.8). Gated on
// the native backend so flipping WEBMAIL_AUTH_BACKEND to off is an instant kill-switch.
async function resolveCookieAuth(request: Request, env: Env): Promise<AuthResolution | null> {
  if (webmailAuthBackend(env) !== "native") return null;
  const rawId = sessionCookieValue(request);
  if (!rawId) return null;
  const session = await resolveSession(env, rawId);
  if (!session) return null;
  return {
    scope: "read",
    identity: session.identity,
    caps: session.caps,
    viaSession: true,
    csrfHash: session.csrfHash,
  };
}

/** WHOSE mail a read is bound to for list/search (#417 / #544).
 *
 *  Sessions and registry tokens with the `read` cap force the viewer to the bound
 *  identity (plus role queues via sessionReadScope / roleReadScope). Static estate
 *  tokens have no bound member -- callers pass `to=` when they want a filter.
 *
 *  Named sessionViewer for call-site continuity; implementation is boundReadMember.
 */
function sessionViewer(resolution: AuthResolution): string | undefined {
  return boundReadMember(resolution);
}

/** WHOSE mail folders/unread bind to (#417 / #544).
 *
 *  Any bound identity (session or registry). A send-only registry token still has a
 *  from= for folders convenience if it ever reached the route; with #544, read-capable
 *  registry tokens reach list/search/folders under the same identity.
 */
function boundViewer(resolution: AuthResolution): string | undefined {
  return resolution.identity?.from;
}

// The parsed role map as its wire projection, shared by the two gated surfaces that
// expose it: the operator GET /api/roles and the door GET /api/imap/roles (#438). ONE
// function, because two hand-written copies of a shape is exactly how the Worker and the
// door came to hold two copies of the MAP in the first place.
function roleProjection(env: Env): Array<{ address: string; members: string[] }> {
  return [...roleMap(env)].map(([address, members]) => ({ address, members: [...members] }));
}

// Authorize a resolution against a required route scope. A session carries an explicit
// capability SET (checked by membership); a Bearer carries a single Scope (read/send/
// both) checked by scopeSatisfies. `both` in either form satisfies everything.
function authorize(resolution: AuthResolution, need: RouteScope): boolean {
  if (resolution.caps) return capsSatisfy(resolution.caps, need);
  return scopeSatisfies(resolution.scope, need);
}

// Capability-set membership. `both` grants all; otherwise the exact capability must be
// present. `admin` is held only by `both`, so a webmail session (caps read+send) is
// correctly denied credential provisioning, reindex, and hard-delete (the delete scope
// arrives with the durable-mailbox phase #352, which adds "delete" to session caps).
function capsSatisfy(caps: string[], need: RouteScope): boolean {
  if (caps.includes("both")) return true;
  return caps.includes(need);
}

// A state-changing method must carry CSRF when session-authed (contract 1.6).
function isStateChanging(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
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
//   2. Only if no static token matched, the per-identity registry (#28 / #544): hash
//      the presented Bearer and look it up. A hit grants the entry's caps (read and/or
//      send) with an AUTHORITATIVE bound identity; a miss is an unknown token (401).
//      Caps never include delete/admin -- those stay on static `both`.
async function resolveToken(request: Request, env: Env): Promise<AuthResolution | null> {
  const auth = request.headers.get("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // No Authorization header: fall back to the ambient webmail session cookie (contract
  // 1.8). An explicit Bearer ALWAYS wins; the cookie is consulted only when no Bearer
  // is present, so a request is never treated as carrying two credentials at once.
  if (got.length === 0) return resolveCookieAuth(request, env);

  const candidates: Array<[Scope, string[]]> = [
    ["both", tokenSet(env.POSTERN_API_TOKEN)],
    ["read", tokenSet(env.POSTERN_API_TOKEN_READ)],
    ["send", tokenSet(env.POSTERN_API_TOKEN_SEND)],
    ["delete", tokenSet(env.POSTERN_API_TOKEN_DELETE)],
    ["imap", tokenSet(env.POSTERN_API_TOKEN_IMAP)],
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

  // No static match: consult the per-identity registry. A hit is a known per-member
  // token with caps + authoritative identity; a miss (incl. an entry whose From is off
  // ALLOWED_FROM_DOMAIN, denied at resolve time) falls through to null (401).
  const allowedDomain = (env.ALLOWED_FROM_DOMAIN || "skyphusion.org").toLowerCase();
  const hit = await resolveRegistryIdentity(got, env.POSTERN_SEND_IDENTITIES, allowedDomain);
  if (hit) {
    // Primary scope is only a fallback when caps is absent; authorize() uses caps.
    // Prefer send if present so any scope-only path cannot treat a dual-cap token as
    // read-only (audit note). Never use static `both` here (no delete/admin).
    const scope: Scope = hit.caps.includes("send") ? "send" : "read";
    return { scope, identity: hit.identity, caps: [...hit.caps] };
  }
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

/** The envelope for an UNEXPECTED throw on a PRE-GATE route: /api/session (#429) and the
 *  two infra seams that share its construction, /api/smtp-auth and /ingest (#442).
 *
 *  A structured MailboxError maps exactly as it does on a gated route, so the two edges
 *  answer identically for the same error. Anything else is, by construction, an infra
 *  failure the route did not anticipate, and it deliberately does NOT reuse
 *  errorResponse unknown-error branch: that one answers 400 and echoes err.message, which
 *  on a D1 outage would both blame the CALLER for a server failure and put internal error
 *  text on the wire. A fixed 500 with a fixed message says the true thing and discloses
 *  nothing; the detail goes to the log, where an operator can see it and a client cannot.
 *
 *  5xx is the load-bearing half on the MAIL seams (#442). Both callers branch on the
 *  STATUS only (relay/client.go tests `StatusCode/100 != 2`; relay/submit_client.go parses
 *  the body only on a 2xx), and both map a non-2xx to a TRANSIENT answer: an /ingest
 *  failure is SMTP 451 so the sending MTA retries, and an /api/smtp-auth infra failure is
 *  logged and deliberately kept OUT of the #105 per-account throttle. A 200 {ok:false}
 *  envelope would be read as "bad credential" (permanent 535, and it WOULD count toward
 *  the throttle, locking every user out during an outage), and the 400 that errorResponse
 *  gives an unknown error reads as a permanent client fault. Neither is true of a D1
 *  outage, so both seams answer a fixed 500.
 *
 *  E_INTERNAL_SERVER_ERROR is the existing vocabulary for this (CONTRACT section 4), not a
 *  new code minted for one route. */
function preGateErrorResponse(err: unknown, route: string, message: string): Response {
  if (err instanceof MailboxError) return errorResponse(err);
  console.error(`${route} route failed:`, err instanceof Error ? err.message : String(err));
  return json({ ok: false, error: "E_INTERNAL_SERVER_ERROR", message }, 500);
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

/** Public root landing for demo/product hosts (SEO + human door). Health stays on /health. */
function serveDemoLanding(url: URL): Response {
  const origin = url.origin;
  const webmail = `${origin}/webmail`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Postern: self-hostable mailbox for humans and agents</title>
  <meta name="description" content="Postern is a self-hostable mailbox on Cloudflare for humans and agents: send, receive, search, webmail, IMAP, and MCP. Open source AGPL-3.0 by Skyphusion Labs.">
  <link rel="canonical" href="${origin}/">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Postern: mailbox for humans and agents">
  <meta property="og:description" content="Self-hostable Cloudflare mailbox with webmail, IMAP, and agent MCP. Identity-bound credentials so each person sends and reads as themselves.">
  <meta property="og:url" content="${origin}/">
  <meta name="twitter:card" content="summary">
  <meta name="robots" content="index, follow">
  <style>
    :root { color-scheme: dark light; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
      background: #0b0f14; color: #e8eef5; }
    main { max-width: 36rem; line-height: 1.5; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    p { margin: 0 0 1rem; color: #b7c2cf; }
    a.btn { display: inline-block; padding: 0.65rem 1rem; background: #3d8bfd; color: #041018;
      text-decoration: none; font-weight: 600; border-radius: 6px; margin-right: 0.75rem; }
    a.sec { color: #9ec1ff; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <main>
    <h1>Postern</h1>
    <p>Self-hostable mailbox on Cloudflare for humans and agents. One store, one API, webmail and IMAP doors, MCP for agents.</p>
    <p><a class="btn" href="${webmail}">Open webmail</a>
       <a class="sec" href="https://github.com/skyphusion-labs/postern">Source on GitHub</a></p>
    <p>Write-up: <a class="sec" href="https://skyphusion.net/blog/postern-identity-bound/">Postern v1.4.1 identity-bound credentials</a>.
       Health probe: <code>GET /health</code>.</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
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
