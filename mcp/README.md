# postern-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Postern mailbox to an AI agent as **read tools**: search, list, read a message, and
read a thread. It is a thin, stdio MCP wrapper over the Postern mailbox API (the
same token-gated read endpoints the IMAP proxy uses), so an agent can use the
mailbox as a knowledge base.

v1 is **read-only**. Send tools (`mailbox_send` / `mailbox_reply`) follow in the
next release and require a send-scoped token; the registration seam for them is
already in place (see [Extending](#extending-send-tools-v11)).

## Tools

| Tool | What it does | Wraps |
|---|---|---|
| `mailbox_search` | Search subject + body, newest-first. `mode` defaults to `hybrid` (semantic + keyword). Optional `direction` (`inbound`/`outbound`), `limit`, `cursor`. **The primary tool.** | `GET /api/search` |
| `mailbox_list` | Browse/filter by `to` / `from` / `direction` / `thread`, paginated via `cursor`. | `GET /api/messages` |
| `mailbox_get` | Fetch one full message (headers + body text + attachment metadata) by `message_id`. | `GET /api/messages/{id}` |
| `mailbox_thread` | Fetch every message in a thread by `thread_id`. | `GET /api/threads/{id}` |

Each tool returns pretty-printed JSON. Errors come back as an MCP `isError` result
with a clear message (never a thrown exception).

## Install / build

```bash
cd mcp
npm install
npm run build      # compiles src -> dist (tsc)
```

Runtime deps are minimal: the MCP SDK and zod. Node >= 18 (uses the global `fetch`).

## Configure it in Claude Code

Add an entry to your MCP client config (e.g. `.mcp.json`, or via `claude mcp add`).
Point it at the built `dist/index.js` and pass the API origin + a **read-scoped**
token in `env` (never put the token in a tracked file):

```json
{
  "mcpServers": {
    "postern": {
      "command": "node",
      "args": ["/absolute/path/to/postern/mcp/dist/index.js"],
      "env": {
        "POSTERN_API_URL": "https://your-postern-api.workers.dev",
        "POSTERN_API_TOKEN": "<read-scoped Postern token>"
      }
    }
  }
}
```

Equivalent CLI form:

```bash
claude mcp add postern \
  --env POSTERN_API_URL=https://your-postern-api.workers.dev \
  --env POSTERN_API_TOKEN=<read-scoped token> \
  -- node /absolute/path/to/postern/mcp/dist/index.js
```

Once published to npm it is `npx`-runnable (`"command": "npx", "args": ["-y", "postern-mcp"]`).

## Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `POSTERN_API_URL` | yes | -- | the Postern mailbox API origin |
| `POSTERN_API_TOKEN` | yes | -- | a **read-scoped** API token, sent as `Authorization: Bearer` |
| `POSTERN_API_TIMEOUT_MS` | no | `15000` | per-request timeout (ms) |

Every request carries a custom `User-Agent` (`postern-mcp ...`). The API sits behind
Cloudflare, which 403s default bot user-agents ("error 1010"), so this is mandatory.

`stdout` is reserved for the JSON-RPC transport; all server logging goes to `stderr`.

## Security

- The token is read from the environment only and is never logged. Give the server a
  token scoped to **read** (#85); it cannot send or mutate mail in v1.
- Do not commit a real token. `.env.example` is a reference only.

## Extending: send tools (v1.1)

Tool registration is scope-gated (`src/tools.ts`): each tool declares the scope it
needs and `registerTools` registers only those the configured credentials satisfy.
v1.1 adds a `SEND_TOOLS` array (`mailbox_send`, `mailbox_reply`, scope `send`) and one
`registerTools(..., SEND_TOOLS)` call wired to a send-scoped token; they register
**only** when that token is present. No refactor of v1 is needed.

## Develop

```bash
npm test         # vitest: client + tools + smoke
npm run typecheck
```

## License

MIT (see [LICENSE](LICENSE)). The Postern server core is AGPL-3.0; this client
integration is MIT to maximize reuse, matching the other Postern clients.
