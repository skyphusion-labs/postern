#!/usr/bin/env node
// Postern MCP server (stdio). Read tools over the Postern mailbox API so an agent
// can search, read, and thread mail. Config is env-only; no secret ever lives in
// the repo. stdout is reserved for the JSON-RPC transport, so ALL logging goes to
// stderr (writing to stdout would corrupt the protocol stream).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PosternClient } from "./client.js";
import { READ_TOOLS, registerTools, type Scope } from "./tools.js";

function requireEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`postern-mcp: ${name} is required (set it in the MCP client config env)`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const apiUrl = requireEnv("POSTERN_API_URL");
  if (!/^https?:\/\//.test(apiUrl)) {
    console.error("postern-mcp: POSTERN_API_URL must start with http:// or https://");
    process.exit(1);
  }
  const token = requireEnv("POSTERN_API_TOKEN");
  const timeoutMs = Number(process.env.POSTERN_API_TIMEOUT_MS ?? "15000") || 15000;

  const client = new PosternClient(apiUrl, token, { timeoutMs });

  // v1: a read-scoped token (#85). The send scope (and SEND_TOOLS) is the v1.1
  // seam: when a POSTERN_SEND_TOKEN is configured we add "send" here and register
  // the send tools with a send-scoped client. Read tools never need it.
  const scopes = new Set<Scope>(["read"]);

  const server = new McpServer({ name: "postern-mcp", version: "0.1.0" });
  const registered = registerTools(server, client, scopes, READ_TOOLS);
  console.error(`postern-mcp: ready (${registered.length} tools: ${registered.join(", ")}) -> ${apiUrl}`);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("postern-mcp: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
