// The worker's route table, as DATA and as the SOURCE (#417).
//
// Every client (mcp, clients/python, the IMAP door, webmail) needs three facts about
// this worker: which paths exist, which method reaches them, and which parameters they
// honor. That knowledge used to live only in the control flow of handleApi +
// requiredScope, so each client encoded a copy from reading the source once and nothing
// ever compared the copies again. That is the structural reason the published clients
// drifted a full feature generation behind with every suite green.
//
// #449 made the route SPINE shared data (contracts/api-routes.json) and validated it
// behaviorally. This file is the convergence: the manifest is no longer hand-maintained
// alongside the code, it is GENERATED from this declaration, and requiredScope() is
// DERIVED from the same rows. Derivation beats hand-maintenance-plus-validation because
// there is no second list that can be wrong in the first place.
//
//   npm run routes:emit  ->  contracts/api-routes.json  (the spine, #449's shape)
//                        ->  contracts/api-params.json  (the parameter layer)
//
// Three tests keep it honest and are the reason it is worth anything:
//   - inbound/route-contract.test.ts (#449): the scope column against the real gate.
//   - inbound/route-table.test.ts: the derivation is equivalent to the if-chain it
//     replaced, no row is shadowed, and the committed JSON matches this source.
//   - inbound/route-params.test.ts: every declared parameter is LIVE against the real
//     handler (refused when bogus, or it changes the answer).
//
// Order is load-bearing: matchRoute walks the rows top to bottom exactly as the
// original if-chain did, so a broad prefix must come after the narrower paths under it.
// `id` and `auth` are #449's vocabulary, kept verbatim so the emitted spine is
// byte-compatible with what already reads it.

import type { Scope } from "./sendidentity";

/** The scope a route/method demands. `admin` is satisfied ONLY by a `both` token. */
export type RouteScope = "read" | "send" | "delete" | "imap" | "admin";

export interface RouteSpec {
  /** Stable identifier, and the join key for the parameter manifest (#449). */
  id: string;
  /** The method that reaches this row; ANY = every method. */
  method: "GET" | "POST" | "PUT" | "DELETE" | "ANY";
  /** The literal the worker matches. */
  path: string;
  /** exact = the whole path; prefix = this path plus anything under it. */
  match: "exact" | "prefix";
  /** The token scope the gate demands, or null for routes served before the gate. */
  scope: RouteScope | null;
  /** What guards it when `scope` is null (#449 vocabulary). */
  auth: "public" | "bearer" | "session-mint" | "session-cookie" | "smtp-credential" | "transport-token";
  /** A prefix row that must NOT claim paths containing this segment. */
  exclude?: string;
  /** A prefix row that needs a non-empty remainder (the bare prefix does not match). */
  requireChild?: boolean;
  /**
   * A prefix row that matches the bare path OR a child under it, and nothing else.
   *
   * The rows whose path already ENDS in "/" get this for free from startsWith. The two
   * that cannot (/api/drafts and /api/imap/drafts must also answer on the bare path)
   * would otherwise claim their SIBLINGS too: plain startsWith("/api/drafts") also
   * swallows /api/drafts2 and /api/draftsx/d1, which the original if-chain
   * (`path === X || path.startsWith(X + "/")`) never did. Deriving the auth gate from a
   * plain prefix there would hand a read token a 403 on a path the worker does not
   * serve at all, instead of the 404 it used to get. Caught by the equivalence test.
   */
  requireSeparator?: boolean;
  /** Query-string names the handler reads. Proved live in route-params.test.ts. */
  query?: string[];
  /** Top-level JSON body keys the handler reads; `set.x` names a nested key. */
  body?: string[];
  /** How a CLIENT builds a parametric path. */
  template?: string;
  note?: string;
}

// The view filters shared by the two big read surfaces, declared once so a filter
// cannot be added to one and silently missed on the other (they share one builder).
const VIEW = ["to", "from", "direction", "lens", "mailbox", "seenFor", "limit", "cursor"];
const DRAFT_FIELDS = [
  "to", "cc", "bcc", "subject", "bodyText", "bodyHtml", "inReplyTo", "threadId",
  "composeMode", "sourceMessageId", "updatedAt",
];
const SEND_FIELDS = [
  "to", "cc", "bcc", "from", "replyTo", "subject", "text", "html", "headers",
  "attachments", "forwardMessageId",
];

