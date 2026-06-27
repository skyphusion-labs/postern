// Tool registry. Each tool declares the scope it needs; registerTools registers
// only the tools whose scope the configured credentials satisfy. v1 ships READ
// tools (scope "read"). The send tools (mailbox_send / mailbox_reply, scope
// "send") drop into SEND_TOOLS in v1.1 and register ONLY when a send-scoped
// token is present -- no refactor: the scope gate already exists here.

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

// Seam for v1.1: export const SEND_TOOLS: ToolDef[] = [ ...mailbox_send, mailbox_reply (scope "send")... ];
// index.ts will registerTools(server, sendClient, scopes, SEND_TOOLS); they only
// register when scopes includes "send" (i.e. a send-scoped token was configured).

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
