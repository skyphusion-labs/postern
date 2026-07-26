/**
 * One attachment accepted by the Cloudflare Email Sending binding. Mirrors the
 * runtime `EmailAttachment` type (workerd / @cloudflare/workers-types): the
 * binding builds the MIME itself, so we never hand-roll multipart/mixed. `content`
 * is raw bytes (an ArrayBufferView), NOT base64 -- the transport base64-DECODES the
 * JSON wire value before handing it here. `disposition` is "attachment" for v1;
 * inline-cid fidelity (disposition:"inline" + contentId) is a tracked follow-up.
 */
interface SendEmailAttachment {
  filename: string;
  type: string; // MIME type, e.g. "application/pdf"
  disposition: "attachment";
  content: ArrayBuffer | ArrayBufferView;
}

/** Message accepted by the Cloudflare Email Sending binding (send_email). */
interface SendEmailMessage {
  to: string | string[];
  from: string | { email: string; name?: string };
  replyTo?: string | { email: string; name?: string };
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
}

/** The send_email binding surface we rely on. */
interface EmailSendBinding {
  send(message: SendEmailMessage): Promise<{ messageId?: string } | undefined>;
}

interface Env {
  /** D1 database for inbound message storage and the sent-copy store (#27). */
  DB: D1Database;
  /**
   * Cloudflare Email Sending binding (send_email -> EMAIL). The default outbound
   * transport for the mailbox send/reply API (#23/#26). Optional so the inbound
   * store/ingest path still typechecks where sending is not configured.
   */
  EMAIL?: EmailSendBinding;
  /** Vectorize index for semantic search over message bodies. Optional: omit to disable semantic recall. */
  VECTORIZE?: VectorizeIndex;
  /** R2 bucket holding inbound attachment bytes (keys referenced in D1.attachments). */
  ATTACHMENTS: R2Bucket;
  /** AI binding for embeddings (routed through AI Gateway). Optional: omit to disable semantic recall. */
  AI?: Ai;
  /**
   * Comma-separated list of trusted sender domains/addresses.
   * Only senders on this list that also pass SPF or DKIM get trusted=1.
   * Example: "skyphusion.org,example.net,github.com,healthchecks.io"
   *
   * Declared REQUIRED like every sibling comma-list var (FORWARD_FOR, VECTORIZE_FOR,
   * FILE_ALSO_UNDER): this type describes a COMPLETE config, and both shipped wrangler
   * configs set it. The runtime never leans on that promise -- isTrusted() guards the
   * read the way vectorizeAllowlist() and the FORWARD_FOR read do, so an operator who
   * prunes the var gets an empty allowlist (nothing trusted), never a throw on the
   * ingest path (#473).
   */
  TRUSTED_SENDER_DOMAINS: string;
  /**
   * Destination address for transparent forwarding after ingestion.
   * Leave empty to disable forwarding (worker stores only, does not deliver).
   */
  FORWARD_TO: string;
  /**
   * Comma-separated list of recipient addresses that should be forwarded to
   * FORWARD_TO. Emails addressed to anyone not on this list are stored only.
   * Leave empty to forward everything (not recommended when crew share the domain).
   * Example: "conrad@skyphusion.org,alerts@skyphusion.org"
   */
  FORWARD_FOR: string;
  /**
   * Comma-separated list of recipient addresses whose mail is indexed in
   * Vectorize for crew RAG access. Opt-in only -- crew emails stay private
   * unless they add their own address here. Leave empty to index everything.
   * Example: "conrad@skyphusion.org,alerts@skyphusion.org"
   */
  VECTORIZE_FOR: string;
  /**
   * Role-address filing map: comma-separated `recipient=alsoFileUnder` pairs. A
   * message delivered to the left address is recorded as delivered to the right one as
   * well, so it appears in that mailbox view of the SAME stored message. Nothing is
   * copied, forwarded, or re-transmitted.
   *
   * For shared role addresses (`abuse@`, `security@`, `support@`) on a
   * deployment whose mailbox views are scoped per account: with no owner, such an
   * address is stored but appears in no human view.
   *
   * Single hop (a target is never expanded again); self-maps and duplicates are no-ops;
   * malformed entries are skipped with a warning; empty changes nothing.
   * Example: "abuse@example.com=owner@example.com,security@example.com=owner@example.com"
   */
  FILE_ALSO_UNDER: string;
  /**
   * Role-address MEMBERSHIP for bound webmail sessions (#425, the webmail half of the
   * #404 ruling): comma-separated `role=member+member` entries, full mail addresses on
   * both sides. A session identity that is a member of a role may read that role queue
   * as its OWN view (never merged into the personal INBOX), with read state kept per
   * MEMBER. Non-members see nothing.
   *
   * THE SINGLE SOURCE of role membership (#438). The IMAP door used to mirror this in
   * POSTERN_IMAP_VIEWER_ROLES and now READS the parsed map from GET /api/imap/roles
   * with its imap-scoped token, so one membership decision configures both human
   * doors and neither can hold a different answer; a door still carrying the retired
   * var refuses to start. Deploy the Worker first, then roll the door. GET /api/roles
   * (operator token) is the same projection at admin scope.
   *
   * Fail-closed: ANY malformed or ambiguous entry drops the WHOLE map (no role queue is
   * served) rather than silently dropping one member. Empty/unset changes nothing.
   * Example: "abuse@example.com=ada@example.com+ben@example.com"
   */
  POSTERN_VIEWER_ROLES?: string;

