// Tool registry. Each tool declares the scope it needs; registerTools registers
// only the tools whose scope the configured credentials satisfy. v1 ships READ
// tools (scope "read"). v1.1 adds SEND_TOOLS (mailbox_send / mailbox_reply, scope
// "send"); they register ONLY when a send-scoped token is configured -- the scope
// gate below already enforces this, no refactor.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PosternClient, PosternError } from "./client.js";
import type { DraftInput, FlagSet, MailboxPlacement, SearchField, SearchMode } from "./types.js";

// Repeated verbatim in every draft tool description on purpose. An agent reads ONE
// tool description, never the set, so the identity requirement has to be in each of
// them or it is effectively in none: a caller holding a static operator token needs to
// know why it was refused at the moment it reads the tool it is about to call.
const DRAFT_NOTE =
  "Server-side drafts are IDENTITY-OWNED: the owner comes from the token, never from an " +
  "argument, so a static operator token is refused with E_IDENTITY_REQUIRED and the tool " +
  "says so rather than returning an empty result. ";

export type Scope = "read" | "send" | "organize";

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ToolDef {
  name: string;
  scope: Scope;
  description: string;
  // A Zod raw shape (object of validators) -> the tool's JSON input schema.
  //
  // `Record<string, z.ZodType>` and not `z.ZodRawShape`: in zod 4 the raw-shape alias
  // types its values as the CORE `$ZodType`, which carries no `.parse`, while every value
  // in the literals below is a classic `z.ZodType` that does. The looser alias threw the
  // information away, so a test asserting on a declared validator (`inputSchema.lens.parse`)
  // could not type-check even though the object genuinely holds one. `z.object()` accepts
  // this, because a classic ZodType IS a $ZodType.
  inputSchema: Record<string, z.ZodType>;
  handler: (client: PosternClient, args: any) => Promise<unknown>;
}

