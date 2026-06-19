# The Postern contract (M1, Core v1.0)

Status: authoritative for M1. Sourced from design issue #33; field names map 1:1 to the
code in `inbound/src/index.ts`, `worker/src/email.ts`, and `inbound/schema.sql` so the
refactor diff stays traceable.

Postern is **one mailbox** reachable two ways: by agents (structured API) and by humans
(IMAP/webmail, which are *clients* of that same API). Underneath it is a **store** plus two
**transport seams**. Cloudflare Email is the default transport on each seam, never a hard
dependency. Anything that maps to the shapes below (an alternate SMTP relay, another
provider) plugs into the same seam without touching the store or the API.

```
 inbound transports                                                outbound transports
  CF Email Routing ─┐                                            ┌─ CF Email Sending  (default)
  postern-relay   ──┼─▶ ingest(ParsedInbound) ─▶ STORE ◀─ dispatch(OutboundMessage) ─┼─ relay / SES / ...
  (SMTP)            │        (#22)         (D1+R2+Vectorize)      (#23)               │
                    │                          ▲   │                                 │
                    │                    store  │   │  read                          │
                    │                           │   ▼                                │
                    │                       MAILBOX API  (list / get / search / send / reply)
                    └───────────────────────────┼─────────────────────────────────────┘
                                                 │  Bearer token  /  same-account RPC
                            agents · postern-imap · webmail · skyphusion-llm-public
```

Consumers reach the API two ways: a same-account **RPC entrypoint**
(`MailboxService extends WorkerEntrypoint`, tokenless, no network hop) and a token-gated
**HTTP** surface (`Authorization: Bearer <token>`). They are two doors onto the identical
operations; neither sees D1, R2, or Vectorize directly.

---

## 1. The store (data model)

`inbound/schema.sql` is the foundation. Migration `0002` makes it two-way and threaded;
nothing else in the schema changes.

```sql
ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'; -- 'inbound' | 'outbound'
ALTER TABLE messages ADD COLUMN thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id, date);
```

- `message_id` stays `UNIQUE`. Outbound messages get a Message-ID generated at send time, so
  they dedup and thread exactly like inbound ones.
- `attachments` and the FTS5 triggers are untouched. The triggers only read
  `subject` / `body_text`, which both directions populate.

**Threading** (resolved on every store, inbound or outbound):

1. If `in_reply_to` matches an existing row's `message_id`, inherit its `thread_id`.
2. Else if any id in `references` matches an existing row, inherit that `thread_id`.
3. Else start a new thread: `thread_id = this.message_id`.

**The references asymmetry (resolved).** Inbound carries threading as a typed
`ParsedInbound.references: string[]` (the parser already split the `References` header); outbound
carries it inside `OutboundMessage.headers` as the wire `In-Reply-To` / `References` strings
(that is what the provider must transmit). The store's input (`StoreInput`) takes the **typed**
`inReplyTo` + `references[]` form for both directions: `ingest()` passes the parsed list straight
through, and `mailbox` parses its own outbound header strings back into the typed list before
`store.put()`. So thread resolution always reads one typed shape; the header-string form exists
only on the wire, never in the resolver. Ids are compared with `<>` stripped on both sides.

`core/store.ts` is the **only** code that touches D1, R2, or Vectorize. Its surface:

```ts
store.put(msg: StoredMessage): Promise<{ stored: boolean; threadId: string }>;
//   INSERT OR IGNORE + thread resolve + attachments (R2) + opt-in Vectorize.
//   stored=false on a dedup hit (changes === 0).
store.get(messageId: string): Promise<StoredMessage | null>;
store.list(q: ListQuery): Promise<Page<StoredMessageSummary>>;
store.search(q: SearchQuery): Promise<Page<SearchHit>>;   // FTS now; semantic/hybrid in M4
store.thread(threadId: string): Promise<StoredMessage[]>; // ordered by date
```

`StoredMessage` is the `messages` row plus its `attachments[]`. No new vocabulary; the column
names are the field names.

```ts
interface StoredMessage {
  messageId: string;                  // messages.message_id
  direction: "inbound" | "outbound";  // messages.direction
  threadId: string;                   // messages.thread_id
  from: string;                       // messages.from_addr
  to: string;                         // messages.to_addr
  subject: string;                    // messages.subject
  date: string;                       // messages.date (ISO)
  inReplyTo: string | null;           // messages.in_reply_to
  bodyText: string;                   // messages.body_text
  auth: { spf: string; dkim: string; dmarc: string }; // messages.spf/dkim/dmarc
  trusted: boolean;                   // messages.trusted (0/1)
  receivedAt: string;                 // messages.received_at (ISO)
  attachments: AttachmentMeta[];
}

interface AttachmentMeta {
  filename: string | null;            // attachments.filename
  mime: string | null;                // attachments.mime
  size: number;                       // attachments.size
}
```