export const ROUTE_TABLE: readonly RouteSpec[] = [
  // --- served BEFORE the bearer/session gate: each carries its own auth ---
  { id: "health", method: "GET", path: "/health", match: "exact", scope: null, auth: "public" },
  { id: "root", method: "GET", path: "/", match: "exact", scope: null, auth: "public" },
  { id: "webmail", method: "GET", path: "/webmail", match: "exact", scope: null, auth: "public",
    note: "the single-page human door; the page then calls the API with its own session" },
  { id: "mta-sts", method: "GET", path: "/.well-known/mta-sts.txt", match: "exact", scope: null, auth: "public" },
  { id: "smtp-auth", method: "POST", path: "/api/smtp-auth", match: "exact", scope: null,
    auth: "smtp-credential", body: ["username", "password"] },
  { id: "session", method: "ANY", path: "/api/session", match: "exact", scope: null,
    auth: "session-mint", body: ["username", "password"] },
  { id: "session-refresh", method: "ANY", path: "/api/session/refresh", match: "exact", scope: null,
    auth: "session-cookie" },
  { id: "ingest", method: "POST", path: "/ingest", match: "exact", scope: null, auth: "transport-token",
    note: "inbound mail ingestion, gated by POSTERN_TRANSPORT_TOKEN, never a mailbox token" },

  // --- write: send / reply ---
  { id: "send", method: "POST", path: "/api/send", match: "exact", scope: "send", auth: "bearer",
    body: SEND_FIELDS,
    note: "attachments are base64 over JSON (#70); forwardMessageId quotes a stored message, recipients stay caller-selected" },
  { id: "send-alias", method: "POST", path: "/send", match: "exact", scope: "send", auth: "bearer",
    body: SEND_FIELDS, note: "back-compat alias of /api/send: the same handler, so deliberately the same list" },
  { id: "reply", method: "POST", path: "/api/reply", match: "exact", scope: "send", auth: "bearer",
    body: ["messageId", "cc", "bcc", "from", "text", "html", "mode", "quoteOriginal", "attachments"],
    note: "mode reply|replyAll derives the original recipients server-side (#363)" },

  // --- read-state + placement: read-scoped, because managing your own read state IS
  // reading (the IMAP door often holds only a read token) ---
  { id: "messages-seen", method: "POST", path: "/api/messages/seen", match: "exact", scope: "read",
    auth: "bearer", body: ["ids", "seen", "for"],
    note: "`for` writes a per-recipient override; under a session it must be the session identity (#410)" },
  { id: "messages-flags", method: "POST", path: "/api/messages/flags", match: "exact", scope: "read",
    auth: "bearer", body: ["ids", "set", "set.flagged", "set.answered"] },
  { id: "messages-move", method: "POST", path: "/api/messages/move", match: "exact", scope: "read",
    auth: "bearer", body: ["ids", "mailbox"],
    note: "mailbox archive|trash|junk, or null to restore the direction-default view" },

  // --- drafts: identity-owned ---
  { id: "drafts", method: "ANY", path: "/api/drafts", match: "prefix", scope: "send", auth: "bearer",
    requireSeparator: true,
    template: "/api/drafts/{id}[/send|/attachments[/{attachmentId}]]", body: DRAFT_FIELDS,
    note: "list/create/update/delete/send plus draft attachments. Identity-owned: a static operator token gets E_IDENTITY_REQUIRED. PUT on an EXISTING draft requires its current updatedAt; an absent one is a conflict too, so an edit is read-modify-write" },

  // --- the IMAP service seam ---
  { id: "imap-drafts", method: "ANY", path: "/api/imap/drafts", match: "prefix", scope: "imap",
    auth: "bearer", requireSeparator: true, template: "/api/imap/drafts/{id}", query: ["identity"],
    body: ["identity", ...DRAFT_FIELDS],
    note: "the door has no ambient identity, so it asserts the already-authenticated one on every call" },
  { id: "imap-import", method: "POST", path: "/api/imap/import", match: "exact", scope: "imap",
    auth: "bearer", body: ["identity", "folder", "rawMime"],
    note: "folder sent|archive|trash|junk; rawMime is base64, refused 413 E_PAYLOAD_TOO_LARGE (before parse) past 22 MiB decoded (#493)" },
  { id: "imap-roles", method: "GET", path: "/api/imap/roles", match: "exact", scope: "imap",
    auth: "bearer",
    note: "role membership is single-sourced on the Worker (#438): the door reads this map per login instead of parsing its own mirror var. Same projection as the operator /api/roles, gated on the least-privilege door token" },

  // --- operator / admin ---
  { id: "admin-smtp-credentials", method: "POST", path: "/api/admin/smtp-credentials", match: "exact",
    scope: "admin", auth: "bearer", body: ["username", "from", "password"] },
  { id: "admin-smtp-credential-delete", method: "DELETE", path: "/api/admin/smtp-credentials/",
    match: "prefix", scope: "admin", auth: "bearer", requireChild: true,
    template: "/api/admin/smtp-credentials/{username}",
    note: "the bare prefix (no username) is deliberately NOT claimed, matching the original regex" },
  { id: "admin-reindex", method: "POST", path: "/api/admin/reindex", match: "exact", scope: "admin",
    auth: "bearer", body: ["cursor", "limit", "dryRun"] },
  { id: "admin-roles", method: "GET", path: "/api/roles", match: "exact", scope: "admin", auth: "bearer",
    note: "the role map is operator config (#425): who is on which queue is a deployment fact, not a mailbox view, so a read token cannot see it" },
  { id: "admin-reconcile", method: "POST", path: "/api/admin/reconcile", match: "exact", scope: "admin",
    auth: "bearer", body: ["limit", "sample"],
    note: "read-only report, gated admin because it spans the whole estate" },

  // --- hard delete: its own scope, and it MUST be matched before the read prefix ---
  { id: "message-delete", method: "DELETE", path: "/api/messages/", match: "prefix", scope: "delete",
    auth: "bearer", exclude: "/attachments/", template: "/api/messages/{id}",
    note: "not the /attachments/ sub-path" },

  // --- read ---
  { id: "messages-list", method: "GET", path: "/api/messages", match: "exact", scope: "read", auth: "bearer",
    query: [...VIEW, "thread", "q"],
    note: "lens needs a viewer and refuses direction (#403); under a session to= filters INSIDE the account boundary (#422); seenFor moves only the read-state projection key (#404)" },
  { id: "search", method: "GET", path: "/api/search", match: "exact", scope: "read", auth: "bearer",
    query: [...VIEW, "q", "mode", "field", "after", "before", "hasAttachment", "seen"],
    note: "mode fts|substr|semantic|hybrid; field pairs with substr; the view filters mirror messages-list exactly because they share one builder" },
  { id: "recipients-recent", method: "GET", path: "/api/recipients/recent", match: "exact", scope: "read",
    auth: "bearer", query: ["viewer", "to", "limit"],
    note: "a bound identity wins; an unbound BYO token must name viewer= or to=, never an estate dump" },
  { id: "folders", method: "GET", path: "/api/folders", match: "exact", scope: "read", auth: "bearer",
    query: ["to"], note: "to= scopes the unread counts; a bound identity wins over it server-side" },
  { id: "mobileconfig", method: "GET", path: "/api/mobileconfig", match: "exact", scope: "read",
    auth: "bearer", note: "per-user Apple profile; carries NO password" },
  { id: "message-get", method: "GET", path: "/api/messages/", match: "prefix", scope: "read", auth: "bearer",
    template: "/api/messages/{id}", note: "single message and its /attachments/{i} sub-route" },
  { id: "thread-get", method: "GET", path: "/api/threads/", match: "prefix", scope: "read", auth: "bearer",
    template: "/api/threads/{id}" },
];

