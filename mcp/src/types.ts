// Wire types mirroring the Postern mailbox API (docs/CONTRACT.md section 4). The
// MCP server is a READ client of that API; these shapes are exactly what the
// JSON endpoints return (camelCase column names), so no remapping is needed.

export interface MessageSummary {
  // Monotonic, arrival-ordered insertion key (store #103). Stable; > 0.
  uid?: number;
  messageId: string;
  direction: "inbound" | "outbound";
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  inReplyTo: string | null;
  trusted: boolean;
  receivedAt: string;
  attachmentCount: number;
}

export interface AttachmentMeta {
  filename: string | null;
  mime: string | null;
  size: number;
}

export interface Message extends Omit<MessageSummary, "attachmentCount"> {
  bodyText: string;
  attachments: AttachmentMeta[];
}

export interface SearchHit {
  message: MessageSummary;
  score?: number;
  snippet?: string;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export type SearchMode = "fts" | "substr" | "semantic" | "hybrid";
// Which column(s) the substring mode matches (worker /api/search field param,
// api.ts:206). Only meaningful for mode "substr"; ignored by the other modes.
export type SearchField = "subject" | "body" | "text";
export type Direction = "inbound" | "outbound";

// Result of a send/reply (POST /api/send, POST /api/reply). The worker wraps it
// as `{ ok: true, ...SendResult }`; the client unwraps to this. threadId is the
// thread the sent copy joined; providerMessageId is best-effort (provider/transport
// dependent), so a caller threads/stores on the core messageId, never on it.
export interface SendResult {
  messageId: string;
  threadId: string;
  providerMessageId?: string;
}

// One outbound attachment on a send. content is standard base64 (no line wrapping)
// over JSON, exactly the worker SendAttachment shape (mailbox.ts:19-25); filename
// and mimeType are optional and the transport fills sane defaults. The worker caps
// count (20) and decoded total (25 MiB) and rejects oversize with a clean 413.
export interface SendAttachmentInput {
  content: string;
  filename?: string;
  mimeType?: string;
}

// What an agent may set on mailbox_send. A deliberate, safe subset of the worker's
// SendRequest (no raw headers): an agent composes a plain message with optional
// attachments; the worker owns From-enforcement, DKIM, threading, and the sent-copy
// store, and validates attachments (count, base64, size).
export interface SendInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  // Optional From override; the worker rejects any From outside ALLOWED_FROM_DOMAIN.
  from?: string;
  replyTo?: string;
  // Optional attachments (base64 over JSON). Omitted -> the send is byte-for-byte
  // the no-attachment request, unchanged.
  attachments?: SendAttachmentInput[];
}

// What an agent may set on mailbox_reply. The worker pulls the referenced stored
// message and fills to / subject / In-Reply-To / References / thread itself.
export interface ReplyInput {
  messageId: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
}