`StoredMessageSummary` is `StoredMessage` without `bodyText` and `attachments` (list views
do not pay for the body); it adds `attachmentCount: number`.

```ts
interface ListQuery {
  to?: string; from?: string; thread?: string;
  direction?: "inbound" | "outbound";
  q?: string;                         // FTS over subject + body
  limit?: number;                     // default 50, max 200
  cursor?: string;                    // opaque; encodes (date, id) of the last row
}
interface SearchQuery { q: string; mode?: "fts" | "semantic" | "hybrid"; limit?: number; cursor?: string }
interface Page<T> { items: T[]; cursor: string | null }   // cursor=null means no more
interface SearchHit { message: StoredMessageSummary; score?: number; snippet?: string }
```

The `cursor` is opaque: keyset pagination on `(date DESC, id DESC)` (the encoded last tuple),
stable under concurrent inserts; `cursor: null` means no more rows. Read endpoints fetch
`limit + 1` rows to decide whether a next cursor exists. The `q` / search text is **sanitized**
into a phrase expression before it reaches FTS5 `MATCH` (word tokens, each quoted, OR-joined),
so caller input cannot inject FTS operators or break the query; an all-punctuation query matches
nothing. All filter values are bound params. `search` ships `mode: "fts"` only in M1; `semantic`
and `hybrid` return `E_VALIDATION_ERROR` until M4 wires Vectorize.

---

## 2. Inbound transport contract: `ingest()` (#22)

The seam that decouples intake from CF Email Routing. Every inbound transport normalizes the
message it received into one shape and calls one function.

```ts
interface ParsedInbound {
  messageId?: string;          // raw Message-ID without <>; core normalizes (>64 chars -> sha256)
  from: string;                // envelope/header From
  to: string;                  // the delivered-to recipient
  subject?: string;
  date?: string;               // ISO; defaults to now
  inReplyTo?: string;
  references?: string[];
  text?: string;
  html?: string;               // core derives body_text from text, else stripped html
  attachments?: { filename?: string; mimeType?: string; content: ArrayBuffer }[];
  auth?: { spf?: string; dkim?: string; dmarc?: string }; // SMTP transport may omit
}

// core/ingest.ts
ingest(env: Env, parsed: ParsedInbound): Promise<{ messageId: string; stored: boolean; threadId: string }>;
```

`ingest()` owns exactly what `inbound/src/index.ts` does today (dedup key, body cleaning,
trust verdict, D1 insert, R2 attachments, opt-in Vectorize), but as a pure function of
`ParsedInbound` rather than of a `ForwardableEmailMessage`. Two drivers feed it:

- **In-Worker (default).** The CF `email()` handler runs `postal-mime`, builds `ParsedInbound`
  from the parsed message and the available auth headers, and calls `ingest()`. This is the
  one surviving `email()` handler (#21): the vestigial forward-only handler in `worker/` is
  removed.
- **Out-of-Worker.** `POST /ingest` (transport-token gated) accepts a `ParsedInbound` JSON
  body and calls `ingest()`. This is how **postern-relay** delivers SMTP-received mail without
  CF Email Routing (#29). `content` arrives base64-encoded over JSON; the driver decodes to
  `ArrayBuffer` before the call.

When `ParsedInbound.auth` is **absent or partial**, the missing verdicts default to `none`, which
is the allowlist-only trust path: a sender is trusted iff it is on `TRUSTED_SENDER_DOMAINS` (since
`spf=none && dkim=none` is treated as "CF stripped the headers, lean on the MX allowlist"). An
SMTP transport that omits `auth` therefore gets allowlist-only trust, never an implicit pass.

**Forwarding** (`FORWARD_TO` / `FORWARD_FOR`) stays, but only in the in-Worker driver: it
needs the live `message.forward()` on the `ForwardableEmailMessage`, which an out-of-Worker
transport does not have. The forward happens before `message.raw` is consumed by the parser
(consuming the stream first silently breaks delivery), then `ingest()` runs on the parsed
result. This ordering is load-bearing and must not move into `ingest()`.

---

## 3. Outbound transport contract: `dispatch()` (#23)

The mirror seam. The existing `EmailRequest` / `sendEmail()` validation in `worker/src/email.ts`
is kept verbatim as the *orchestration*; only the final `env.EMAIL.send()` call moves behind an
interface.

```ts
interface OutboundMessage {           // normalized, post-validation
  messageId: string;                  // core-generated, so we can thread + store the sent copy
  to: string[]; cc?: string[]; bcc?: string[];
  from: EmailAddress;                 // already domain-checked by resolveFrom()
  replyTo?: EmailAddress;
  subject: string;
  html?: string; text?: string;
  headers?: Record<string, string>;   // carries In-Reply-To / References on replies
}

interface Transport {
  dispatch(msg: OutboundMessage): Promise<{ providerMessageId?: string }>;
}
```

`providerMessageId` is **best-effort and provider-dependent**: populated only when the provider
returns an id (CF Email Sending does; an SMTP relay may not). Callers must not treat its absence
as failure, and must thread/store on the core-generated `messageId`, never on `providerMessageId`.

- **`CfEmailTransport` (default).** Wraps `env.EMAIL.send()`, byte-for-byte the current
  behavior. Selected when `OUTBOUND_TRANSPORT` is unset or `cf`.
- **`RelayTransport` (done) and others.** POST the `OutboundMessage` to the postern-relay
  `/dispatch` bridge (or another provider). The "not locked into CF" escape hatch (#28),
  selected by `OUTBOUND_TRANSPORT=relay`. Config: `RELAY_DISPATCH_URL` + the transport token
  `POSTERN_TRANSPORT_TOKEN` (NOT the mailbox API token). It maps the relay'"'"'s status back to the
  `E_*` vocabulary: 401/missing-config -> `E_INTERNAL_SERVER_ERROR`, 400 -> `E_VALIDATION_ERROR`,
  413 -> `E_PAYLOAD_TOO_LARGE`, 5xx / network failure -> `E_DELIVERY_FAILED` (retryable -> 502).

**The `/dispatch` wire shape** (pinned against the M3 relay, `relay/http.go`). A relay-style
transport POSTs the `OutboundMessage` as JSON to `POST /dispatch`, gated by
`POSTERN_TRANSPORT_TOKEN` (`Authorization: Bearer ...`, constant-time):

- Request body: the `OutboundMessage` JSON above, field-for-field (the relay decodes with
  unknown-field rejection, so the producer sends exactly these keys). `bcc` is envelope-only: it
  rides in `OutboundMessage.bcc`, never in `headers`.
- `200`: `{ "ok": true, "messageId": "<core id>", "providerMessageId": "<or empty>" }`.
- `400`: `{ "ok": false, "error": "..." }` for a malformed body (bad JSON / no recipients / empty
  message). `401`: missing or wrong transport token. `413`: body over the size cap. `502`:
  `{ "ok": false, "error": "dispatch failed: ..." }` when the upstream SMTP send fails (core may
  retry with backoff).

`mailbox.send()` is: `validate -> resolveFrom -> generate Message-ID -> dispatch() ->
store.put(direction: "outbound")`. The sent copy lands in the same store, so threads are complete
(#27). `mailbox.reply({messageId})` pulls the referenced stored message, routes to its sender,
prefixes `Re:` (collapsing an existing prefix), and rebuilds `In-Reply-To` / `References` from
**stored state, not caller input**, so a reply cannot be pointed at an arbitrary thread.

---

## 4. The one mailbox API

One structured channel, exposed as token-gated HTTP **and** a same-account RPC entrypoint
(`MailboxService extends WorkerEntrypoint`). Agents, `postern-imap`, and webmail all speak it;
none touches D1 directly (#25, #26).

| Method | Route | Purpose | Milestone |
|---|---|---|---|
| GET | `/api/messages?to=&from=&thread=&direction=&q=&limit=&cursor=` | list / filter (`q` = FTS) | M1 (done) |
| GET | `/api/messages/{messageId}` | full message + attachment metadata | M1 (done) |
| GET | `/api/messages/{messageId}/attachments/{i}` | attachment bytes | M1 |
| GET | `/api/threads/{threadId}` | ordered thread | M1 (done) |
| GET | `/api/search?q=&mode=fts\|semantic\|hybrid` | search (fts done; semantic/hybrid land in M4) | M1 (done) / M4 |
| POST | `/api/send` | send (body = `SendRequest`) | M2 (done) |
| POST | `/api/reply` | reply to `{messageId, html?, text?}`; core fills to / subject / In-Reply-To / References / thread | M2 (done) |

`POST /send` (today's bare endpoint) stays as a back-compat alias of `/api/send`. All responses
keep the current `{ ok, ... }` + `E_*` code shape from `INTEGRATION.md`, so existing callers
(skyphusion-llm-public, the relay) do not break.

The RPC entrypoint mirrors the read + write operations as typed methods (`list`, `get`,
`thread`, `search`, `send`, `reply`) returning the same shapes, no HTTP envelope.

---

## 5. Auth

- **Same-account Workers:** the RPC entrypoint, tokenless (as today's `EmailService`).
- **Everyone else:** `Authorization: Bearer <token>`, **constant-time** compare. Keep the
  existing `timingSafeEqual`; do not switch to `===`. Length may leak (tokens are high-entropy);
  the byte contents must not.
- The API secret is `POSTERN_API_TOKEN`. For one release, `RELAY_TOKEN` is read as a fallback
  so deployed relays keep working through the rename.
- Scoped / multi tokens are a post-v1 enhancement: noted, not built.

`POST /ingest` and `dispatch`-to-relay are infra seams, not API clients. They use a
**separate** transport token (`POSTERN_TRANSPORT_TOKEN`), not the API token, so an API
credential leak cannot inject mail and vice versa. (Decided, section 8.)

---

## 6. Refactor plan (maps to the M1 issues)

The end state is **one `core/` Worker** that owns the `send_email` binding **and**
D1 / R2 / Vectorize / AI together. The mailbox API needs the store and the sender in the same
isolate; keeping them in two Workers forces a cross-worker hop on every send-and-store. The Go
relay stays its own repo.

```
postern/
  core/
    src/
      index.ts        email() trigger + fetch router + MailboxService RPC
      store.ts        #25  the only D1/R2/Vectorize code
      ingest.ts       #22  ParsedInbound -> store  (+ in-Worker postal-mime driver, #21)
      mailbox.ts      #26  send()/reply(): validate -> dispatch -> store
      transport/
        index.ts      #23  Transport interface + selector
        cf.ts         #23  CfEmailTransport (default; wraps env.EMAIL.send)
      api.ts          #25/#26  the /api routes
      env.d.ts        merged Env
    migrations/0002_direction_thread.sql   #27
```

Order that stays green at each step:

1. **#21** unify the two `email()` handlers behind one `ingest()` (behavior unchanged, tests
   still pass).
2. **#22 + #23** extract the two seams behind the unchanged behavior.
3. **#25** read API on the store.
4. **#27 + #26** schema migration + send/reply.
5. **#24** the smoke gate.

M3 (relay), M4 (AI Search), M5 (postern-imap) attach to these finished seams.

**Where M2 actually landed (status).** Rather than do the full `worker/` + `inbound/` collapse
in one move, M2 built the outbound loop *into the `inbound/` worker* -- the isolate that already
owns the store (D1/R2/Vectorize/AI). `inbound/` now also holds the `send_email` (EMAIL) binding,
the transport seam (`transport/index.ts` + `transport/cf.ts`), `mailbox.ts` (send/reply),
`store.ts` (the sole D1/R2/Vectorize owner), and `api.ts` (the HTTP routes) plus a
`MailboxService` RPC entrypoint. So `inbound/` is the de-facto `core` from the store side; the
standalone `worker/` (send-only, `EmailService`) stays for back-compat this round and folds in
later. The send + store now share one isolate (no cross-worker hop), which is the property
section 6 required; the directory rename to `core/` is cosmetic and deferred.

---

## 7. Acceptance (the v1.0 gate, #24)

A stranger, from a fresh clone with only their own domain configured:

1. `wrangler deploy` succeeds with the default (CF) transports.
2. `POST /api/send` -> mail arrives.
3. Inbound mail to their domain appears in `GET /api/messages` and is findable via
   `GET /api/search?q=`.
4. `POST /api/reply` to that message threads (shared `thread_id`) and the sent copy is in the
   store.

Scripted, with zero skyphusion-specific assumptions. That green run is the launch artifact.

---

## 8. Decisions

All M1 contract decisions are locked. The list below is authoritative; build against it.

- One Worker, not two (rationale above).
- CF Email = default transport behind `dispatch` / `ingest`, never a hard dependency.
- One API for agents and humans; IMAP is a client of it, not a peer.
- `thread_id` denormalized onto `messages` (simple, indexable) over a separate threads table.
- API secret renamed `RELAY_TOKEN` -> `POSTERN_API_TOKEN`, with `RELAY_TOKEN` honored as a
  fallback for one release.
- **Transport auth (DECIDED):** `/ingest` and `dispatch`-to-relay use a **separate**
  `POSTERN_TRANSPORT_TOKEN`, never the mailbox API token. Transports are infra, not API clients,
  so an API-token leak cannot inject mail and a transport-token leak cannot read the mailbox.
- **Attachment delivery (DECIDED):** stream **bytes** for v1, base64-encoded over JSON on the
  `/ingest` body (`ParsedInbound.attachments[].content`) and as raw bytes on
  `GET /api/messages/{messageId}/attachments/{i}`. A short-lived signed R2 URL for large files
  is a post-v1 enhancement, not built now.
- **Runtime deps (DECIDED):** `postal-mime` is accepted in `core` (the store/ingest path needs
  it). The Go relay stays dependency-free (`go-smtp` + `enmime` only, no new deps).

Lane split: Strummer = transports / #23 + relay; Rollins = store + API + send / #25 / #26 /
#27; Joan = the API client surface (#32). Mackaye owns this contract end to end.
