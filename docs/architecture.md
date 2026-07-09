# Postern architecture map

Postern is not one program. It is a small group of programs that share **one mailbox
store** and **one structured API**. Human doors (webmail, IMAP) and agent doors (MCP,
Python, RPC) are **clients** of that API; they never hold a second copy of the mail.

The authoritative data model and transport seams live in [CONTRACT.md](CONTRACT.md).
This page is the visual map; every component README links here so you always know where
you are in the stack.

## The stack at a glance

```mermaid
flowchart TD
    subgraph transports[Transport seams]
        cfIn[Cloudflare Email Routing]
        cfOut[Cloudflare Email Sending]
        relayIn[postern-relay ingest SMTP]
        relayOut[postern-relay dispatch + submission]
    end

    subgraph core[Core: inbound Worker]
        ingest[ingest / email handler]
        store[(STORE: D1 + R2 + Vectorize)]
        api[Mailbox API + MailboxService RPC]
        ingest --> store
        store --> api
        api --> dispatch[dispatch outbound]
    end

    subgraph clients[Clients: read and send through the API]
        webmail[webmail /webmail]
        imap[imap IMAP proxy]
        mcp[mcp MCP server]
        py[clients/python]
        rpc[Same-account Worker RPC]
    end

    cfIn --> ingest
    relayIn --> ingest
    dispatch --> cfOut
    dispatch --> relayOut

    webmail --> api
    imap --> api
    mcp --> api
    py --> api
    rpc --> api
```

Load-bearing rule: **transports write in; clients read (and send) out.** The store is
the single source of truth.

## Inbound path

```mermaid
sequenceDiagram
    participant MX as Internet / CF Email
    participant W as inbound Worker
    participant D1 as D1 messages + FTS5
    participant R2 as R2 attachments
    participant V as Vectorize optional

    MX->>W: Email Routing delivery
    W->>W: parse MIME, auth verdicts, body clean
    W->>D1: upsert message (envelope v2 merge on duplicate Message-ID)
    W-->>R2: attachment bytes (waitUntil)
    W-->>V: chunk embeddings (waitUntil, VECTORIZE_FOR)
```

Alternate ingest: the **relay** accepts SMTP on loopback, parses MIME, and POSTs to
`POST /ingest` (transport token). Same store path as CF Email Routing.

## Outbound path

```mermaid
sequenceDiagram
    participant C as Client API / MCP / RPC
    participant W as inbound Worker
    participant T as CF Email or relay dispatch
    participant D1 as D1 store

    C->>W: POST /api/send or /api/reply
    W->>W: validate, resolve From, generate Message-ID
    W->>T: dispatch(OutboundMessage)
    T-->>W: provider ack
    W->>D1: store outbound copy (same isolate)
    W-->>C: messageId
```

Submission SMTP (587/465) on the relay authenticates per user, enforces `From == identity`,
maps MIME to the same send shape, and forwards to the worker. See [AUTH-CONTRACT.md](AUTH-CONTRACT.md).

## Client doors

```mermaid
flowchart LR
    subgraph humans[Human read doors]
        wb[webmail<br/>browser at /webmail]
        im[imap<br/>Thunderbird / iOS Mail]
    end

    subgraph agents[Agent doors]
        mc[mcp<br/>stdio MCP tools]
        cp[clients/python<br/>scripts]
        wr[Worker MailboxService RPC]
    end

    api[Mailbox API<br/>Bearer token or RPC]

    wb -->|GET /api/*| api
    im -->|GET /api/*| api
    mc -->|HTTPS| api
    cp -->|HTTPS| api
    wr -->|service binding| api
```

| Component | Role | Send? | Published as |
|-----------|------|-------|--------------|
| `inbound/` | Core Worker: store, API, ingest, dispatch | yes (API) | -- |
| `relay/` | Optional SMTP bridge: ingest, submission, BYO dispatch | via worker | -- |
| `mcp/` | MCP tools for agents (`mailbox_search`, `mailbox_send`, ...) | opt-in send | [`@skyphusion/postern-mcp` on npm](https://www.npmjs.com/package/@skyphusion/postern-mcp) |
| `webmail/` | Self-contained read UI served at `/webmail` | no (v1) | -- |
| `imap/` | Read-only IMAP front for MUAs | no (v1) | -- |
| `clients/python/` | Thin stdlib HTTP client + CLI | if token allows | [`postern-client` on PyPI](https://pypi.org/project/postern-client/) |

Search modes on `/api/search`: `fts` (keyword), `semantic` (Vectorize), `hybrid` (both).
MCP and webmail default to **hybrid** when Vectorize is bound.

## Repo layout

```mermaid
flowchart TD
    repo[postern repo]

    repo --> inbound[inbound/<br/>Cloudflare Worker]
    repo --> relay[relay/<br/>Go SMTP daemon]
    repo --> mcp[mcp/<br/>TypeScript MCP server]
    repo --> webmail[webmail/<br/>static HTML embed]
    repo --> imap[imap/<br/>Python Twisted IMAP]
    repo --> py[clients/python/<br/>stdlib client]
    repo --> docs[docs/<br/>CONTRACT, AUTH, integration]

    inbound -. embeds .-> webmail
```

## Further reading

- [CONTRACT.md](CONTRACT.md) -- data model, ingest/dispatch shapes, envelope v2
- [AUTH-CONTRACT.md](AUTH-CONTRACT.md) -- API vs transport tokens, submission auth
- [SEND-IDENTITIES.md](SEND-IDENTITIES.md) -- per-identity send registry
- [INTEGRATION.md](INTEGRATION.md) -- RPC binding + REST examples
- [DEPLOY.md](../DEPLOY.md) -- clean-install quickstart
