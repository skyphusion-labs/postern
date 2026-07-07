// The mailbox send/reply API (docs/CONTRACT.md sections 3-4, issues #26/#27).
// send()/reply() are the write half of the one structured channel:
//   validate -> resolveFrom -> generate Message-ID -> dispatch() -> store.put(outbound)
// so the sent copy lands in the same store, threaded into the conversation. The
// validation (and the ReDoS-safe address regex) mirrors the standalone send
// worker; header construction is injection-safe (CRLF rejected) so a caller
// cannot smuggle extra headers.

import * as store from "./store";
import { htmlToText, cleanBody } from "./ingest";
import { selectTransport, type OutboundMessage, type OutboundAttachment } from "./transport/index";
import type { BoundIdentity } from "./sendidentity";

export interface EmailAddress {
  email: string;
  name?: string;
}

/**
 * One outbound attachment on a send (#70). `content` is standard base64 (no line
 * wrapping) over JSON, mirroring the inbound ParsedInbound attachment shape; the
 * selected transport decodes it to bytes. filename/mimeType are optional and the
 * transport fills sane defaults. Same shape the relay forwards from a real MUA.
 */
export type SendAttachment = OutboundAttachment;

export interface SendRequest {
  to: string | string[];
  from?: string | EmailAddress;
  replyTo?: string | EmailAddress;
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendAttachment[];
}

export interface ReplyRequest {
  /** message_id of the stored message being replied to. */
  messageId: string;
  html?: string;
  text?: string;
  /** Optional From override (must be on ALLOWED_FROM_DOMAIN); else DEFAULT_FROM. */
  from?: string | EmailAddress;
  cc?: string | string[];
  bcc?: string | string[];
}

export interface SendResult {
  messageId: string;
  threadId: string;
  providerMessageId?: string;
}

/** Thrown for caller-fixable problems; carries a stable code + HTTP status. */
export class MailboxError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "MailboxError";
    this.code = code;
    this.status = status;
  }
}

// Deliberately permissive address check; linear (no ReDoS): dot-free labels
// joined by literal dots, so no two adjacent quantifiers share a class.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const MAX_RECIPIENTS = 50;
// Attachment limits. CF Email Sending caps a whole message (body + attachments)
// near 25 MiB and throws E_CONTENT_TOO_LARGE past it; we reject early on the
// decoded attachment total so a caller gets a clean 413 instead of a provider
// error, and bound the count so a request cannot carry thousands of tiny parts.
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Defense in depth against header injection: any CR/LF in a single-line field
// could smuggle extra headers or split the message. Reject outright.
const CRLF_RE = /[\r\n]/;

