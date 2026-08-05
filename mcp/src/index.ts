#!/usr/bin/env node
// Postern MCP server (stdio). Read tools over the Postern mailbox API so an agent
// can search, read, and thread mail; optional send tools (v1.1) when a send-scoped
// token is configured. Config is env-only; no secret ever lives in the repo. stdout
// is reserved for the JSON-RPC transport, so ALL logging goes to stderr (writing to
// stdout would corrupt the protocol stream).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PosternClient } from "./client.js";
import { READ_TOOLS, SEND_TOOLS, registerTools, type Scope } from "./tools.js";
import { VERSION } from "./version.js";

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

  const readClient = new PosternClient(apiUrl, token, { timeoutMs });

  const server = new McpServer({ name: "postern-mcp", version: VERSION });

  // Read tools always register. Prefer a per-identity registry token with scopes
  // including "read" (#544): the worker forces the viewer to that identity. An
  // estate POSTERN_API_TOKEN / _READ still works and remains estate-wide by design.
  const registered = registerTools(server, readClient, new Set<Scope>(["read"]), READ_TOOLS);

  // Send tools (v1.1) are OPT-IN and MUTATING. Prefer POSTERN_SEND_TOKEN; if unset,
  // reuse POSTERN_API_TOKEN when POSTERN_MCP_SEND=1 so a single identity registry
  // token with scopes ["read","send"] can power both without two env slots.
  // The send client is separate so the write credential never rides on read calls
  // unless the operator deliberately configured the same token.
  let sendToken = (process.env.POSTERN_SEND_TOKEN ?? "").trim();
  if (!sendToken && (process.env.POSTERN_MCP_SEND ?? "").trim() === "1") {
    sendToken = token;
  }
  if (sendToken) {
    const sendClient = new PosternClient(apiUrl, sendToken, { timeoutMs });
    const sent = registerTools(server, sendClient, new Set<Scope>(["send"]), SEND_TOOLS);
    registered.push(...sent);
    console.error("postern-mcp: send tools ENABLED -- mutating mail capability is live");
  }

  console.error(`postern-mcp: ready (${registered.length} tools: ${registered.join(", ")}) -> ${apiUrl}`);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("postern-mcp: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