function ok(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): TextResult {
  const msg = err instanceof PosternError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

/** Tool arguments (snake_case, the MCP convention here) to the client's DraftInput
 *  (camelCase, the worker's wire names). Only keys the caller actually supplied are
 *  carried, because the worker reads an absent key as a CLEARED field: mapping an
 *  unsupplied argument to undefined and then sending it would blank a field nobody
 *  mentioned. `draft_id` and `updated_at` are addressing and concurrency, not content,
 *  so they are deliberately not part of this. */
function draftInputFrom(a: any): DraftInput {
  const out: DraftInput = {};
  if (a.to !== undefined) out.to = a.to;
  if (a.cc !== undefined) out.cc = a.cc;
  if (a.bcc !== undefined) out.bcc = a.bcc;
  if (a.subject !== undefined) out.subject = a.subject;
  if (a.body_text !== undefined) out.bodyText = a.body_text;
  if (a.body_html !== undefined) out.bodyHtml = a.body_html;
  if (a.in_reply_to !== undefined) out.inReplyTo = a.in_reply_to;
  if (a.thread_id !== undefined) out.threadId = a.thread_id;
  if (a.compose_mode !== undefined) out.composeMode = a.compose_mode;
  if (a.source_message_id !== undefined) out.sourceMessageId = a.source_message_id;
  return out;
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
// How a draft was composed (worker draftMode, api.ts). reply/replyAll/forward each need a
// source_message_id; the worker refuses an unknown value rather than defaulting it.
const DRAFT_MODE = z.enum(["new", "reply", "replyAll", "forward"]);
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

/**
 * The completeness and scope fields every read tool result carries.
 *
 * `count` is kept (it is this page's length, and callers depend on it) but it is no longer the
 * only thing an agent can read: `count: 2` sitting next to an implied exhaustion is exactly how
 * "two results" gets read as "two exist". `complete` answers the question `count` never could,
 * and `identityScope` answers the other half, whose mail the answer even covers.
 *
 * Absent fields mean the old, unambiguous case: a keyset-paginated answer whose cursor chain is
 * the whole set. Nothing is invented here; every field is passed through from the worker or
 * omitted.
 */
function completeness(page: {
  cursor?: string | null;
  complete?: boolean;
  retrievalCap?: number;
  degraded?: string;
  identityScope?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `cursor` is reported only when the worker actually sent one. An absent cursor means "no
  // continuation exists AND this is not exhaustive", which is not null and must not become it.
  if (page.cursor !== undefined) out.cursor = page.cursor;
  if (page.complete !== undefined) out.complete = page.complete;
  if (page.retrievalCap !== undefined) out.retrievalCap = page.retrievalCap;
  if (page.degraded !== undefined) out.degraded = page.degraded;
  if (page.identityScope !== undefined) out.identityScope = page.identityScope;
  return out;
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
      "mail in Archive'. seenFor names whose read state seen/results render, for a " +
      "shared address (e.g. a role queue) with no single reader of its own. This is " +
      "the primary tool for finding mail by topic. READING THE RESULT: `count` is the " +
      "size of THIS page, never a total. `complete: false` means messages matched that " +
      "are NOT in this response, so the result CANNOT prove absence -- `retrievalCap` " +
      "and `degraded` say why, and the score-ranked modes (semantic, hybrid) have no " +
      "cursor to resume from, so raise limit or narrow the query instead. To prove a " +
      "message is NOT there, use mode 'fts', which is exhaustively paginated. " +
      "`identityScope` states whose mail was searched: kind 'member' or 'role' means " +
      "you were shown a SLICE, so a zero result means 'not in your slice', not 'not in " +
      "the estate'.",
    inputSchema: {
      query: z.string().min(1).describe("the search text"),
      mode: MODE.optional().describe("search mode; defaults to hybrid. substr is a literal substring match (use with field)"),
      field: FIELD.optional().describe("for mode substr ONLY: which column to match (subject/body/text). "
        + "REFUSED, not ignored, in any other mode: pass mode=substr or remove field"),
      limit: z.number().int().positive().max(200).optional().describe("max results (default server-side ~50)"),
      direction: DIRECTION.optional().describe("filter on the STORED direction: received (inbound) or sent (outbound)"),
      to: z.string().optional().describe("viewer address: scope the search to one address's mail"),
      from: z.string().optional().describe("filter by sender address"),
      lens: LENS.optional().describe("viewer view (needs to=): inbox = delivered to them and not written by them; sent = written by them. Not combinable with direction"),
      mailbox: MAILBOX.optional().describe("filter by durable folder placement: archive, trash, junk, or all (every placement); omitted = the default unfoldered placement"),
      after: z.string().optional().describe("INCLUSIVE lower bound on the message date: ISO-8601, either a bare date "
        + "(2026-01-31, meaning from 00:00:00 that day) or a full timestamp "
        + "(2026-01-31T12:00:00Z). A bogus value is REFUSED, never silently ignored."),
      before: z.string().optional().describe("INCLUSIVE upper bound on the message date: ISO-8601, either a bare date "
        + "(2026-01-31, which covers that WHOLE day through 23:59:59.999) or a full "
        + "timestamp. Both ends are inclusive. A bogus value is REFUSED, never silently ignored."),
      hasAttachment: z.boolean().optional().describe("true = only messages with >=1 attachment; false = only messages with none"),
      seen: z.boolean().optional().describe("filter on read state: true = seen, false = unread"),
      seenFor: z.string().optional().describe(
        "whose read state seen/results render (the message rows returned are unchanged): " +
          "an address whose message_seen_by row to project. For a shared/role address " +
          "with no reader of its own (e.g. to=abuse@ with lens=inbox), pass the human " +
          "reading it, e.g. seenFor=ada@example.com",
      ),
      cursor: z.string().optional().describe("opaque pagination cursor from a previous page"),
      fields: z.array(z.string().min(1)).optional().describe(
        // Deliberately spelled out against its SINGULAR neighbour above: an agent that
        // conflates `field` with `fields` is the predictable failure of this pair, so
        // each description names the other rather than describing itself in isolation.
        "NOT the same as `field` (singular, above), which picks the COLUMN substr matches. "
          + "RESPONSE PROJECTION: return ONLY these summary keys per message, instead of all 27. "
          + "This is what makes a wide survey fit: a 100-message page is ~64k characters "
          + "full, ~17k as fields=[\"uid\",\"date\",\"from\",\"subject\"] -- use that to ask "
          + "'who wrote to this mailbox this month' and only then fetch the bodies you want. "
          + "It does NOT change WHICH messages come back. An unknown name is REFUSED (never "
          + "silently dropped), and the error lists every accepted one. Valid names are the "
          + "summary keys: uid, messageId, direction, threadId, from, to, subject, date, "
          + "inReplyTo, trusted, receivedAt, seen, flagged, answered, mailbox, trashedAt, "
          + "folderUid, cc, bcc, sender, replyTo, deliveredTo, wireSize, projectedSize, "
          + "projectionVersion, attachmentCount, hasHtml.",
      ),
    },
    handler: async (client, a) => {
      const mode: SearchMode = a.mode ?? "hybrid";
      const field: SearchField | undefined = a.field;
      // `field` picks the COLUMN the substring match runs against, and only the substr
      // mode has such a column. Supplying it in any other mode is REFUSED here rather
      // than forwarded and dropped (#651, from #632 F12).
      //
      // Refusal, not a quieter echo, because this is the accepted-and-ignored class that
      // #632 F1 already closed for unknown keys, and registerTools states the rule: a
      // supplied filter that is silently dropped is worse than one that is rejected,
      // because the caller reasonably believes it applied. The old code forwarded nothing
      // (client.search omits it for the other modes) and then echoed `field: field ?? null`
      // regardless, so `mode: hybrid, field: subject` answered with `field: "subject"`,
      // which reads as confirmation that the search WAS restricted to subjects.
      //
      // It is refused BEFORE the request, so no unrestricted search runs under a name the
      // caller would misread. `mode` defaults to hybrid, so `{ query, field }` with no
      // mode at all is the likeliest way in, and it is refused too.
      if (field !== undefined && mode !== "substr") {
        throw new PosternError(
          `field selects the column for mode substr and mode is "${mode}": ` +
            "pass mode=substr to match one column, or remove field",
        );
      }
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
        seenFor: a.seenFor,
        fields: a.fields,
      });
      return {
        query: a.query,
        mode,
        // Present ONLY in the mode that honors it, so the key's PRESENCE carries
        // information and a caller can tell three states apart: a named column
        // (`field: "subject"`), substr with no column named (`field: null`), and a mode
        // where the parameter does not exist (no key at all). A `null` in a non-substr
        // answer would be a fourth, false reading: "understood, unrestricted".
        ...(mode === "substr" ? { field: field ?? null } : {}),
        direction: a.direction ?? null,
        to: a.to ?? null,
        from: a.from ?? null,
        lens: a.lens ?? null,
        mailbox: a.mailbox ?? null,
        after: a.after ?? null,
        before: a.before ?? null,
        hasAttachment: a.hasAttachment ?? null,
        seen: a.seen ?? null,
        seenFor: a.seenFor ?? null,
        // Echo the projection that was APPLIED, so a reader of this result can tell a
        // four-key row from a message that genuinely has nothing else stored.
        fields: a.fields ?? null,
        count: page.items.length,
        ...completeness(page),
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
      "filter by participant/folder. seenFor names whose read state the seen field " +
      "renders, for a shared address (e.g. a role queue) with no single reader of its own. " +
      "READING THE RESULT: `count` is the size of THIS page, never a total; follow `cursor` " +
      "to page, where `cursor: null` means there are genuinely no more. To SURVEY a wide " +
      "window without drowning in envelope metadata, pass fields=[\"uid\",\"date\",\"from\",\"subject\"]; " +
      "the rows come back with only those keys and the id set is unchanged. `identityScope` " +
      "states whose mail was listed: kind 'member' or 'role' means you were shown a SLICE, " +
      "so an empty result means 'not in your slice', not 'not in the estate'. This tool " +
      "filters by date with after/before (INCLUSIVE at both ends), so a window can be " +
      "enumerated exhaustively here rather than through the relevance-ranked search path -- " +
      "which matters because a ranked search cannot prove a message is absent, and this can.",
    inputSchema: {
      to: z.string().optional().describe("filter by recipient address"),
      from: z.string().optional().describe("filter by sender address"),
      direction: DIRECTION.optional().describe("filter on the STORED direction: inbound (received) or outbound (sent)"),
      lens: LENS.optional().describe("viewer view (needs to=): inbox = delivered to them and not written by them; sent = written by them. Not combinable with direction"),
      mailbox: MAILBOX.optional().describe("filter by durable folder placement: archive, trash, junk, or all (every placement); omitted = the default unfoldered placement"),
      thread: z.string().optional().describe("filter to a thread id"),
      q: z
        .string()
        .optional()
        .describe(
          "keyword filter over subject + body (exact FTS: every word must appear). Narrows the " +
            "listing in place; use mailbox_search for ranked topic search",
        ),
      limit: z.number().int().positive().max(200).optional().describe("max results (default ~50)"),
      cursor: z.string().optional().describe("opaque pagination cursor"),
      seenFor: z.string().optional().describe(
        "whose read state the seen field renders (the message rows returned are " +
          "unchanged): an address whose message_seen_by row to project. For a " +
          "shared/role address with no reader of its own (e.g. to=abuse@ with " +
          "lens=inbox), pass the human reading it, e.g. seenFor=ada@example.com",
      ),
      after: z.string().optional().describe("INCLUSIVE lower bound on the message date: ISO-8601, either a bare date "
        + "(2026-01-31, meaning from 00:00:00 that day) or a full timestamp "
        + "(2026-01-31T12:00:00Z). A bogus value is REFUSED, never silently ignored."),
      before: z.string().optional().describe("INCLUSIVE upper bound on the message date: ISO-8601, either a bare date "
        + "(2026-01-31, which covers that WHOLE day through 23:59:59.999) or a full "
        + "timestamp. Both ends are inclusive. A bogus value is REFUSED, never silently ignored."),
      fields: z.array(z.string().min(1)).optional().describe(
        "RESPONSE PROJECTION: return ONLY these summary keys per message, instead of all 27. "
          + "This is what makes a wide survey fit: a 100-message page is ~64k characters "
          + "full, ~17k as fields=[\"uid\",\"date\",\"from\",\"subject\"] -- use that to ask "
          + "'who wrote to this mailbox this month' and only then fetch the bodies you want. "
          + "It does NOT change WHICH messages come back. An unknown name is REFUSED (never "
          + "silently dropped), and the error lists every accepted one. Valid names are the "
          + "summary keys: uid, messageId, direction, threadId, from, to, subject, date, "
          + "inReplyTo, trusted, receivedAt, seen, flagged, answered, mailbox, trashedAt, "
          + "folderUid, cc, bcc, sender, replyTo, deliveredTo, wireSize, projectedSize, "
          + "projectionVersion, attachmentCount, hasHtml.",
      ),
    },
    handler: async (client, a) => {
      const page = await client.list({ to: a.to, from: a.from, direction: a.direction, lens: a.lens, mailbox: a.mailbox, thread: a.thread, q: a.q, limit: a.limit, cursor: a.cursor, seenFor: a.seenFor, fields: a.fields, after: a.after, before: a.before });
      return {
        count: page.items.length,
        ...completeness(page),
        seenFor: a.seenFor ?? null,
        // See mailbox_search: the applied projection is echoed so a narrow row is
        // distinguishable from a sparse message.
        fields: a.fields ?? null,
        // The applied window, echoed for the same reason: an empty page inside a window is a
        // different fact from an empty mailbox, and the caller should not have to remember
        // what it asked for to tell them apart.
        after: a.after ?? null,
        before: a.before ?? null,
        messages: page.items,
      };
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
  {
    name: "mailbox_folders",
    scope: "read",
    description:
      "List the mailbox folders with a message count and an unread count for each, plus any " +
      "shared role queues the caller may read. Use this to orient BEFORE paging messages: it " +
      "answers 'where is there mail and how much' in one call, which mailbox_list cannot. " +
      "The counts are computed server-side with the same predicates a read uses, so they " +
      "agree with what mailbox_list would return for the same folder. An entry carrying a " +
      "'role' field is a shared QUEUE, not a personal folder; its presence is the signal, so " +
      "never parse the id to decide. Under an identity-bound token the server scopes the " +
      "counts to that identity and ignores 'to'.",
    inputSchema: {
      to: z
        .string()
        .optional()
        .describe("scope the unread counts to this address; ignored when the token is identity-bound"),
    },
    handler: async (client, a) => {
      const folders = await client.folders({ to: a.to });
      return { count: folders.length, folders };
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
  // --- server-side drafts ---
  //
  // These carry scope "send" because that is the scope the worker's route table demands,
  // and only mailbox_draft_send actually delivers anything. The rest compose. They need
  // MORE than the scope, though: the routes are identity-owned, so a static operator
  // token holding `send` still gets E_IDENTITY_REQUIRED (403) on every one of them. Each
  // description says so, because an agent that cannot tell "refused" from "empty" will
  // report the wrong thing to its user.
  {
    name: "mailbox_drafts_list",
    scope: "send",
    description:
      "List the caller's own saved drafts. " + DRAFT_NOTE +
      "Each draft carries an 'updatedAt' which mailbox_draft_update REQUIRES, so list or get " +
      "first and keep that value.",
    inputSchema: {},
    handler: async (client) => {
      const drafts = await client.listDrafts();
      return { count: drafts.length, drafts };
    },
  },
  {
    name: "mailbox_draft_get",
    scope: "send",
    description:
      "Fetch one of the caller's own drafts by id, including the 'updatedAt' that an update " +
      "must echo back. " + DRAFT_NOTE +
      "A draft that does not exist and one owned by another identity are the SAME answer " +
      "(found: false), deliberately, so this cannot be used to probe for other identities.",
    inputSchema: {
      draft_id: z.string().min(1).describe("the draft id (from mailbox_drafts_list or a create)"),
    },
    handler: async (client, a) => {
      const draft = await client.getDraft(a.draft_id);
      if (!draft) return { found: false, draftId: a.draft_id };
      return { found: true, draft };
    },
  },
  {
    name: "mailbox_draft_create",
    scope: "send",
    description:
      "Create a new server-side draft. This does NOT send anything; use mailbox_draft_send " +
      "when it is ready. " + DRAFT_NOTE +
      "Returns the new draft including its id and 'updatedAt'. Set 'compose_mode' to reply, " +
      "replyAll or forward together with 'source_message_id' to make the eventual send thread " +
      "against an existing message; the default is a fresh message.",
    inputSchema: {
      to: z.string().optional().describe("recipient(s), comma or newline separated as the user typed them"),
      cc: z.string().optional().describe("cc recipient(s), same format as to"),
      bcc: z.string().optional().describe("bcc recipient(s), same format as to"),
      subject: z.string().optional().describe("the subject line"),
      body_text: z.string().optional().describe("plain-text body"),
      body_html: z.string().optional().describe("HTML body"),
      in_reply_to: z.string().optional().describe("the Message-ID this draft answers"),
      thread_id: z.string().optional().describe("the thread this draft belongs to"),
      compose_mode: DRAFT_MODE.optional().describe("new (default), reply, replyAll or forward; the last three need source_message_id"),
      source_message_id: z.string().optional().describe("the stored message a reply/replyAll/forward is built from"),
    },
    handler: async (client, a) => {
      const draft = await client.createDraft(draftInputFrom(a));
      return { created: true, draft };
    },
  },
  {
    name: "mailbox_draft_update",
    scope: "send",
    description:
      "Update one of the caller's own drafts. " + DRAFT_NOTE +
      "This is a READ-MODIFY-WRITE: pass 'updated_at' exactly as the last read returned it. " +
      "A stale or missing value is refused with E_CONFLICT instead of overwriting a " +
      "concurrent edit, and the answer to that refusal is to read the draft again and retry " +
      "with its current 'updated_at'. Any field you OMIT is CLEARED, so send the whole draft " +
      "as you want it to end up, not just the part you changed.",
    inputSchema: {
      draft_id: z.string().min(1).describe("the draft id to update"),
      updated_at: z.string().min(1).describe("the draft's current updatedAt, from mailbox_draft_get or a previous write"),
      to: z.string().optional().describe("recipient(s), comma or newline separated"),
      cc: z.string().optional().describe("cc recipient(s)"),
      bcc: z.string().optional().describe("bcc recipient(s)"),
      subject: z.string().optional().describe("the subject line"),
      body_text: z.string().optional().describe("plain-text body"),
      body_html: z.string().optional().describe("HTML body"),
      in_reply_to: z.string().optional().describe("the Message-ID this draft answers"),
      thread_id: z.string().optional().describe("the thread this draft belongs to"),
      compose_mode: DRAFT_MODE.optional().describe("new, reply, replyAll or forward"),
      source_message_id: z.string().optional().describe("the stored message a reply/replyAll/forward is built from"),
    },
    handler: async (client, a) => {
      const draft = await client.updateDraft(a.draft_id, draftInputFrom(a), a.updated_at);
      return { updated: true, draft };
    },
  },
  {
    name: "mailbox_draft_delete",
    scope: "send",
    description:
      "Delete one of the caller's own drafts, discarding it. " + DRAFT_NOTE +
      "Reports deleted: false when there was nothing to delete, which is not an error.",
    inputSchema: {
      draft_id: z.string().min(1).describe("the draft id to discard"),
    },
    handler: async (client, a) => {
      const deleted = await client.deleteDraft(a.draft_id);
      return { deleted, draftId: a.draft_id };
    },
  },
  {
    name: "mailbox_draft_send",
    scope: "send",
    description:
      "Send one of the caller's own drafts. MUTATING: this actually delivers mail to the " +
      "recipients, so use it deliberately, and read the draft back first if you did not just " +
      "write it. " + DRAFT_NOTE +
      "The server dispatches, stores the sent copy, and only THEN discards the draft, so a " +
      "failure leaves the draft intact and retryable rather than half-sent. A reply or " +
      "forward draft threads against its source message automatically. Returns the sent " +
      "message id and thread id.",
    inputSchema: {
      draft_id: z.string().min(1).describe("the draft id to send"),
    },
    handler: async (client, a) => {
      const result = await client.sendDraft(a.draft_id);
      return {
        sent: true,
        draftId: a.draft_id,
        messageId: result.messageId,
        threadId: result.threadId,
        providerMessageId: result.providerMessageId ?? null,
      };
    },
  },
];

// v1.2 organize tools (scope "organize"). MUTATING, but only over the mailbox's OWN
// view of its mail: read state, flags, and which folder a message sits in. Nothing here
// sends or deletes anything.
//
// They register ONLY when an organize-capable credential is configured (see index.ts),
// for the reason the send tools do: a tool that is advertised and always 403s is worse
// than an absent tool, because an agent cannot tell a missing grant from a broken route.
//
// ONE THING EVERY DESCRIPTION HERE MUST SAY, and it is the whole of #645's warning. The
// routes answer `{ updated }`, a COUNT. An agent that names five ids and reads
// `updated: 3` cannot tell WHICH two were skipped, and no amount of wording in a result
// can recover that. So each tool reports the count verbatim beside the `requested` size
// and the `unchanged` difference, and says in its description what a short count means
// and how to find out which ids it was. None of them echoes the id list back, because an
// echoed list sitting next to a short count reads as the list that landed.
const COUNT_NOTE =
  "COUNTS, NOT PER-ID RESULTS: the answer is `updated` (how many stored messages the " +
  "server matched), `requested` (how many ids you sent), and `unchanged` (the " +
  "difference). The server counts every message row it reached, so re-applying a value " +
  "a message already had still counts. `unchanged` above 0 therefore means some ids are " +
  "unknown to the store or outside what your token may reach, and THIS ANSWER CANNOT " +
  "SAY WHICH ONES, so do not treat your id list as the list that landed; re-read those " +
  "ids with mailbox_list or mailbox_get to see their real state. Duplicate ids in one " +
  "call also count toward `unchanged`. ";

/**
 * The organize credential, or "" when the operator granted none.
 *
 * Pure, exported, and given its own function for one reason: the registration decision
 * IS the #645 requirement ("do not advertise a tool that always 403s"), and in index.ts
 * it would sit inside `main()`, which cannot be imported without starting a server. A
 * guard that no test can watch fail is decoration, so the decision lives here where a
 * test drives it directly and index.ts only obeys it.
 *
 * Two slots, the same shape the send tools use:
 *   POSTERN_ORGANIZE_TOKEN  -- a credential of its own (preferred: per-function keys).
 *   POSTERN_MCP_ORGANIZE=1  -- reuse POSTERN_API_TOKEN, for the single registry token
 *                              that already carries organize alongside read.
 *
 * Whitespace-only is UNSET, not a token: a blank env var is how a half-finished config
 * reaches production, and a blank Bearer would 401 at the worker with nothing to read.
 * The literal "1" is required for the reuse flag rather than any truthy string, so a
 * POSTERN_MCP_ORGANIZE=0 meant as "off" is not read as "on".
 */
export function organizeTokenFrom(
  env: Record<string, string | undefined>,
  primaryToken: string,
): string {
  const own = (env.POSTERN_ORGANIZE_TOKEN ?? "").trim();
  if (own) return own;
  if ((env.POSTERN_MCP_ORGANIZE ?? "").trim() === "1") return primaryToken.trim();
  return "";
}

export const ORGANIZE_TOOLS: ToolDef[] = [
  {
    name: "mailbox_mark_seen",
    scope: "organize",
    description:
      "Mark stored messages read or unread. MUTATING: this changes what the mailbox " +
      "looks like to its readers (it is the same write the IMAP \\Seen flag and a " +
      "webmail 'mark read' perform), but it neither sends nor deletes anything. " +
      "Pass the message ids and seen=true (read) or seen=false (unread). " +
      COUNT_NOTE +
      "By default this sets the mailbox-wide read state. Pass for_recipient to record " +
      "the state for ONE person instead, which is what a shared or role address needs " +
      "so two readers do not inherit each other's unread counts. A token bound to an " +
      "identity may only write its OWN state: the server REFUSES a for_recipient that " +
      "disagrees with the token rather than quietly rewriting it, and it binds the write " +
      "to that identity even when for_recipient is omitted. That is why the result does " +
      "not echo for_recipient back: under a bound token the server, not your argument, " +
      "decides whose state was written.",
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).describe("the message ids to mark (as returned by search/list/get)"),
      seen: z.boolean().describe("true = mark read, false = mark unread"),
      for_recipient: z
        .string()
        .optional()
        .describe(
          "record the read state for this ONE address (the route's `for`), instead of " +
            "the mailbox-wide flag. Use it for a shared/role address, e.g. " +
            "for_recipient=ada@example.com. REFUSED when it disagrees with an " +
            "identity-bound token",
        ),
    },
    handler: async (client, a) => {
      const requested: number = a.ids.length;
      const updated = await client.setSeen(a.ids, a.seen, a.for_recipient);
      return { updated, requested, unchanged: requested - updated, seen: a.seen };
    },
  },
  {
    name: "mailbox_set_flags",
    scope: "organize",
    description:
      "Set the flagged (starred) and/or answered flags on stored messages. MUTATING, " +
      "but it only changes flags; it neither sends nor deletes anything. Supply at " +
      "least one of flagged or answered: a call that sets neither is REFUSED rather " +
      "than treated as doing nothing. A flag you omit is LEFT ALONE, not cleared. " +
      COUNT_NOTE,
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).describe("the message ids to flag (as returned by search/list/get)"),
      flagged: z.boolean().optional().describe("true = star, false = unstar; omit to leave the flag unchanged"),
      answered: z
        .boolean()
        .optional()
        .describe("true = mark answered, false = clear it; omit to leave the flag unchanged"),
    },
    handler: async (client, a) => {
      // Refused here, not forwarded, so the caller gets the reason instead of a 400 it
      // has to interpret. The worker refuses the same shape, so this agrees with it
      // rather than inventing a rule.
      if (a.flagged === undefined && a.answered === undefined) {
        throw new PosternError("provide at least one of 'flagged' or 'answered'");
      }
      // Only the keys the caller actually set, because an omitted flag must be left
      // alone: sending `answered: undefined` would serialize to nothing, but building
      // the object this way makes that explicit rather than incidental.
      const set: FlagSet = {};
      if (a.flagged !== undefined) set.flagged = a.flagged;
      if (a.answered !== undefined) set.answered = a.answered;
      const requested: number = a.ids.length;
      const updated = await client.setFlags(a.ids, set);
      return { updated, requested, unchanged: requested - updated, set };
    },
  },
  {
    name: "mailbox_move",
    scope: "organize",
    description:
      "File stored messages into a durable folder, or restore them to the default view. " +
      "MUTATING: it changes where the messages appear for every reader of this mailbox. " +
      "This is a SOFT move and never deletes anything: mailbox='trash' files a message " +
      "in Trash, it does not erase it, and mailbox=null moves it back out of whatever " +
      "folder it was in. Use mailbox_folders first to see what is where. " +
      COUNT_NOTE,
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).describe("the message ids to move (as returned by search/list/get)"),
      mailbox: z
        .enum(["archive", "trash", "junk"])
        .nullable()
        .describe(
          "the destination folder: archive, trash or junk, or null to restore the " +
            "default unfoldered view. null is a real destination here, not a missing value",
        ),
    },
    handler: async (client, a) => {
      const mailbox: MailboxPlacement = a.mailbox ?? null;
      const requested: number = a.ids.length;
      const updated = await client.move(a.ids, mailbox);
      return { updated, requested, unchanged: requested - updated, mailbox };
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
      // STRICT, so an unknown parameter is a REFUSAL and not a strip. Refs #632 F1.
      //
      // This has to live in the SCHEMA, and that is not a style preference. The SDK calls
      // our handler with `parseResult.data` (server/mcp.js validateToolInput), so a plain
      // object schema has already dropped unknown keys by the time we could inspect them: a
      // check in this wrapper would be a gate that cannot fire. Passing a ZodObject keeps
      // strictness intact (normalizeObjectSchema returns an object schema as-is) and it also
      // improves the ADVERTISED schema, which now carries additionalProperties:false, so a
      // well-behaved client will not send the key in the first place.
      //
      // Why it matters more than it looks: a supplied filter that is silently dropped is
      // worse than one that is rejected, because the caller reasonably believes it applied.
      // That is how `mailbox_list after=... before=...` returned newest-N while reading like
      // a date-windowed answer (#631).
      //
      // That example is now HISTORY on both counts, and the order matters: #632 made the
      // strip a refusal, and #647 made the parameters real, so the same call is now answered
      // rather than refused. The rule this comment defends is unchanged and still load-bearing
      // for every parameter the tools do NOT declare; only its illustration was fixed.
      { description: t.description, inputSchema: z.object(t.inputSchema).strict() },
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
