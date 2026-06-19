// Hand-written binding + var types for this Worker. `wrangler types` would
// regenerate an `Env` from wrangler.jsonc; keep this in sync if you adopt that.

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

/** The `send_email` binding surface we rely on. */
interface EmailSendBinding {
  send(message: SendEmailMessage): Promise<{ messageId?: string } | undefined>;
}

interface Env {
  /** send_email binding (wrangler.jsonc -> send_email[].name = "EMAIL"). */
  EMAIL: EmailSendBinding;
  /**
   * Shared secret for the public /send endpoint. `wrangler secret put POSTERN_API_TOKEN`.
   * RELAY_TOKEN is read as a fallback for one release through the rename.
   */
  POSTERN_API_TOKEN?: string;
  /** @deprecated Back-compat fallback for POSTERN_API_TOKEN; remove next release. */
  RELAY_TOKEN?: string;
  /** Default From address when a request omits `from`. Required for the public release. */
  DEFAULT_FROM?: string;
  /** Optional display name paired with DEFAULT_FROM. */
  DEFAULT_FROM_NAME?: string;
  /** Only From addresses on this domain are permitted. Required for the public release. */
  ALLOWED_FROM_DOMAIN?: string;
}