function rejectCRLF(label: string, value: string): void {
  if (CRLF_RE.test(value)) {
    throw new MailboxError("E_VALIDATION_ERROR", `${label} must not contain line breaks`);
  }
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function validateRecipients(label: string, list: string[]): void {
  for (const addr of list) {
    if (typeof addr !== "string" || !EMAIL_RE.test(addr.trim())) {
      throw new MailboxError("E_VALIDATION_ERROR", `invalid ${label} address: ${addr}`);
    }
  }
}

// The number of bytes a base64 string decodes to. atob throws on non-base64
// input, which we surface as a clean validation error (never a 500). Standard
// base64 only (no line wrapping), matching the inbound ParsedInbound shape.
function base64ByteLength(b64: string): number {
  return atob(b64).length;
}

/**
 * Validate + normalize the attachments array (#70). Returns undefined when there
 * are none (so the no-attachment send path is byte-for-byte unchanged). Enforces
 * count, per-field CRLF safety, valid base64, and the decoded-size cap.
 */
function validateAttachments(input: unknown): OutboundAttachment[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new MailboxError("E_VALIDATION_ERROR", "attachments must be an array");
  }
  if (input.length === 0) return undefined;
  if (input.length > MAX_ATTACHMENTS) {
    throw new MailboxError("E_VALIDATION_ERROR", `too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  let totalBytes = 0;
  const out: OutboundAttachment[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MailboxError("E_VALIDATION_ERROR", `attachment ${i} must be an object`);
    }
    const a = raw as Record<string, unknown>;
    if (typeof a.content !== "string" || a.content === "") {
      throw new MailboxError("E_FIELD_MISSING", `attachment ${i} content (base64) is required`);
    }
    let byteLen: number;
    try {
      byteLen = base64ByteLength(a.content);
    } catch {
      throw new MailboxError("E_VALIDATION_ERROR", `attachment ${i} content is not valid base64`);
    }
    totalBytes += byteLen;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new MailboxError("E_PAYLOAD_TOO_LARGE", `attachments exceed ${MAX_ATTACHMENT_BYTES} bytes`, 413);
    }

    const att: OutboundAttachment = { content: a.content };
    if (a.filename !== undefined) {
      if (typeof a.filename !== "string") {
        throw new MailboxError("E_VALIDATION_ERROR", `attachment ${i} filename must be a string`);
      }
      rejectCRLF(`attachment ${i} filename`, a.filename);
      att.filename = a.filename;
    }
    if (a.mimeType !== undefined) {
      if (typeof a.mimeType !== "string") {
        throw new MailboxError("E_VALIDATION_ERROR", `attachment ${i} mimeType must be a string`);
      }
      rejectCRLF(`attachment ${i} mimeType`, a.mimeType);
      att.mimeType = a.mimeType;
    }
    out.push(att);
  }
  return out;
}

function resolveFrom(env: Env, from: SendRequest["from"], bound?: BoundIdentity): EmailAddress {
  // A per-identity send token binds the From AUTHORITATIVELY (#28): the token's
  // identity overrides any caller-supplied From, so a token cannot send as anyone
  // else. The bound address still flows through the SAME validation below (shape,
  // ALLOWED_FROM_DOMAIN, CRLF), so a misconfigured registry From fails loud, never
  // silently sends from a bad address.
  if (bound) {
    from = bound.displayName ? { email: bound.from, name: bound.displayName } : bound.from;
  }
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
    throw new MailboxError("E_VALIDATION_ERROR", `invalid from address: ${email}`);
  }
  const domain = email.split("@")[1].toLowerCase();
  if (domain !== allowedDomain) {
    throw new MailboxError("E_SENDER_NOT_ALLOWED", `from address must be on @${allowedDomain}`, 403);
  }
  if (name !== undefined) rejectCRLF("from name", name);
  return name ? { email, name } : { email };
}

function toAddress(v: string | EmailAddress | undefined): EmailAddress | undefined {
  if (v === undefined) return undefined;
  return typeof v === "string" ? { email: v } : v;
}

// The first bare address from a raw address-list header (Reply-To / From), for
// routing a reply (#189). A display name may legally contain a comma
// ("Doe, Jane" <jane@x>), so match an angle address against the WHOLE string
// first (section 10.1: never naively split), and only a bare, angle-less header
// falls back to the first comma-token. The result flows through
// validateRecipients like any address.
function firstAddress(raw: string): string {
  // [^<>] (not [^>]) so backtracking cannot rescan overlapping spans; the
  // Reply-To/From header is sender-controlled (same ReDoS shape as alert #26).
  const angle = raw.match(/<([^<>]+)>/);
  if (angle) return angle[1].trim();
  return (raw.split(",")[0] ?? "").trim();
}

// A Message-ID we generate for outbound mail so it dedups, threads, and stores
// like any received message. Domain taken from the From so it is well-formed.
function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  return `${crypto.randomUUID()}@${domain}`;
}

/** Body text we persist for the sent copy (FTS/threading), mirroring ingest. */
function deriveBodyText(html?: string, text?: string): string {
  const raw = text ?? htmlToText(html ?? "");
  return cleanBody(raw).slice(0, 32_000);
}

/**
 * Send a new message. validate -> resolveFrom -> Message-ID -> dispatch ->
 * store the sent copy (direction: outbound). Returns the stored messageId +
 * thread (a fresh thread unless headers carry In-Reply-To/References).
 */
export async function send(
  env: Env,
  req: SendRequest,
  ctx: ExecutionContext,
  identity?: BoundIdentity,
): Promise<SendResult> {
  if (!req || typeof req !== "object") {
    throw new MailboxError("E_VALIDATION_ERROR", "request body must be an object");
  }
  if (typeof req.subject !== "string" || req.subject.trim() === "") {
    throw new MailboxError("E_FIELD_MISSING", "subject is required");
  }
  rejectCRLF("subject", req.subject);
  if (!req.html && !req.text) {
    throw new MailboxError("E_FIELD_MISSING", "at least one of html or text is required");
  }

  const to = asArray(req.to);
  const cc = asArray(req.cc);
  const bcc = asArray(req.bcc);
  if (to.length === 0) {
    throw new MailboxError("E_FIELD_MISSING", "at least one to recipient is required");
  }
  validateRecipients("to", to);
  validateRecipients("cc", cc);
  validateRecipients("bcc", bcc);
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new MailboxError("E_TOO_MANY_RECIPIENTS", `combined to/cc/bcc exceeds ${MAX_RECIPIENTS}`);
  }

  const from = resolveFrom(env, req.from, identity);
  const attachments = validateAttachments(req.attachments);

  let replyTo: EmailAddress | undefined;
  if (req.replyTo !== undefined) {
    replyTo = toAddress(req.replyTo);
    const replyEmail = (replyTo?.email ?? "").trim();
    if (!EMAIL_RE.test(replyEmail)) {
      throw new MailboxError("E_VALIDATION_ERROR", `invalid replyTo address: ${replyEmail}`);
    }
    if (replyTo?.name !== undefined) rejectCRLF("replyTo name", replyTo.name);
  }

  const headers = validateHeaders(req.headers);

  return dispatchAndStore(env, ctx, {
    to,
    cc,
    bcc,
    from,
    replyTo,
    subject: req.subject,
    html: req.html,
    text: req.text,
    headers,
    attachments,
    inReplyTo: headers["In-Reply-To"] ?? null,
    references: parseReferences(headers["References"]),
  });
}

/**
 * Reply in-thread to a stored message. Pulls the referenced message, routes the
 * reply to its sender, inherits the subject (Re:), and sets In-Reply-To +
 * References so the provider and the store both thread it correctly. The sent
 * copy is stored with the same thread_id as the original (#27).
 */
export async function reply(
  env: Env,
  req: ReplyRequest,
  ctx: ExecutionContext,
  identity?: BoundIdentity,
): Promise<SendResult> {
  if (!req || typeof req !== "object" || typeof req.messageId !== "string" || !req.messageId.trim()) {
    throw new MailboxError("E_FIELD_MISSING", "messageId is required");
  }
  if (!req.html && !req.text) {
    throw new MailboxError("E_FIELD_MISSING", "at least one of html or text is required");
  }

  const original = await store.get(env, req.messageId.replace(/[<>]/g, "").trim());
  if (!original) {
    throw new MailboxError("E_NOT_FOUND", `no stored message with id ${req.messageId}`, 404);
  }

  // Route to the stored Reply-To when the original set one (RFC 5322 fidelity,
  // #189): list / role mail that sets Reply-To must not have replies mis-sent to
  // its From. Resolved from STORED state, never caller input. Extract the bare
  // address from the (possibly display-name-bearing, possibly multi-value) header.
  // (Reply-all is a post-v1 enhancement.)
  const to = [firstAddress(original.replyTo ?? original.from)];
  validateRecipients("to", to);
  const cc = asArray(req.cc);
  const bcc = asArray(req.bcc);
  validateRecipients("cc", cc);
  validateRecipients("bcc", bcc);
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new MailboxError("E_TOO_MANY_RECIPIENTS", `combined to/cc/bcc exceeds ${MAX_RECIPIENTS}`);
  }

  const from = resolveFrom(env, req.from, identity);
  const subject = original.subject.replace(/^\s*(re:\s*)+/i, "").trim();
  const replySubject = `Re: ${subject}`;
  rejectCRLF("subject", replySubject);

  // References = original's chain (if any) + the original's own id; In-Reply-To
  // = the original's id. We rebuild from stored state, not caller input, so a
  // reply cannot be pointed at an arbitrary thread.
  const inReplyTo = original.messageId;
  const references = buildReferences(original.inReplyTo, original.messageId);
  const headers: Record<string, string> = {
    "In-Reply-To": `<${inReplyTo}>`,
    References: references.map((r) => `<${r}>`).join(" "),
  };

  return dispatchAndStore(env, ctx, {
    to,
    cc,
    bcc,
    from,
    subject: replySubject,
    html: req.html,
    text: req.text,
    headers,
    inReplyTo,
    references,
    forcedThreadId: original.threadId,
  });
}

interface DispatchInput {
  to: string[];
  cc: string[];
  bcc: string[];
  from: EmailAddress;
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  attachments?: OutboundAttachment[];
  inReplyTo: string | null;
  references: string[];
  forcedThreadId?: string;
}

async function dispatchAndStore(env: Env, ctx: ExecutionContext, d: DispatchInput): Promise<SendResult> {
  const messageId = generateMessageId(d.from.email);
  const outbound: OutboundMessage = {
    messageId,
    to: d.to,
    from: d.from,
    subject: d.subject,
  };
  if (d.cc.length) outbound.cc = d.cc;
  if (d.bcc.length) outbound.bcc = d.bcc;
  if (d.replyTo) outbound.replyTo = d.replyTo;
  if (d.html) outbound.html = d.html;
  if (d.text) outbound.text = d.text;
  if (d.attachments && d.attachments.length) outbound.attachments = d.attachments;
  // Stamp our generated Message-ID so the provider, the recipient, and our store
  // all agree on the id we thread by.
  const headers: Record<string, string> = { ...d.headers, "Message-ID": `<${messageId}>` };
  outbound.headers = headers;

  const transport = selectTransport(env);
  const { providerMessageId } = await transport.dispatch(outbound);

  // Store the sent copy in the same store so the thread is complete (#27).
  const put = await store.put(
    env,
    {
      messageId,
      direction: "outbound",
      from: d.from.email,
      to: d.to.join(", "),
      subject: d.subject,
      date: new Date().toISOString(),
      inReplyTo: d.inReplyTo,
      references: d.references,
      bodyText: deriveBodyText(d.html, d.text),
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: true, // we sent it
      // Envelope fidelity v2 (#189): the sent copy carries the full recipient set
      // it was addressed to. delivered_to = to + cc + bcc, complete at insert (so
      // "mail involving X" views are complete for our own sent mail, incl. Bcc,
      // same privacy boundary as v1's stored body). cc_addr/bcc_addr = the joined
      // lists; reply_to_addr when set. sender_addr + wire_size stay NULL (we are
      // the author; CF builds the MIME, so there is no wire size to record).
      deliveredTo: [...d.to, ...d.cc, ...d.bcc].map((a) => a.toLowerCase()),
      cc: d.cc.length ? d.cc.join(", ") : null,
      bcc: d.bcc.length ? d.bcc.join(", ") : null,
      replyTo: d.replyTo ? (d.replyTo.name ? `${d.replyTo.name} <${d.replyTo.email}>` : d.replyTo.email) : null,
      // Index outbound mail + replies into the semantic store (#116 ws2): our own
      // sends carry status / decisions / answers, so a query like "what's the
      // status of the RunPod API fix?" must be able to find the reply WE wrote.
      // Outbound is always our own mail = always crew-relevant, so index it
      // unconditionally (no VECTORIZE_FOR allowlist gate, unlike inbound).
      vectorize: true,
    },
    ctx,
  );

  // A reply must land in the original's thread even if the parent row is the
  // very first message (its thread_id == its own id, which resolveThreadId also
  // returns). forcedThreadId is asserted only as a safety net for the reply path.
  const threadId = d.forcedThreadId ?? put.threadId;
  return { messageId, threadId, providerMessageId };
}

function validateHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new MailboxError("E_VALIDATION_ERROR", "headers must be an object");
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw new MailboxError("E_VALIDATION_ERROR", `header ${key} must be a string`);
    }
    rejectCRLF(`header ${key}`, key);
    rejectCRLF(`header ${key}`, value);
  }
  return { ...headers };
}

function parseReferences(refs: string | undefined): string[] {
  if (!refs) return [];
  return refs
    .split(/\s+/)
    .map((r) => r.replace(/[<>]/g, "").trim())
    .filter(Boolean);
}

// References for a reply: the parent's own chain head (if it was itself a reply)
// plus the parent id, deduped, parent id last (closest).
function buildReferences(parentInReplyTo: string | null, parentId: string): string[] {
  const out: string[] = [];
  if (parentInReplyTo) {
    const p = parentInReplyTo.replace(/[<>]/g, "").trim();
    if (p) out.push(p);
  }
  if (!out.includes(parentId)) out.push(parentId);
  return out;
}
