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
export type RouteScope = "read" | "send" | "delete" | "imap" | "organize" | "admin";

/**
 * Every value of `RouteScope`, as DATA.
 *
 * `GET /api/whoami` (#650) reports the capability set the gate will actually honour, and
 * it computes that by asking `authorize()` about each scope below rather than keeping a
 * second list of what a token can do. A separately-maintained list could drift from the
 * gate, and a whoami answer that drifts is worse than no answer at all.
 *
 * The two assertions below make this tuple UNABLE to drift from the union, the same way
 * SUMMARY_FIELDS cannot drift from StoredMessageSummary: a scope added to `RouteScope`
 * and not here fails `npm run typecheck`, and so does a name here the union lacks.
 */
export const ROUTE_SCOPES = ["read", "send", "delete", "imap", "organize", "admin"] as const;

type ExactlyNever<T extends never> = T;
type _NoRouteScopeMissing = ExactlyNever<Exclude<RouteScope, (typeof ROUTE_SCOPES)[number]>>;
type _NoRouteScopeInvented = ExactlyNever<Exclude<(typeof ROUTE_SCOPES)[number], RouteScope>>;

export interface RouteSpec {
  /** Stable identifier, and the join key for the parameter manifest (#449). */
  id: string;
  /** The method that reaches this row; ANY = every method. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";
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
// The response PROJECTION (#646), declared once for the same two surfaces and for the
// same reason, but deliberately NOT folded into VIEW: VIEW names row FILTERS (WHICH
// messages come back), `fields` names the response SHAPE (which keys each one carries).
// Keeping the two lists apart is what stops a later reader from reading a projection as
// a filter, and stops a filter added here from reaching only one of the two routes.
const PROJECTION = ["fields"];
// The date window (#647), shared for the third time for the same reason: it was on `search`
// only, so the enumeration route could not answer "narrow this to a window" at all and the
// only date-capable path was the relevance-ranked one, which cannot prove absence. Declared
// as its own list because it is a ROW filter but not a VIEW filter: it takes no viewer and
// means the same thing with or without one.
const DATE_RANGE = ["after", "before"];
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
  { id: "health", method: "GET", path: "/health", match: "exact", scope: null, auth: "public",
    note: "JSON uptime probe only; do not probe GET / for health" },
  { id: "root", method: "GET", path: "/", match: "exact", scope: null, auth: "public",
    note: "HTML product landing (links to /webmail); not the health JSON" },
  { id: "robots", method: "GET", path: "/robots.txt", match: "exact", scope: null, auth: "public",
    note: "SEO robots + Sitemap pointer; served only on the posternonline.com zone (apex or any subdomain), 404 elsewhere so a self-hosted deploy never advertises the demo" },
  { id: "sitemap", method: "GET", path: "/sitemap.xml", match: "exact", scope: null, auth: "public",
    note: "SEO sitemap for demo landing + webmail; same posternonline.com zone gate as robots" },
  { id: "webmail", method: "GET", path: "/webmail", match: "exact", scope: null, auth: "public",
    note: "the single-page human door; the page then calls the API with its own session" },
  { id: "mta-sts", method: "GET", path: "/.well-known/mta-sts.txt", match: "exact", scope: null, auth: "public" },
  { id: "smtp-auth", method: "POST", path: "/api/smtp-auth", match: "exact", scope: null,
    auth: "smtp-credential", body: ["username", "secret"],
    note: "the relay and the IMAP door send `secret`, as CONTRACT.md 9 documents (#829); precred-body-contract.test.ts pins the declared body to what the handler reads" },
  { id: "session", method: "ANY", path: "/api/session", match: "exact", scope: null,
    auth: "session-mint", body: ["username", "password"] },
  { id: "session-refresh", method: "ANY", path: "/api/session/refresh", match: "exact", scope: null,
    auth: "session-cookie" },
  { id: "setup", method: "ANY", path: "/api/setup", match: "exact", scope: null, auth: "session-mint",
    body: ["setupToken", "username", "from", "displayName", "password"],
    note: "first run (#791, contract 1.10.7): armed only when WEBMAIL_AUTH_BACKEND is explicitly native AND the POSTERN_SETUP_TOKEN secret is set AND the account table is EMPTY; atomic; 409 E_SETUP_COMPLETE once any user exists; 404 when not armed" },
  { id: "session-password", method: "POST", path: "/api/session/password", match: "exact", scope: null,
    auth: "session-cookie", body: ["currentPassword", "newPassword"],
    note: "self-service change password (#790, contract 1.10.5): cookie session + CSRF only, a Bearer is refused; throttled on the sign-in keys; rotates this session and ends the others" },
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

  // --- read-state + placement: `organize`-scoped (#685) ---
  // These three CHANGE stored state: read state, flags, and which folder a message sits
  // in. `organize` names that power on its own, so the grant an operator issues to READ
  // a mailbox is separate from the grant to re-file one, and a token's name says which
  // it is. POSTERN_API_TOKEN_ORGANIZE (#692) is the slot that issues exactly that
  // grant; an `imap` token also carries it (see scopeSatisfies), and a `read` token
  // does not.
  // `GET /api/folders` stays `read`: listing folders does not change any of them, so
  // an organize-only token is refused there too (#692).
  { id: "messages-seen", method: "POST", path: "/api/messages/seen", match: "exact", scope: "organize",
    auth: "bearer", body: ["ids", "seen", "for"],
    note: "`for` writes a per-recipient override; under a session it must be the session identity (#410)" },
  { id: "messages-flags", method: "POST", path: "/api/messages/flags", match: "exact", scope: "organize",
    auth: "bearer", body: ["ids", "set", "set.flagged", "set.answered"] },
  { id: "messages-move", method: "POST", path: "/api/messages/move", match: "exact", scope: "organize",
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
  { id: "admin-users-list", method: "GET", path: "/api/admin/users", match: "exact", scope: "admin",
    auth: "bearer", query: ["limit", "cursor"],
    note: "human accounts (#790, contract 1.10.4): one keyset page ordered by username; never carries a hash" },
  { id: "admin-users-create", method: "POST", path: "/api/admin/users", match: "exact", scope: "admin",
    auth: "bearer", body: ["username", "from", "displayName", "password"],
    note: "create only, never overwrites (409 E_CONFLICT); a generated password is returned once" },
  { id: "admin-user-password", method: "POST", path: "/api/admin/users/", match: "prefix", scope: "admin",
    auth: "bearer", requireChild: true, template: "/api/admin/users/{username}/password", body: ["password"],
    note: "operator reset: ends the user's sessions and clears the account lockout" },
  { id: "admin-user-get", method: "GET", path: "/api/admin/users/", match: "prefix", scope: "admin",
    auth: "bearer", requireChild: true, template: "/api/admin/users/{username}" },
  { id: "admin-user-update", method: "PATCH", path: "/api/admin/users/", match: "prefix", scope: "admin",
    auth: "bearer", requireChild: true, template: "/api/admin/users/{username}",
    body: ["disabled", "displayName", "from"],
    note: "disable or a from change ends the user's sessions" },
  { id: "admin-user-delete", method: "DELETE", path: "/api/admin/users/", match: "prefix", scope: "admin",
    auth: "bearer", requireChild: true, template: "/api/admin/users/{username}" },
  // Runtime agent identities (#801): mint, list, revoke, and the audit log they write.
  // Operator only, on the smtp-credentials precedent: a runtime identity never holds
  // `admin`, so it cannot mint, list or revoke credentials.
  { id: "admin-identities-list", method: "GET", path: "/api/admin/identities", match: "exact", scope: "admin",
    auth: "bearer", query: ["limit", "cursor", "includeRevoked"],
    note: "runtime agent identities (#801): one keyset page ordered by createdAt; never carries a token or its hash; active only unless includeRevoked=1. Audited (identity.list)" },
  { id: "admin-identities-mint", method: "POST", path: "/api/admin/identities", match: "exact", scope: "admin",
    auth: "bearer", body: ["from", "scopes", "displayName", "label"],
    note: "scopes from read|send|organize; anything else (delete, imap, admin, both, a typo) is 400, never stripped. Returns the token ONCE (201); it is never retrievable again and only its sha256 is stored. Authenticates on the next request, no deploy. Audited (identity.mint)" },
  { id: "admin-identity-revoke", method: "DELETE", path: "/api/admin/identities/", match: "prefix", scope: "admin",
    auth: "bearer", requireChild: true, template: "/api/admin/identities/{id}",
    note: "the next request with its token is 401; no deploy. Idempotent; the row is kept with revokedAt and its id is never reused. Audited (identity.revoke)" },
  // Delegation grants (#740 S1): which agent identity may act on which human address,
  // with which powers. The store only; no route reads a grant for authorization yet.
  { id: "admin-delegations-list", method: "GET", path: "/api/admin/delegations", match: "exact", scope: "admin",
    auth: "bearer", query: ["limit", "cursor", "includeRevoked", "grantee", "address"],
    note: "#740 S1: one keyset page ordered by createdAt; active only unless includeRevoked=1; grantee= (an idn_ id) and address= filter. Audited (delegation.list)" },
  { id: "admin-delegations-grant", method: "POST", path: "/api/admin/delegations", match: "exact", scope: "admin",
    auth: "bearer", body: ["granteeId", "address", "powers", "label"],
    note: "#740 S1: granteeId must be a LIVE agent identity (400 E_GRANTEE_INVALID otherwise, checked in the same statement as the insert); powers from read|organize|quote|send_as, anything else 400, and every power implies read (the stored set always carries it); address on the deploy domain and not the grantee's own; one active grant per (grantee, address), else 409 E_CONFLICT. No behaviour change in S1. Audited (delegation.grant)" },
  { id: "admin-delegation-revoke", method: "DELETE", path: "/api/admin/delegations/", match: "prefix", scope: "admin",
    auth: "bearer", requireChild: true, template: "/api/admin/delegations/{id}",
    note: "#740 S1: idempotent; the row is kept with revokedAt and its id is never reused. Audited (delegation.revoke)" },
  { id: "admin-principals-backfill", method: "POST", path: "/api/admin/principals/backfill", match: "exact",
    scope: "admin", auth: "bearer",
    note: "#854 M1: copy agent identities, human users and the static slots into the principal tables. Idempotent and convergent; store only, nothing authorizes from it yet. Audited (principals.backfill)" },
  { id: "admin-principals-parity", method: "GET", path: "/api/admin/principals/parity", match: "exact",
    scope: "admin", auth: "bearer",
    note: "#854 M2: compare every agent identity and human user with its principal and credential; counts plus sample ids. The evidence for retiring the old-table fallback. Audited (principals.parity)" },
  // #740 S5: the human's own delegation and audit trail. A webmail SESSION only (the
  // handler refuses every Bearer, E_SESSION_REQUIRED); `read` is held by every session, and
  // the gate's CSRF check covers the state-changing verbs. The address is always the
  // session's own, so no route takes one.
  { id: "self-delegation-grantees", method: "GET", path: "/api/delegations/mine/grantees", match: "exact", scope: "read",
    auth: "session-cookie",
    note: "#740 S5: the live agent identities a human may grant to, exactly {id, displayName, from}. Every signed-in human on the deploy sees this roster" },
  { id: "self-delegations-list", method: "GET", path: "/api/delegations/mine", match: "exact", scope: "read",
    auth: "session-cookie",
    note: "#740 S5: the active grants on the session's own address (live grantees only), newest first" },
  { id: "self-delegations-grant", method: "POST", path: "/api/delegations/mine", match: "exact", scope: "read",
    auth: "session-cookie", body: ["granteeId", "powers", "label"],
    note: "#740 S5: grant on the session's own address; an address field is refused. Audited (delegation.grant, actor human)" },
  // #853: human-only threads. Ahead of the generic revoke row, which would otherwise claim
  // the DELETE (the table is first-match).
  { id: "self-exclusions-list", method: "GET", path: "/api/delegations/mine/exclusions", match: "exact", scope: "read",
    auth: "session-cookie",
    note: "#853: the active human-only marks on the session's own address, newest first, each {id, threadId, subject, createdAt}" },
  { id: "self-exclusion-create", method: "POST", path: "/api/delegations/mine/exclusions", match: "exact", scope: "read",
    auth: "session-cookie", body: ["threadId"],
    note: "#853: mark a thread human-only on the session's own address: no agent reads, quotes, organizes or replies into the owner's mail in it. 201 on create, 200 on a repeat; a thread with none of the owner's mail is the same 404 as an unknown one. Audited (delegation.exclude, actor human)" },
  { id: "self-exclusion-delete", method: "DELETE", path: "/api/delegations/mine/exclusions/", match: "prefix", scope: "read",
    auth: "session-cookie", requireChild: true, template: "/api/delegations/mine/exclusions/{id}",
    note: "#853: remove a human-only mark; any id not active on the session's own address is the same 404. Audited (delegation.unexclude, actor human)" },
  { id: "self-delegation-revoke", method: "DELETE", path: "/api/delegations/mine/", match: "prefix", scope: "read",
    auth: "session-cookie", requireChild: true, template: "/api/delegations/mine/{id}",
    note: "#740 S5: revoke a grant on the session's own address; any other id is the same 404 as a missing one. Audited (delegation.revoke, actor human)" },
  { id: "self-audit", method: "GET", path: "/api/audit/mine", match: "exact", scope: "read", auth: "session-cookie",
    query: ["limit", "cursor"],
    note: "#740 S5: the audit rows about the session's own address (grants, revokes, send_as, quotes, organize writes), newest first" },
  { id: "admin-audit", method: "GET", path: "/api/admin/audit", match: "exact", scope: "admin", auth: "bearer",
    query: ["limit", "cursor"],
    note: "the audit log (#801), newest first: actor, action, target, outcome, detail. Refusals are recorded too" },
  { id: "admin-reindex", method: "POST", path: "/api/admin/reindex", match: "exact", scope: "admin",
    auth: "bearer", body: ["cursor", "limit", "dryRun", "staleOnly"],
    note: "#813: staleOnly re-embeds only messages whose ledger rows are below the current embed recipe (EMBED_VERSION); skippedCurrent counts the rest" },
  { id: "admin-reproject", method: "POST", path: "/api/admin/reproject", match: "exact",
    scope: "admin", auth: "bearer", body: ["cursor", "limit", "dryRun", "countOnly"],
    note: "#507 refill projected_size after a PROJECTION_VERSION bump (idempotent; dryRun writes nothing); #520 countOnly returns { total, atCurrent, notCurrent } with no paging" },
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
  // #650: the Bearer-reachable "who am I". `read`-scoped DELIBERATELY, not open to every
  // valid token. What it answers is `readScopeReport`, i.e. WHOSE MAIL A READ IS BOUND
  // TO, and for a credential that cannot read at all that projection has no truthful
  // value: a send-only or organize-only token has no bound READ member, so the honest
  // projection would compute `{kind:"estate"}` and tell a token that is 403 on every read
  // route that it can read the whole estate. That is a worse answer than a 403. A caller
  // that needs to interpret an empty read page is by definition read-capable, which is
  // exactly the caller this serves. A send token's own open question is which From the
  // server will force on it, which is a send-response concern (#632 F13), not this route.
  { id: "whoami", method: "GET", path: "/api/whoami", match: "exact", scope: "read", auth: "bearer",
    note: "the caller identity and the scope the SERVER imposes on its reads (#650): bound identity or null, the same identityScope projection /api/messages and /api/search emit, the role queues that identity may also read via to=, and the capability set the gate honours (derived by asking authorize() per scope, never a second list). Takes no parameters, so it reports the scope a BARE read would get" },
  { id: "messages-list", method: "GET", path: "/api/messages", match: "exact", scope: "read", auth: "bearer",
    // `countOnly` (#648) is neither a VIEW filter nor a PROJECTION, so it joins neither
    // shared list: it is a MODE. It changes what the response IS (a total, with no items
    // and no cursor) rather than which rows match or which keys each one carries, and it
    // exists only on this route. Keeping it inline is the same reason PROJECTION and
    // DATE_RANGE are separate lists: one list per reason, so a later reader cannot read a
    // mode as a filter.
    query: [...VIEW, ...PROJECTION, ...DATE_RANGE, "thread", "q", "countOnly"],
    note: "lens needs a viewer and refuses direction (#403); under a session to= filters INSIDE the account boundary (#422); seenFor moves only the read-state projection key (#404); fields= projects the response to named summary keys and REFUSES an unknown one (#646); after=/before= are INCLUSIVE at BOTH ends, ISO-8601 date or timestamp, a bare date covering its whole named day, and a bogus value is refused not applied (#647); countOnly=1 answers { total } for the SAME filters and the SAME access scope with no items and no cursor, and is REFUSED alongside limit/cursor/fields because all three describe rows a count does not return (#648, mirroring admin-reproject's countOnly from #520)" },
  { id: "search", method: "GET", path: "/api/search", match: "exact", scope: "read", auth: "bearer",
    query: [...VIEW, ...PROJECTION, ...DATE_RANGE, "q", "mode", "field", "hasAttachment", "seen", "collapse", "collapseThreads"],
    note: "mode fts|substr|semantic|hybrid; field pairs with substr; the view filters mirror messages-list exactly because they share one builder. Mind the pair: field (SINGULAR) selects the substr COLUMN MATCHED, fields (PLURAL, #646) selects the summary keys RETURNED on hit.message; both are validated strictly. after=/before= are the SAME inclusive, canonicalized, strictly-refused bounds messages-list uses (#647); they were unvalidated here until then. cursor is the (date, id) keyset on fts and substr; on semantic and hybrid it is REFUSED with E_VALIDATION_ERROR, never accepted and dropped, because those modes are score-ranked and have no continuation (#803)" },
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
    template: "/api/threads/{id}", query: ["limit", "cursor"],
    note: "bounded and keyset-paginated (#649): it used to select EVERY message in the thread, bodies included, with no LIMIT and no cursor. Oldest first, so the keyset reads FORWARD through the same (date, id) tuple the other read routes use. Default 20, lower than the summary default because a thread row carries full bodies; max 200. `cursor: null` is the POSITIVE claim that this is the whole thread, so a non-null cursor means first page, not thread" },
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
 *
 * `organize` is the one scope that TWO kinds satisfy: its own `organize` token, and an
 * `imap` token.
 *
 * The `imap` arm came first (#685), because the IMAP door is the machine client the
 * organize routes exist for and it already had a token slot. It keeps the grant, so no
 * deployed door has to re-provision.
 *
 * The `organize` arm is #692. #687 shipped the scope with no slot of its own, so an
 * operator who wanted to grant organize and nothing else had to hand over the door's
 * key or a `both` key. One makes two consumers share a credential; the other also
 * reaches send, delete and admin. Naming a power and then having no key for it is the
 * per-function-keys rule broken by omission.
 *
 * A `read` token still does NOT carry organize. Reading mail and filing mail are
 * separate grants, so a token issued to read cannot change what the mailbox looks like.
 * `send` and `delete` are deliberately not accepted either: reusing one of them would
 * put two unrelated powers behind one name, which is the shape that made the organize
 * routes sit under `read` in the first place.
 *
 * The new arm is ONE-WAY. An `organize` token satisfies organize and nothing else, so
 * it is refused on read, send, delete, imap and admin. `GET /api/folders` stays `read`
 * (see the table above), which means an organize-only token cannot list folders.
 * Listing folders reads the mailbox and changes nothing in it, so it is a read.
 */
export function scopeSatisfies(have: Scope, need: RouteScope): boolean {
  if (have === "both") return true;
  if (need === "read") return have === "read";
  if (need === "send") return have === "send";
  if (need === "delete") return have === "delete";
  if (need === "imap") return have === "imap";
  if (need === "organize") return have === "organize" || have === "imap";
  // #904: the admin slot holds admin and NOTHING else, so automation that runs an admin
  // route (the post-deploy principal backfill) never holds a key that reads or sends mail.
  if (need === "admin") return have === "admin";
  return false; // admin: only `both`
}
