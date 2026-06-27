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
