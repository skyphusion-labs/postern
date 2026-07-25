// Wire types mirroring the Postern mailbox API (docs/CONTRACT.md section 4). The
// MCP server is a READ client of that API; these shapes are exactly what the
// JSON endpoints return (camelCase column names), so no remapping is needed.

// Durable-folder placement (worker MailboxPlacement, store.ts): null = the
// default placement (an ordinary inbox/sent row), so the absence of a folder
// is a real, distinct state, not "unknown".
export type MailboxPlacement = "archive" | "trash" | "junk" | null;
// The mailbox= query-param filter (worker MailboxFilter, store.ts): the same
// placements plus "all" (every placement, vs. omitted = mailbox IS NULL).
export type MailboxFilter = "archive" | "trash" | "junk" | "all";

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
  // Read/flag state (#419 sync): mirrors StoredMessageSummary.{seen,flagged,
  // answered} (inbound/src/store.ts) so an agent can ask for unread mail
  // without a per-message fetch.
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  // Durable folder placement (#419 sync): mirrors StoredMessageSummary.mailbox.
  mailbox: MailboxPlacement;
  // Soft-delete timestamp (Trash), null otherwise (#419 sync): mirrors
  // StoredMessageSummary.trashedAt.
  trashedAt: string | null;
  // The durable-folder IMAP UID, present only once a message has actually been
  // placed in a folder; null otherwise (#419 sync): mirrors
  // StoredMessageSummary.folderUid.
  folderUid: number | null;
  // Envelope fidelity (M8 #189, #419 sync): raw RFC 5322 headers as they
  // arrived (display names and all). All nullable: null on a pre-v2 row that
  // predates these columns. Mirrors StoredMessageSummary.{cc,bcc,sender,
  // replyTo}.
  cc: string | null;
  bcc: string | null;
  sender: string | null;
  replyTo: string | null;
  // Normalized envelope recipients (#419 sync): mirrors
  // StoredMessageSummary.deliveredTo.
  deliveredTo: string[];
  // Raw RFC822 byte size at intake, null on rows that predate the column
  // (#419 sync): mirrors StoredMessageSummary.wireSize.
  wireSize: number | null;
  // Cached IMAP projection length + the renderer version that produced it,
  // both null on rows that predate the projection cache (#419 sync): mirrors
  // StoredMessageSummary.{projectedSize,projectionVersion}.
  projectedSize: number | null;
  projectionVersion: number | null;
  attachmentCount: number;
  // True when the store holds a non-empty HTML body, without fetching the
  // body itself (#419 sync): mirrors StoredMessageSummary.hasHtml.
  hasHtml: boolean;
}

export interface AttachmentMeta {
  filename: string | null;
  mime: string | null;
  size: number;
}

// Message (a full read, GET /api/messages/{id}) is NOT a strict superset of
// MessageSummary: folderUid and hasHtml are list/search-summary conveniences
// that StoredMessage (store.ts) itself does not carry (the full body makes
// them redundant), so they are excluded here rather than falsely inherited.
export interface Message extends Omit<MessageSummary, "attachmentCount" | "folderUid" | "hasHtml"> {
  bodyText: string;
  // Original HTML body when the message had one, else null (#419 sync):
  // mirrors StoredMessage.bodyHtml (inbound/src/store.ts).
  bodyHtml: string | null;
  // Per-message auth results (SPF/DKIM/DMARC) as recorded at intake (#419
  // sync): mirrors StoredMessage.auth. `trusted` above is the worker's
  // derived summary judgment; this is the raw per-mechanism verdicts it was
  // derived from.
  auth: { spf: string; dkim: string; dmarc: string };
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
// Named viewer-relative view (worker #403 / CONTRACT 10.9). `direction` filters the
// stored wire fact; `lens` asks for a VIEW of one viewer's mail. Mutually exclusive,
// and a lens needs a viewer (to=) -- the worker refuses both violations.
export type ViewLens = "inbox" | "sent";

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
  /** replyAll derives the original To/Cc recipients server-side, excluding the
   *  sender; default "reply" (worker ReplyRequest.mode). */
  mode?: "reply" | "replyAll";
  /** Append a server-built quote of the original, from stored state
   *  (worker ReplyRequest.quoteOriginal). */
  quoteOriginal?: boolean;
  /** Same attachments shape as send (#363): base64 over JSON, worker-authoritative
   *  caps. Omitted -> the reply is byte-for-byte the no-attachment request. */
  attachments?: SendAttachmentInput[];
}
