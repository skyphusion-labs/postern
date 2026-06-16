interface Env {
  /** D1 database for inbound message storage. */
  DB: D1Database;
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
}
