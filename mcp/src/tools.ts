// Tool registry. Each tool declares the scope it needs; registerTools registers
// only the tools whose scope the configured credentials satisfy. v1 ships READ
// tools (scope "read"). v1.1 adds SEND_TOOLS (mailbox_send / mailbox_reply, scope
// "send"); they register ONLY when a send-scoped token is configured -- the scope
// gate below already enforces this, no refactor.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PosternClient, PosternError } from "./client.js";
import type { SearchMode } from "./types.js";

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
const MODE = z.enum(["fts", "semantic", "hybrid"]);
// A recipient field accepts one address or a list; the worker validates each
// against its address rule and enforces the recipient cap.
const ADDRESSES = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const READ_TOOLS: ToolDef[] = [
  {
    name: "mailbox_search",
    scope: "read",
    description:
      "Search the mailbox (subject + body) and return matching messages newest-first. " +
      "mode defaults to 'hybrid' (semantic + keyword). Optionally filter by direction " +
      "('inbound' = received, 'outbound' = what we sent). This is the primary tool for " +
      "finding mail by topic.",
    inputSchema: {
      query: z.string().min(1).describe("the search text"),
      mode: MODE.optional().describe("search mode; defaults to hybrid"),
      limit: z.number().int().positive().max(200).optional().describe("max results (default server-side ~50)"),
      direction: DIRECTION.optional().describe("filter to received (inbound) or sent (outbound) mail"),
      cursor: z.string().optional().describe("opaque pagination cursor from a previous page"),
    },
    handler: async (client, a) => {
      const mode: SearchMode = a.mode ?? "hybrid";
      const page = await client.search({ q: a.query, mode, limit: a.limit, cursor: a.cursor, direction: a.direction });
      return { query: a.query, mode, direction: a.direction ?? null, count: page.items.length, cursor: page.cursor, results: page.items };
    },
  },
  {
    name: "mailbox_list",
    scope: "read",
    description:
      "List messages with optional filters (to, from, direction, thread) newest-first, " +
      "paginated via cursor. Use mailbox_search for topic search; use this to browse or " +
      "filter by participant/folder.",
    inputSchema: {
      to: z.string().optional().describe("filter by recipient address"),
      from: z.string().optional().describe("filter by sender address"),
      direction: DIRECTION.optional().describe("inbound (received) or outbound (sent)"),
      thread: z.string().optional().describe("filter to a thread id"),
      limit: z.number().int().positive().max(200).optional().describe("max results (default ~50)"),
      cursor: z.string().optional().describe("opaque pagination cursor"),
    },
    handler: async (client, a) => {
      const page = await client.list({ to: a.to, from: a.from, direction: a.direction, thread: a.thread, limit: a.limit, cursor: a.cursor });
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
      "Returns the new message id + thread id (shared with the original).",
    inputSchema: {
      message_id: z.string().min(1).describe("the message id being replied to (as returned by search/list/get)"),
      text: z.string().optional().describe("plain-text body (provide text and/or html)"),
      html: z.string().optional().describe("HTML body (provide text and/or html)"),
      cc: ADDRESSES.optional().describe("cc address, or a list"),
      bcc: ADDRESSES.optional().describe("bcc address, or a list"),
      from: z.string().optional().describe("optional From override; must be on the allowed From domain, else the server rejects it"),
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
