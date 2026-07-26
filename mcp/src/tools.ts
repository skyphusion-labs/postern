// Tool registry. Each tool declares the scope it needs; registerTools registers
// only the tools whose scope the configured credentials satisfy. v1 ships READ
// tools (scope "read"). v1.1 adds SEND_TOOLS (mailbox_send / mailbox_reply, scope
// "send"); they register ONLY when a send-scoped token is configured -- the scope
// gate below already enforces this, no refactor.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PosternClient, PosternError } from "./client.js";
import type { SearchField, SearchMode } from "./types.js";

export type Scope = "read" | "send";

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ToolDef {
  name: string;
  scope: Scope;
  description: string;
  // A Zod raw shape (object of validators) -> the tool's JSON input schema.
  inputSchema: z.ZodRawShape;
  handler: (client: PosternClient, args: any) => Promise<unknown>;
}

function ok(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): TextResult {
  const msg = err instanceof PosternError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const DIRECTION = z.enum(["inbound", "outbound"]);
// A viewer-relative VIEW, as opposed to the stored wire fact `direction` filters
// (worker #403). inbox = mail delivered to the viewer that the viewer did not write
// (so a same-domain send from a colleague is in it); sent = mail the viewer wrote.
// Needs `to` as the viewer address, and cannot be combined with `direction`.
const LENS = z.enum(["inbox", "sent"]);
const MODE = z.enum(["fts", "substr", "semantic", "hybrid"]);
// Durable-folder scope (worker #352/#354, api.ts mailbox= param): "all" = every
// placement, archive|trash|junk = that placement only; omitted = the default
// (unfoldered) placement, unchanged.
const MAILBOX = z.enum(["archive", "trash", "junk", "all"]);
// How a reply picks its recipients (worker ReplyRequest.mode, mailbox.ts): 'reply' is
// the sender only, 'replyAll' derives the original To/Cc server-side from STORED state,
// excluding the sender. Named for the worker field, not the tool.
const REPLY_MODE = z.enum(["reply", "replyAll"]);
// Which column(s) the "substr" mode matches (worker /api/search field param);
// ignored by the other modes.
const FIELD = z.enum(["subject", "body", "text"]);
// A recipient field accepts one address or a list; the worker validates each
// against its address rule and enforces the recipient cap.
const ADDRESSES = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

// One outbound attachment: base64 content (required) + optional filename/mimeType.
// The worker owns the real limits (count, decoded size) and returns a clean error;
// we forward the shape and let it be the authority (no duplicated caps to drift).
const ATTACHMENT = z.object({
  content: z.string().min(1).describe("the file bytes as standard base64 (no line wrapping)"),
  filename: z.string().optional().describe("suggested filename, e.g. report.pdf"),
  mime_type: z.string().optional().describe("MIME type, e.g. application/pdf; the transport fills a default if omitted"),
});

// Cap on the bytes a single mailbox_get_attachment may return, so a large file
// cannot blow past the MCP client tool-result / context limits. Refused (never
// truncated) past this. Default 5 MiB; operators raise it via the env override up
// to the API own 25 MiB ceiling. Read per-call so a test/operator can vary it.
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export function maxAttachmentBytes(): number {
  const raw = (process.env.POSTERN_MCP_MAX_ATTACHMENT_BYTES ?? "").trim();
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_MAX_ATTACHMENT_BYTES;
}

// Map the tool snake_case attachment input to the worker SendAttachment shape
// (content + optional filename/mimeType). Returns undefined when there are none, so
// the send request stays byte-for-byte the no-attachment request.
function mapAttachments(
  input: { content: string; filename?: string; mime_type?: string }[] | undefined,
): { content: string; filename?: string; mimeType?: string }[] | undefined {
  if (!input || input.length === 0) return undefined;
  return input.map((x) => ({ content: x.content, filename: x.filename, mimeType: x.mime_type }));
}

export const READ_TOOLS: ToolDef[] = [
  {
    name: "mailbox_search",
    scope: "read",
    description:
      "Search the mailbox (subject + body) and return matching messages newest-first. " +
      "mode defaults to 'hybrid' (semantic + keyword). Optionally filter by direction " +
      "('inbound' = received, 'outbound' = what we sent) -- direction is the stored " +
      "fact, so an inbound filter never returns a sent copy. For one address's own " +
      "view pass to=<address> plus lens=inbox|sent. mode 'fts' is exact keyword " +
      "matching: every word must appear, so no match means no result (use it to prove " +
      "a message is NOT there). Also filter by sender (from), durable folder (mailbox), " +
      "date range (after/before, inclusive ISO), attachment presence (hasAttachment), " +
      "and read state (seen) -- e.g. seen=false plus mailbox=archive answers 'unread " +
      "mail in Archive'. This is the primary tool for finding mail by topic.",
    inputSchema: {
      query: z.string().min(1).describe("the search text"),
      mode: MODE.optional().describe("search mode; defaults to hybrid. substr is a literal substring match (use with field)"),
      field: FIELD.optional().describe("for mode substr only: which column to match (subject/body/text); ignored by other modes"),
      limit: z.number().int().positive().max(200).optional().describe("max results (default server-side ~50)"),
      direction: DIRECTION.optional().describe("filter on the STORED direction: received (inbound) or sent (outbound)"),
      to: z.string().optional().describe("viewer address: scope the search to one address's mail"),
      from: z.string().optional().describe("filter by sender address"),
      lens: LENS.optional().describe("viewer view (needs to=): inbox = delivered to them and not written by them; sent = written by them. Not combinable with direction"),
      mailbox: MAILBOX.optional().describe("filter by durable folder placement: archive, trash, junk, or all (every placement); omitted = the default unfoldered placement"),
      after: z.string().optional().describe("inclusive ISO date lower bound on the message date"),
      before: z.string().optional().describe("inclusive ISO date upper bound on the message date"),
      hasAttachment: z.boolean().optional().describe("true = only messages with >=1 attachment; false = only messages with none"),
      seen: z.boolean().optional().describe("filter on read state: true = seen, false = unread"),
      cursor: z.string().optional().describe("opaque pagination cursor from a previous page"),
    },
    handler: async (client, a) => {
      const mode: SearchMode = a.mode ?? "hybrid";
      const field: SearchField | undefined = a.field;
      const page = await client.search({
        q: a.query,
        mode,
        field,
        limit: a.limit,
        cursor: a.cursor,
        direction: a.direction,
        to: a.to,
        from: a.from,
        lens: a.lens,
        mailbox: a.mailbox,
        after: a.after,
        before: a.before,
        hasAttachment: a.hasAttachment,
        seen: a.seen,
      });
      return {
        query: a.query,
        mode,
        field: field ?? null,
        direction: a.direction ?? null,
        to: a.to ?? null,
        from: a.from ?? null,
        lens: a.lens ?? null,
        mailbox: a.mailbox ?? null,
        after: a.after ?? null,
        before: a.before ?? null,
        hasAttachment: a.hasAttachment ?? null,
        seen: a.seen ?? null,
        count: page.items.length,
        cursor: page.cursor,
        results: page.items,
      };
    },
  },
  {
    name: "mailbox_list",
    scope: "read",
    description:
      "List messages with optional filters (to, from, direction, thread, mailbox) " +
      "newest-first, paginated via cursor. `direction` is the STORED fact, so to=<addr> " +
      "with direction=inbound answers 'what actually ARRIVED for this address' and " +
      "never returns our own sent copy; to=<addr> alone returns everything delivered to " +
      "it, and to=<addr> with lens=inbox is that address's INBOX view (arrivals plus " +
      "same-domain mail others sent it). `mailbox` filters by durable folder (archive, " +
      "trash, junk, or all). Use mailbox_search for topic search; use this to browse or " +
      "filter by participant/folder.",
    inputSchema: {
      to: z.string().optional().describe("filter by recipient address"),
      from: z.string().optional().describe("filter by sender address"),
      direction: DIRECTION.optional().describe("filter on the STORED direction: inbound (received) or outbound (sent)"),
      lens: LENS.optional().describe("viewer view (needs to=): inbox = delivered to them and not written by them; sent = written by them. Not combinable with direction"),
      mailbox: MAILBOX.optional().describe("filter by durable folder placement: archive, trash, junk, or all (every placement); omitted = the default unfoldered placement"),
      thread: z.string().optional().describe("filter to a thread id"),
      limit: z.number().int().positive().max(200).optional().describe("max results (default ~50)"),
      cursor: z.string().optional().describe("opaque pagination cursor"),
    },
    handler: async (client, a) => {
      const page = await client.list({ to: a.to, from: a.from, direction: a.direction, lens: a.lens, mailbox: a.mailbox, thread: a.thread, limit: a.limit, cursor: a.cursor });
      return { count: page.items.length, cursor: page.cursor, messages: page.items };
    },
  },
  {
    name: "mailbox_get",
    scope: "read",
    description: "Fetch one full message (headers + body text + attachment metadata) by its message id.",
    inputSchema: {
      message_id: z.string().min(1).describe("the message id (as returned by search/list)"),
    },
    handler: async (client, a) => {
      const msg = await client.get(a.message_id);
      if (!msg) return { found: false, messageId: a.message_id };
      return { found: true, message: msg };
    },
  },
  {
    name: "mailbox_thread",
    scope: "read",
    description: "Fetch every message in a thread, ordered, by thread id (e.g. to read a full conversation).",
    inputSchema: {
      thread_id: z.string().min(1).describe("the thread id (as returned by search/list/get)"),
    },
    handler: async (client, a) => {
      const messages = await client.thread(a.thread_id);
      return { threadId: a.thread_id, count: messages.length, messages };
    },
  },
  {
    name: "mailbox_get_attachment",
    scope: "read",
    description:
      "Fetch the BYTES of one attachment on a message, returned as base64. Provide the " +
      "message id and the zero-based attachment index (from mailbox_get's attachment " +
      "metadata, in order). Returns filename, mimeType, size, and base64 content. Large " +
      "attachments are REFUSED with a clear error (never truncated); the cap is " +
      "POSTERN_MCP_MAX_ATTACHMENT_BYTES (default 5 MiB). Use mailbox_get first to see how " +
      "many attachments a message has and their names/sizes.",
    inputSchema: {
      message_id: z.string().min(1).describe("the message id (as returned by search/list/get)"),
      index: z.number().int().nonnegative().describe("zero-based attachment index (from mailbox_get's attachments array)"),
    },
    handler: async (client, a) => {
      const max = maxAttachmentBytes();
      // Read the message first for the TRUE filename + declared mime + size (the
      // bytes endpoint sanitizes the filename in its header). This also gives an
      // exact out-of-range error and lets us refuse an oversize file before any
      // download (cheap), keeping the byte fetch as a second, capped step.
      const msg = await client.get(a.message_id);
      if (!msg) return { found: false, messageId: a.message_id };
      const list = Array.isArray(msg.attachments) ? msg.attachments : [];
      const idx: number = a.index;
      if (idx < 0 || idx >= list.length) {
        throw new PosternError(
          `attachment index ${idx} out of range: message has ${list.length} attachment${list.length === 1 ? "" : "s"}`,
        );
      }
      const meta = list[idx];
      if (typeof meta.size === "number" && meta.size > max) {
        throw new PosternError(
          `attachment ${idx} is ${meta.size} bytes, over the ${max}-byte limit; raise POSTERN_MCP_MAX_ATTACHMENT_BYTES to fetch it`,
        );
      }
      const fetched = await client.getAttachmentBytes(a.message_id, idx, max);
      if (!fetched) return { found: false, messageId: a.message_id, index: idx };
      return {
        found: true,
        messageId: a.message_id,
        index: idx,
        filename: meta.filename ?? null,
        mimeType: meta.mime ?? fetched.contentType ?? null,
        size: fetched.size,
        encoding: "base64",
        content: fetched.base64,
      };
    },
  },
];

// v1.1 send tools (scope "send"). MUTATING: they actually send mail as the estate,
// so they register ONLY when a send-scoped token is configured (see index.ts). The
// worker owns From-enforcement, DKIM, threading, and storing the sent copy; these
// tools forward a composed message and return the core messageId + threadId.
export const SEND_TOOLS: ToolDef[] = [
  {
    name: "mailbox_send",
    scope: "send",
    description:
      "Send a NEW email from the mailbox. MUTATING: this actually delivers mail to the " +
      "recipients as the estate, so use it deliberately. Provide 'to', 'subject', and at " +
      "least one of 'text' or 'html'. The server enforces the allowed From domain, signs " +
      "(DKIM), threads, and stores the sent copy. Returns the new message id + thread id. " +
      "To answer an existing message, prefer mailbox_reply (it threads automatically).",
    inputSchema: {
      to: ADDRESSES.describe("recipient address, or a list of addresses"),
      subject: z.string().min(1).describe("the subject line"),
      text: z.string().optional().describe("plain-text body (provide text and/or html)"),
      html: z.string().optional().describe("HTML body (provide text and/or html)"),
      cc: ADDRESSES.optional().describe("cc address, or a list"),
      bcc: ADDRESSES.optional().describe("bcc address, or a list"),
      from: z.string().optional().describe("optional From override; must be on the allowed From domain, else the server rejects it"),
      reply_to: z.string().optional().describe("optional Reply-To address"),
      attachments: z.array(ATTACHMENT).optional().describe(
        "optional files to attach, each with base64 content (+ optional filename, mime_type). " +
        "The server caps the count and total size and rejects an oversize set with a clear error.",
      ),
    },
    handler: async (client, a) => {
      if (!a.text && !a.html) {
        throw new PosternError("provide at least one of 'text' or 'html'");
      }
      const result = await client.send({
        to: a.to,
        subject: a.subject,
        text: a.text,
        html: a.html,
        cc: a.cc,
        bcc: a.bcc,
        from: a.from,
        replyTo: a.reply_to,
        attachments: mapAttachments(a.attachments),
      });
      return { sent: true, messageId: result.messageId, threadId: result.threadId, providerMessageId: result.providerMessageId ?? null };
    },
  },
  {
    name: "mailbox_reply",
    scope: "send",
    description:
      "Reply to an existing stored message by its message id. MUTATING: this actually " +
      "delivers mail as the estate. Provide 'message_id' and at least one of 'text' or " +
      "'html'. The server pulls the referenced message and fills to / subject / " +
      "In-Reply-To / References / thread, so the reply lands in the same conversation. " +
      "Use mode 'replyAll' to include the original recipients, quote_original to append " +
      "the quoted original, and attachments exactly as mailbox_send takes them. " +
      "Returns the new message id + thread id (shared with the original).",
    inputSchema: {
      message_id: z.string().min(1).describe("the message id being replied to (as returned by search/list/get)"),
      text: z.string().optional().describe("plain-text body (provide text and/or html)"),
      html: z.string().optional().describe("HTML body (provide text and/or html)"),
      cc: ADDRESSES.optional().describe("cc address, or a list"),
      bcc: ADDRESSES.optional().describe("bcc address, or a list"),
      from: z.string().optional().describe("optional From override; must be on the allowed From domain, else the server rejects it"),
      mode: REPLY_MODE.optional().describe("'reply' (default, sender only) or 'replyAll' (the server derives the original To/Cc, excluding the sender)"),
      quote_original: z.boolean().optional().describe("append the server-built quote of the original message"),
      attachments: z.array(ATTACHMENT).optional().describe(
        "optional files to attach, each with base64 content (+ optional filename, mime_type). " +
        "The server caps the count and total size and rejects an oversize set with a clear error.",
      ),
    },
    handler: async (client, a) => {
      if (!a.text && !a.html) {
        throw new PosternError("provide at least one of 'text' or 'html'");
      }
      const result = await client.reply({
        messageId: a.message_id,
        text: a.text,
        html: a.html,
        cc: a.cc,
        bcc: a.bcc,
        from: a.from,
        mode: a.mode,
        quoteOriginal: a.quote_original,
        attachments: mapAttachments(a.attachments),
      });
      return { sent: true, messageId: result.messageId, threadId: result.threadId, providerMessageId: result.providerMessageId ?? null };
    },
  },
];

export function registerTools(
  server: McpServer,
  client: PosternClient,
  scopes: Set<Scope>,
  tools: ToolDef[] = READ_TOOLS,
): string[] {
  const registered: string[] = [];
  for (const t of tools) {
    if (!scopes.has(t.scope)) continue;
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      async (args: unknown) => {
        try {
          return ok(await t.handler(client, args)) as any;
        } catch (err) {
          return fail(err) as any;
        }
      },
    );
    registered.push(t.name);
  }
  return registered;
}
