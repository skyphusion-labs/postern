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

export type SearchMode = "fts" | "semantic" | "hybrid";
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

// What an agent may set on mailbox_send. A deliberate, safe subset of the worker's
// SendRequest (no raw headers, no attachments in v1.1): an agent composes a plain
// message; the worker owns From-enforcement, DKIM, threading, and the sent-copy store.
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
