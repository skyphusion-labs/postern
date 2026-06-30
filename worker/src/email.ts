// Core send logic shared by the RPC entrypoint (service-binding callers) and
// the public HTTP endpoint (the on-host SMTP relay). Validation lives here so
// both surfaces behave identically.

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailRequest {
  to: string | string[];
  /** Defaults to env.DEFAULT_FROM. Must be on the allowed sender domain. */
  from?: string | EmailAddress;
  replyTo?: string | EmailAddress;
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId?: string;
}

/** Thrown for caller-fixable problems; carries a stable code + HTTP status. */
export class EmailError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "EmailError";
    this.code = code;
    this.status = status;
  }
}

// Deliberately permissive; the real validation is done by the upstream service.
// We only reject obviously malformed addresses to fail fast with a clear code.
// The domain is matched as dot-free labels joined by literal dots, so no two
// adjacent quantifiers share a character class -- that keeps matching linear and
// avoids the polynomial backtracking (ReDoS) a pattern like `[^@\s]+\.[^@\s]+`
// invites on crafted input. Behavior is unchanged for valid addresses; the only
// difference is that malformed forms with empty labels (e.g. "a@b..com",
// "a@b.com.") are now correctly rejected instead of accepted.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const MAX_RECIPIENTS = 50;
// Defense in depth against header injection: any CR or LF in a single-line
// field (subject, from/reply-to display name, custom header key/value) could let
// a caller smuggle extra headers or split the message. Reject them outright.
const CRLF_RE = /[\r\n]/;
// Cap the JSON-serialized body so a single request can't exhaust worker memory.
// Cloudflare Email Sending caps a message near 25 MiB; we bound the request a
// little above that so a legitimate max-size message still passes.
export const MAX_BODY_BYTES = 30 * 1024 * 1024;

function rejectCRLF(label: string, value: string): void {
  if (CRLF_RE.test(value)) {
    throw new EmailError("E_VALIDATION_ERROR", `${label} must not contain line breaks`);
  }
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function validateRecipients(label: string, list: string[]): void {
  for (const addr of list) {
    if (typeof addr !== "string" || !EMAIL_RE.test(addr.trim())) {
      throw new EmailError("E_VALIDATION_ERROR", `invalid ${label} address: ${addr}`);
    }
  }
}

function resolveFrom(env: Env, from: EmailRequest["from"]): EmailAddress {
  const allowedDomain = (env.ALLOWED_FROM_DOMAIN || "skyphusion.org").toLowerCase();
  const fallback = env.DEFAULT_FROM || `noreply@${allowedDomain}`;

  let email: string;
  let name: string | undefined;
  if (from === undefined) {
    email = fallback;
    name = env.DEFAULT_FROM_NAME;
  } else if (typeof from === "string") {
    email = from;
  } else {
    email = from.email;
    name = from.name;
  }

  email = (email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    throw new EmailError("E_VALIDATION_ERROR", `invalid from address: ${email}`);
  }
  const domain = email.split("@")[1].toLowerCase();
  if (domain !== allowedDomain) {
    throw new EmailError(
      "E_SENDER_NOT_ALLOWED",
      `from address must be on @${allowedDomain}`,
      403,
    );
  }
  if (name !== undefined) rejectCRLF("from name", name);
  return name ? { email, name } : { email };
}

export async function sendEmail(env: Env, req: EmailRequest): Promise<SendResult> {
  if (!req || typeof req !== "object") {
    throw new EmailError("E_VALIDATION_ERROR", "request body must be an object");
  }
  if (typeof req.subject !== "string" || req.subject.trim() === "") {
    throw new EmailError("E_FIELD_MISSING", "subject is required");
  }
  rejectCRLF("subject", req.subject);
  if (!req.html && !req.text) {
    throw new EmailError("E_FIELD_MISSING", "at least one of html or text is required");
  }

  const to = asArray(req.to);
  const cc = asArray(req.cc);
  const bcc = asArray(req.bcc);
  if (to.length === 0) {
    throw new EmailError("E_FIELD_MISSING", "at least one to recipient is required");
  }
  validateRecipients("to", to);
  validateRecipients("cc", cc);
  validateRecipients("bcc", bcc);
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new EmailError(
      "E_TOO_MANY_RECIPIENTS",
      `combined to/cc/bcc exceeds ${MAX_RECIPIENTS}`,
    );
  }

  const from = resolveFrom(env, req.from);

  if (req.replyTo !== undefined) {
    const replyTo = req.replyTo;
    const replyEmail = (typeof replyTo === "string" ? replyTo : replyTo?.email ?? "").trim();
    if (!EMAIL_RE.test(replyEmail)) {
      throw new EmailError("E_VALIDATION_ERROR", `invalid replyTo address: ${replyEmail}`);
    }
    if (typeof replyTo !== "string" && replyTo.name !== undefined) {
      rejectCRLF("replyTo name", replyTo.name);
    }
  }

  if (req.headers) {
    if (typeof req.headers !== "object" || Array.isArray(req.headers)) {
      throw new EmailError("E_VALIDATION_ERROR", "headers must be an object");
    }
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") {
        throw new EmailError("E_VALIDATION_ERROR", `header ${key} must be a string`);
      }
      rejectCRLF(`header ${key}`, key);
      rejectCRLF(`header ${key}`, value);
    }
  }

  const message: SendEmailMessage = {
    to,
    from: from.name ? from : from.email,
    subject: req.subject,
  };
  if (req.html) message.html = req.html;
  if (req.text) message.text = req.text;
  if (cc.length) message.cc = cc;
  if (bcc.length) message.bcc = bcc;
  if (req.replyTo) message.replyTo = req.replyTo;
  if (req.headers && Object.keys(req.headers).length) message.headers = req.headers;

  // env.EMAIL is the Cloudflare Email Sending binding (send_email in wrangler).
  // It throws an Error with a `.code` (E_* string) on failure; we let callers map it.
  const response = await env.EMAIL.send(message);
  return { messageId: response?.messageId };
}
