# postern-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Postern mailbox to an AI agent. It is a thin, stdio MCP wrapper over the Postern
mailbox API (the same token-gated endpoints the IMAP proxy uses), so an agent can use
the mailbox as a knowledge base and, when explicitly enabled, send mail.

- **Read tools** (always on): search, list, read a message, read a thread.
- **Send tools** (v1.1, **opt-in, default-OFF**): `mailbox_send` / `mailbox_reply`,
  registered **only** when a send-scoped token is configured. See
  [Send tools](#send-tools-v11-opt-in).

## Tools

### Read (scope `read`)

| Tool | What it does | Wraps |
|---|---|---|
| `mailbox_search` | Search subject + body, newest-first. `mode` defaults to `hybrid` (semantic + keyword). Optional `direction` (`inbound`/`outbound`), `limit`, `cursor`. **The primary tool.** | `GET /api/search` |
| `mailbox_list` | Browse/filter by `to` / `from` / `direction` / `thread`, paginated via `cursor`. | `GET /api/messages` |
| `mailbox_get` | Fetch one full message (headers + body text + attachment metadata) by `message_id`. | `GET /api/messages/{id}` |
| `mailbox_thread` | Fetch every message in a thread by `thread_id`. | `GET /api/threads/{id}` |

### Send (scope `send`, opt-in)

| Tool | What it does | Wraps |
|---|---|---|
| `mailbox_send` | Send a NEW email. Provide `to`, `subject`, and at least one of `text` / `html`. Optional `cc`, `bcc`, `from` (must be on the allowed From domain), `reply_to`. | `POST /api/send` |
| `mailbox_reply` | Reply to a stored message by `message_id` (provide `text` and/or `html`). The server fills `to` / `subject` / `In-Reply-To` / `References` / thread, so the reply lands in the same conversation. Optional `cc`, `bcc`, `from`. | `POST /api/reply` |

Send tools are **MUTATING**: they deliver mail as the estate. They register only
when a send token is present (see below). The server owns From-enforcement, DKIM
signing, threading, and storing the sent copy; the tools forward a composed message
and return the core `messageId` + `threadId`.

Each tool returns pretty-printed JSON. Errors come back as an MCP `isError` result
with a clear message (never a thrown exception) -- including the worker's own reason
on a 400/403 (e.g. `requires send scope`, `invalid to address: ...`).

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
| `POSTERN_API_TOKEN` | yes | -- | a **read-scoped** API token, sent as `Authorization: Bearer` on read tools |
| `POSTERN_SEND_TOKEN` | no | (unset) | a **send-scoped** API token (#85). When set, the send tools register and use it. **Mutating; opt-in.** |
| `POSTERN_API_TIMEOUT_MS` | no | `15000` | per-request timeout (ms) |

Every request carries a custom `User-Agent` (`postern-mcp ...`). The API sits behind
Cloudflare, which 403s default bot user-agents ("error 1010"), so this is mandatory.

`stdout` is reserved for the JSON-RPC transport; all server logging goes to `stderr`.

## Send tools (v1.1, opt-in)

Tool registration is **scope-gated** (`src/tools.ts`): each tool declares the scope it
needs and `registerTools` registers only those the configured credentials satisfy.

- Without `POSTERN_SEND_TOKEN`, the server is exactly the v1 read server -- the send
  tools are not registered and an agent cannot see or call them.
- With `POSTERN_SEND_TOKEN` set, the server additionally registers `mailbox_send` and
  `mailbox_reply`, on their own client using the send token. The read tools keep using
  the read token; the send token is never used on read routes.

This mirrors the server-side per-function token split (#85): the worker resolves
`POSTERN_API_TOKEN_SEND` to the `send` scope, which returns `200` on `POST /api/send`
and `/api/reply` but `403` on `/api/search` and `/api/admin/*`. So even if a send
token leaked, its blast radius is bounded to sending; it cannot read or administer.

### Rollout: default-OFF for the crew (deliberate toggle)

Sending is a mutating capability (an agent could send mail as the estate), so it is
shipped **built-but-dormant**. The read MCP is unchanged for everyone. Enabling send
for an agent is a deliberate, gated step: provision a send-scoped token, install it as
the worker's `POSTERN_API_TOKEN_SEND` secret, and add `POSTERN_SEND_TOKEN` to that
agent's MCP server `env`. Until that toggle is flipped, the send tools do not exist
at runtime. Do not wire the send token into shared/default agent config silently.

## Security

- Tokens are read from the environment only and never logged. Give the server a
  **read** token (#85) for read-only use; add a **send** token only to enable sending.
- A leaked token is bounded by its scope: a read token cannot send; a send token
  cannot read or administer (#85).
- Do not commit a real token. `.env.example` is a reference only.

## Develop

```bash
npm test         # vitest: client + tools + send + registration units
npm run typecheck
npm run build && npm run smoke   # boots the built server over stdio and asserts the scope gate
```

`npm run smoke` proves the default-OFF gate end to end at the process level: a
read-only env exposes exactly the four read tools, and adding `POSTERN_SEND_TOKEN`
adds `mailbox_send` + `mailbox_reply`. Live request scope-gating (a read token gets
`403` on send, a send token `403` on read) is enforced by the worker (#85).

## License

MIT (see [LICENSE](LICENSE)). The Postern server core is AGPL-3.0; this client
integration is MIT to maximize reuse, matching the other Postern clients.