  // --- Mailbox send/reply API (M2: #23/#26) ---
  /**
   * Mailbox API token for the client-facing send/reply + read endpoints
   * (Authorization: Bearer ...). NOT the transport token. wrangler secret put
   * POSTERN_API_TOKEN.
   */
  POSTERN_API_TOKEN?: string;
  /**
   * Optional per-function READ-scoped mailbox token slot (#85). Holds a
   * comma-separated SET of tokens (#154): entries trimmed, empties dropped; a
   * caller presenting ANY member reaches ONLY the read door (GET
   * /api/messages|search|threads and attachment bytes) and cannot send or touch
   * admin routes. A single bare value (no comma) is a one-element set, the
   * original format, unchanged. Give each read consumer (IMAP door, MCP,
   * webmail) its own member so one can be rotated or revoked without stranding
   * the others. Independent of POSTERN_API_TOKEN. wrangler secret put
   * POSTERN_API_TOKEN_READ. Leave unset to keep the single-token (`both`) posture.
   */
  POSTERN_API_TOKEN_READ?: string;
  /**
   * Optional per-function SEND-scoped mailbox token slot (#85). Holds a
   * comma-separated SET of tokens (#154, same format as the READ slot): a caller
   * presenting ANY member reaches ONLY the write door (POST /api/send|reply, un-
   * bound From) and cannot read the store or touch admin routes. For send-as-an-
   * identity, prefer the per-identity registry (POSTERN_SEND_IDENTITIES).
   * Independent of POSTERN_API_TOKEN. wrangler secret put POSTERN_API_TOKEN_SEND.
   * Leave unset to keep the single-token (`both`) posture.
   */
  POSTERN_API_TOKEN_SEND?: string;
  /**
   * Optional per-function DELETE-scoped mailbox token slot (#352, contract section 4,
   * the C4 fix). Holds a comma-separated SET of tokens (#154, same format as the READ
   * and SEND slots): a caller presenting ANY member reaches ONLY the hard-delete door
   * (DELETE /api/messages/{id}, empty-Trash / IMAP EXPUNGE) and cannot read, send, or
   * touch admin routes. This lets the IMAP door's EXPUNGE credential drop from a
   * full-admin `both` token to delete-only least privilege. `both` still satisfies
   * delete too. Independent of POSTERN_API_TOKEN. wrangler secret put
   * POSTERN_API_TOKEN_DELETE. Leave unset to keep the single-token (`both`) posture.
   */
  POSTERN_API_TOKEN_DELETE?: string;
  /**
   * Optional IMAP-service write token (#352). This is a comma-set static slot
   * used only by /api/imap/* for service-asserted, authenticated identities:
   * durable Drafts and APPEND import. It cannot read the estate, send mail,
   * hard-delete, or reach admin routes. Keep separate from the read and delete
   * tokens projected to the IMAP door.
   */
  POSTERN_API_TOKEN_IMAP?: string;
  /**
   * Optional per-identity SEND registry (#28). A JSON object mapping the sha256 HEX
   * of a send token -> its bound sender identity { from, displayName? }. MANY tokens,
   * each the SAME send scope but a DISTINCT, authoritative From, so crew + released
   * users send as THEMSELVES via their own token instead of one shared key. Stores
   * token HASHES, never raw tokens, so the registry never holds a plaintext send
   * credential. The worker hashes the presented Bearer and looks it up; a hit forces
   * the From to the bound identity on /api/send + /api/reply. Additive: leave unset to
   * keep the static both/read/send posture. Because it holds NO credential it is a
   * plain-text VAR in wrangler config ("vars"), not a secret (#335): readable,
   * mergeable, diffable, and recoverable from the deployed worker. Vars ship on every
   * wrangler deploy (only secrets persist), so it lives in the config you deploy with.
   */
  POSTERN_SEND_IDENTITIES?: string;
  /** Default From when a send omits it. Must be on ALLOWED_FROM_DOMAIN. */
  DEFAULT_FROM?: string;
  /** Optional display name paired with DEFAULT_FROM. */
  DEFAULT_FROM_NAME?: string;
  /** Only From addresses on this domain are permitted for outbound. */
  ALLOWED_FROM_DOMAIN?: string;
  /** Outbound transport selector: unset/"cf" = Cloudflare Email (default), "relay" = postern-relay. */
  OUTBOUND_TRANSPORT?: string;
  /** RelayTransport: the postern-relay /dispatch URL (used when OUTBOUND_TRANSPORT=relay). */
  RELAY_DISPATCH_URL?: string;
  /**
   * RelayTransport bearer token for /dispatch -- the TRANSPORT token, NOT the
   * mailbox API token (CONTRACT section 5). wrangler secret put POSTERN_TRANSPORT_TOKEN.
   */
  POSTERN_TRANSPORT_TOKEN?: string;
  // --- Per-user .mobileconfig generator (#187, iOS Mail one-tap setup) ---
  /** IMAP hostname advertised in the generated Apple profile. Default: imap.<ALLOWED_FROM_DOMAIN>. */
  MOBILECONFIG_IMAP_HOST?: string;
  /** SMTP submission hostname advertised in the generated Apple profile. Default: smtp.<ALLOWED_FROM_DOMAIN>. */
  MOBILECONFIG_SMTP_HOST?: string;
  /** Organization label (PayloadOrganization). Default: DEFAULT_FROM_NAME, else "Postern". */
  MOBILECONFIG_ORG?: string;
  /** Reverse-DNS PayloadIdentifier prefix. Default: reversed ALLOWED_FROM_DOMAIN + ".postern". */
  MOBILECONFIG_IDENTIFIER?: string;