function methodMatches(spec: RouteSpec, method: string): boolean {
  return spec.method === "ANY" || spec.method === method;
}

function pathMatches(spec: RouteSpec, path: string): boolean {
  if (spec.match === "exact") return path === spec.path;
  if (spec.exclude && path.includes(spec.exclude)) return false;
  // Plain startsWith by default, deliberately: the if-chain this replaced also claimed
  // the bare "/api/messages/" (empty id), which the handler then answers 400. Requiring
  // a remainder there would quietly drop the SCOPE GATE on that path, turning a read
  // token's 403 into a 400. The one row whose original matcher DID demand a remainder
  // (the credential regex) says so with requireChild, so the derivation stays
  // equivalent rather than incidentally hardened.
  if (spec.requireSeparator) return path === spec.path || path.startsWith(`${spec.path}/`);
  const least = spec.requireChild ? 1 : 0;
  return path.startsWith(spec.path) && path.length - spec.path.length >= least;
}

/** The first row that claims (method, path), or null when nothing handles it. */
export function matchRoute(method: string, path: string): RouteSpec | null {
  for (const spec of ROUTE_TABLE) {
    if (methodMatches(spec, method) && pathMatches(spec, path)) return spec;
  }
  return null;
}

/**
 * The scope a route/method demands, derived from the table above. Returns null for a
 * path with no API handler (so, once the token itself is valid, it falls through to the
 * same 404 as before) AND for the pre-gate rows, which never reach the gate.
 */
export function requiredScope(method: string, path: string): RouteScope | null {
  return matchRoute(method, path)?.scope ?? null;
}

/**
 * A `both` token satisfies every route; a scoped token satisfies only its own kind.
 * `admin` is satisfied solely by `both`: read/send tokens cannot reach the
 * credential-provisioning routes.
 */
export function scopeSatisfies(have: Scope, need: RouteScope): boolean {
  if (have === "both") return true;
  if (need === "read") return have === "read";
  if (need === "send") return have === "send";
  if (need === "delete") return have === "delete";
  if (need === "imap") return have === "imap";
  return false; // admin: only `both`
}
