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
   * Example: "skyphusion.org,rockenhaus.net,github.com,healthchecks.io"
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

  // --- Mailbox send/reply API (M2: #23/#26) ---
  /**
   * Mailbox API token for the client-facing send/reply + read endpoints
   * (Authorization: Bearer ...). NOT the transport token. wrangler secret put
   * POSTERN_API_TOKEN. RELAY_TOKEN is read as a one-release rename fallback.
   */
  POSTERN_API_TOKEN?: string;
  /** @deprecated Back-compat fallback for POSTERN_API_TOKEN; remove next release. */
  RELAY_TOKEN?: string;
  /**
   * Optional per-function READ-scoped mailbox token (#85). When set, a caller
   * presenting it reaches ONLY the read door (GET /api/messages|search|threads
   * and attachment bytes); it cannot send or touch admin routes. Independent of
   * POSTERN_API_TOKEN and separately rotatable. wrangler secret put
   * POSTERN_API_TOKEN_READ. Leave unset to keep the single-token (`both`) posture.
   */
  POSTERN_API_TOKEN_READ?: string;
  /**
   * Optional per-function SEND-scoped mailbox token (#85). When set, a caller
   * presenting it reaches ONLY the write door (POST /api/send|reply); it cannot
   * read the store or touch admin routes. Independent of POSTERN_API_TOKEN and
   * separately rotatable. wrangler secret put POSTERN_API_TOKEN_SEND. Leave unset
   * to keep the single-token (`both`) posture.
   */
  POSTERN_API_TOKEN_SEND?: string;
  /**
   * Optional per-identity SEND registry (#28). A JSON object mapping the sha256 HEX
   * of a send token -> its bound sender identity { from, displayName? }. MANY tokens,
   * each the SAME send scope but a DISTINCT, authoritative From, so crew + released
   * users send as THEMSELVES via their own token instead of one shared key. Stores
   * token HASHES, never raw tokens, so this secret never holds a plaintext send
   * credential. The worker hashes the presented Bearer and looks it up; a hit forces
   * the From to the bound identity on /api/send + /api/reply. Additive: leave unset to
   * keep the static both/read/send posture. wrangler secret put POSTERN_SEND_IDENTITIES.
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
}