  // --- MTA-STS policy route (#197, RFC 8461; env-gated, dark by default) ---
  /** MTA-STS mode: "testing" | "enforce" | "none". UNSET => GET /.well-known/mta-sts.txt returns 404 (feature off). */
  MTA_STS_MODE?: string;
  /** Comma-separated MTA-STS `mx:` pattern(s). For CF Email Routing: "*.mx.cloudflare.net". Required when mode is testing/enforce. */
  MTA_STS_MX?: string;
  /** MTA-STS policy cache lifetime in seconds (e.g. 86400 testing, 604800 enforce). Required when MTA_STS_MODE is set. */
  MTA_STS_MAX_AGE?: string;

  // --- Webmail v2 session auth (#351, epic #338; docs/design/webmail-v2-contracts.md) ---
  /**
   * Webmail session backend selector. "native" mints a session by verifying a
   * smtp_credentials login (the same PBKDF2 the submission relay uses); "off" (the
   * DEFAULT when UNSET) exposes NO session endpoint -- BYO-token webmail only, exactly
   * the current behavior. "ldap"/"system" (directory login, contract 1.9 / decision
   * D-AUTH-2) are DEFERRED and Conrad-gated; they are treated as "off" until that phase.
   * The default is deliberately "off" (not the contract-recommended "native") so that
   * merging this feature changes nothing on a live shared store; a self-hoster sets
   * WEBMAIL_AUTH_BACKEND=native to opt in. Config VAR, not a secret (holds no credential).
   */
  WEBMAIL_AUTH_BACKEND?: string;
  /** Session idle window in seconds (sliding). Default 1800 (30 min). Config var. */
  WEBMAIL_SESSION_IDLE_SECONDS?: string;
  /** Session absolute lifetime cap in seconds. Default 43200 (12 h). Config var. */
  WEBMAIL_SESSION_ABSOLUTE_SECONDS?: string;

  // --- Session-mint brute-force throttle (#409; inbound/src/auththrottle.ts) ---
  /**
   * Set to "off" to disable the POST /api/session throttle entirely. ON by default
   * (a security control defaults to enabled); "off" exists for a self-host debug
   * window, and turning it off leaves the one public password endpoint unguarded.
   */
  WEBMAIL_AUTH_THROTTLE?: string;
  /** Consecutive failures on one key (account or client IP) before it locks. Default 5. */
  WEBMAIL_AUTH_MAX_FAILURES?: string;
  /** Base lockout in seconds, doubled per failure past the threshold. Default 60. */
  WEBMAIL_AUTH_LOCKOUT_SECONDS?: string;
  /** Backoff cap in seconds; also the idle-decay window. Default 3600. Clamped to >= the base lockout. */
  WEBMAIL_AUTH_MAX_LOCKOUT_SECONDS?: string;
  /**
   * Optional GLOBAL layer: failures across ALL accounts within
   * WEBMAIL_AUTH_GLOBAL_WINDOW_SECONDS before every mint cools down for one window.
   * DEFAULT 0 (off): on a public endpoint a global cooldown is a login-denial lever
   * any anonymous attacker can pull for everyone, and the per-client-IP layer already
   * covers spread-spraying. Opt in only where that trade is understood.
   */
  WEBMAIL_AUTH_GLOBAL_MAX?: string;
  /** Global-layer window in seconds (also the global cooldown length). Default 60. */
  WEBMAIL_AUTH_GLOBAL_WINDOW_SECONDS?: string;
}
