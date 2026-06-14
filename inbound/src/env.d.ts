interface Env {
  /** D1 database for inbound message storage. */
  DB: D1Database;
  /** Vectorize index for semantic search over message bodies. */
  VECTORIZE: VectorizeIndex;
  /** AI binding for embeddings (routed through AI Gateway). */
  AI: Ai;
  /**
   * Comma-separated list of trusted sender domains/addresses.
   * Only senders on this list that also pass SPF or DKIM get trusted=1.
   * Example: "skyphusion.org,rockenhaus.net,github.com,healthchecks.io"
   */
  TRUSTED_SENDER_DOMAINS: string;
}
