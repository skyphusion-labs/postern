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
  /** Vectorize index for semantic search over message bodies. */
  VECTORIZE: VectorizeIndex;
  /** R2 bucket holding inbound attachment bytes (keys referenced in D1.attachments). */
  ATTACHMENTS: R2Bucket;
  /** AI binding for embeddings (routed through AI Gateway). */
  AI: Ai;
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
