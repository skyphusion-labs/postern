# The Postern contract (M1, Core v1.0)

Status: authoritative for M1. Sourced from design issue #33; field names map 1:1 to the
code in `inbound/src/index.ts`, `inbound/src/mailbox.ts`, and `inbound/schema.sql` so the
refactor diff stays traceable. Section 10 (M8, #189) extends the data model to envelope
fidelity v2; where it and section 1 disagree, section 10 wins.

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
store.search(q: SearchQuery): Promise<Page<SearchHit>>;   // fts + substr; semantic/hybrid in M4
store.thread(threadId: string): Promise<StoredMessage[]>; // ordered by date
```

`StoredMessage` is the `messages` row plus its `attachments[]`. No new vocabulary; the column
names are the field names.

```ts
interface StoredMessage {
  messageId: string;                  // messages.message_id
  direction: "inbound" | "outbound";  // messages.direction
  threadId: string;                   // messages.thread_id
  from: string;                       // messages.from_addr -- the raw RFC 5322 From HEADER
                                      // (display name preserved, e.g. '"Cloudflare"
                                      // <noreply@notify.cloudflare.com>'), like to_addr holds
                                      // the raw To header. NOT the SMTP envelope sender (MAIL
                                      // FROM), which for VERP/bounce senders is a dynamic
                                      // bounce address; the envelope sender is not stored.
                                      // reply() extracts the bare angle address to route.
  to: string;                         // messages.to_addr
  subject: string;                    // messages.subject
  date: string;                       // messages.date (ISO)
  inReplyTo: string | null;           // messages.in_reply_to
  bodyText: string;                   // messages.body_text
  bodyHtml: string | null;            // messages.body_html; the raw HTML body when the
                                      // message carried an HTML part, else null. Stored
                                      // for rich rendering (webmail iframe, IMAP text/html
                                      // projection); bodyText stays the FTS + plain fallback.
  auth: { spf: string; dkim: string; dmarc: string }; // messages.spf/dkim/dmarc
  trusted: boolean;                   // messages.trusted (0/1)
  receivedAt: string;                 // messages.received_at (ISO)
  seen: boolean;                      // messages.seen (0/1) -- read state (#seen). Inbound
                                      // mail is stored unread (false); outbound sent copies
                                      // read (true). Flipped by POST /api/messages/seen; backs
                                      // the IMAP \Seen flag + webmail unread view so a human
                                      // can tell new mail from mail already read.
  attachments: AttachmentMeta[];
}

interface AttachmentMeta {
  filename: string | null;            // attachments.filename
  mime: string | null;                // attachments.mime
  size: number;                       // attachments.size
}
```

`StoredMessageSummary` is `StoredMessage` without `bodyText`, `bodyHtml`, and `attachments` (list views
do not pay for the body); it adds `attachmentCount: number`, `hasHtml: boolean`, and `uid: number`.

`hasHtml` is true when the store holds a non-empty `body_html` column. It is derived body-free
(`TRIM(body_html) <> ''`) so the IMAP door can project `multipart/alternative` and serve the top
`Content-Type` (with boundary) without a per-message body fetch (#220).

```ts
interface StoredMessageSummary {
  uid: number;                        // messages.id (AUTOINCREMENT rowid) -- see below
  // ...all StoredMessage fields except bodyText, bodyHtml + attachments...
  attachmentCount: number;
  hasHtml: boolean;                   // true when body_html is non-empty (#220)
}
```

**`uid` -- the monotonic insertion key / IMAP UID (#103, RFC 3501).** `uid` is the
store's `messages.id`, an `INTEGER PRIMARY KEY AUTOINCREMENT` rowid assigned strictly
ascending at ARRIVAL and NEVER reused (AUTOINCREMENT keeps a high-water mark, so a new
row is always greater than any id that has ever existed, even across deletions). It is
the durable value the IMAP proxy maps each message to: order the mailbox by `uid`
(arrival order) and surface it as the per-message IMAP UID under a constant
`UIDVALIDITY`. This is what makes the proxy RFC 3501-conformant. Contrast `date`:
ordering by `date` is non-conformant because a backdated inbound message (an old
`Date:` header arriving now) inserts MID-order and shifts the positional UID of every
later message, corrupting a client's cached UID -> message mapping. Ordered by `uid`, a
backdated message simply gets the next-highest `uid` and appears last -- correct IMAP
semantics, no cache corruption. `uid` is also the `id` half of the keyset pagination
cursor (a `Page` cursor encodes `(date, id)`); it is always present and `> 0`.

```ts
interface ListQuery {
  to?: string; from?: string; thread?: string;
  direction?: "inbound" | "outbound";
  q?: string;                         // FTS over subject + body
  limit?: number;                     // default 50, max 200
  cursor?: string;                    // opaque; encodes (date, id) of the last row
}
interface SearchQuery { q: string; mode?: "fts" | "substr" | "semantic" | "hybrid"; field?: "subject" | "body" | "text"; limit?: number; cursor?: string }
interface Page<T> { items: T[]; cursor: string | null }   // cursor=null means no more
interface SearchHit { message: StoredMessageSummary; score?: number; snippet?: string }
```

The `cursor` is opaque: keyset pagination on `(date DESC, id DESC)` (the encoded last tuple),
stable under concurrent inserts; `cursor: null` means no more rows. Read endpoints fetch
`limit + 1` rows to decide whether a next cursor exists. The `q` / search text is **sanitized**
into a phrase expression before it reaches FTS5 `MATCH` (word tokens, each quoted, OR-joined),
so caller input cannot inject FTS operators or break the query; an all-punctuation query matches
nothing. All filter values are bound params. `search` modes: `fts` (M1, date-ordered + cursor-paged), `substr` (M9, exact case-insensitive substring for IMAP SEARCH parity, see 10.8), `semantic` and `hybrid` (M4, over the
Vectorize index the store populates for BOTH inbound and outbound mail, #116 ws2). `semantic` embeds the query with the same model
(`@cf/baai/bge-base-en-v1.5`) and queries Vectorize, collapsing chunk-hits to unique messages
(best chunk score wins) and hydrating from D1; `hybrid` blends the fts and semantic result sets
by `message_id` on a normalized score. semantic/hybrid are SCORE-ranked, so they return a single
ranked page (`cursor` always null) of up to `limit` hits -- a date keyset cursor does not apply;
paging a re-ranked semantic set is a post-v1 nicety. If the AI/Vectorize bindings are not
configured, semantic/hybrid degrade to empty rather than erroring (ingest skips indexing too). An
unknown mode returns `E_VALIDATION_ERROR`.

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
  one surviving `email()` handler (#21).
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

The mirror seam. Send/reply validation lives in `inbound/src/mailbox.ts`; only the final `env.EMAIL.send()` call moves behind an
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
| GET | `/api/messages?to=&from=&thread=&direction=&mailbox=&q=&limit=&cursor=` | list / filter (`q` = FTS; `mailbox=archive\|trash\|junk\|all`, unset = direction-default views) | M1 / webmail v2 (#352) |
| GET | `/api/messages/{messageId}` | full message + attachment metadata | M1 (done) |
| GET | `/api/messages/{messageId}/attachments/{i}` | attachment bytes | M1 |
| GET | `/api/threads/{threadId}` | ordered thread | M1 (done) |
| GET | `/api/search?q=&mode=fts\|substr\|semantic\|hybrid&field=` | search (fts + substr + semantic + hybrid) | M1 / M4 / M9 (#212) |
| GET | `/api/mobileconfig?user=&username=&name=` | per-user Apple .mobileconfig profile (iOS Mail one-tap setup) | M9 (#187) |
| POST | `/api/send` | send (body = `SendRequest`) | M2 (done) |
| POST | `/api/reply` | reply to `{messageId, mode?: "reply"\|"replyAll", quoteOriginal?, html?, text?, attachments?}`; core derives recipients, excludes/dedupes self for reply-all, fills subject/thread headers, and carries attachments | M2 / webmail v2 (#353) |
| POST | `/api/messages/seen` | mark `{ids: string[], seen: boolean}` (un)read; returns `{updated}` (READ-scoped, #seen) | (#seen) |
| POST | `/api/messages/flags` | set durable `{ids, set: {flagged?, answered?}}` flags (read-scoped organize operation) | webmail v2 (#352) |
| POST | `/api/messages/move` | move/restore `{ids, mailbox: "archive"\|"trash"\|"junk"\|null}`; Trash is soft-delete | webmail v2 (#352) |
| GET | `/api/folders` | authoritative Inbox/Sent/All/Drafts/Trash/Junk/Archive counts + unread counts; durable folders also return `uidValidity` | webmail v2 (#352) |
| GET/POST | `/api/drafts` | list or create an identity-owned server-side draft | webmail v2 (#352) |
| GET/PUT/DELETE | `/api/drafts/{id}` | read, optimistic-concurrency replace, or discard own draft | webmail v2 (#352) |
| GET/POST | `/api/drafts/{id}/attachments` | list or stage raw attachment bytes for an identity-owned draft | webmail v2 (#353) |
| DELETE | `/api/drafts/{id}/attachments/{attachmentId}` | remove one staged attachment and its R2 bytes | webmail v2 (#353) |
| POST | `/api/drafts/{id}/send` | load staged attachments, send through the one send core, then remove the draft and staging only after success | webmail v2 (#352/#353) |
| GET/POST/DELETE | `/api/imap/drafts[/{id}]` | IMAP-service draft projection for an explicitly asserted, already-authenticated identity | webmail v2 (#352) |
| POST | `/api/imap/import` | preserve a genuine Sent/Trash/Junk/Archive APPEND from raw MIME without transmitting it | webmail v2 (#352) |
| DELETE | `/api/messages/{messageId}` | irreversible hard-delete + attachments + Vectorize tombstone (`delete` or `both` scope) | (#278/#352) |
| POST | `/api/smtp-auth` | validate an SMTP submission login; returns the bound `from` (TRANSPORT-token gated) | M6 (#68) |
| POST | `/api/admin/smtp-credentials` | mint / rotate a submission credential (returns the secret once) | M6 (#68) |
| DELETE | `/api/admin/smtp-credentials/{username}` | revoke a submission credential | M6 (#68) |
| POST | `/api/admin/reindex` | backfill / re-embed the mailbox into Vectorize, one page per call | M4 (#116 ws4) |

`POST /api/admin/reindex` is the **backfill** (#116 ws4): it (re)embeds the EXISTING mailbox into
the semantic index so history predating the live index -- and all historical outbound -- becomes
queryable. It is `both`-scoped (admin, #85), so a read or send token gets `403`. Body
`{ cursor?, limit?, dryRun? }`; it processes ONE keyset page per call (same `(date DESC, id DESC)`
order + opaque cursor as the read API), applies the SAME `VECTORIZE_FOR` gate as live ingest
(`store.shouldVectorize`: outbound always, inbound per allowlist), and AWAITS the embeds so a page
finishes inside request limits. It returns
`{ ok, total?, processed, indexed, vectors, skippedByGate, nextCursor, done, dryRun }` (`total` only
on the first call). Each message is embedded through the SAME `embedAndUpsert` the live path uses, so
backfilled vectors are byte-identical to live ones, and the vector id is deterministic
(`sha256(messageId).slice + chunk`) so a re-run OVERWRITES -- the backfill is **idempotent** and safe
to resume or repeat. `dryRun: true` does everything except the embed/upsert, summing the chunk count
so the exact vector total (and cost) is known before the real run. A thin runner (`inbound/reindex.mjs`)
loops it until `done`.

`POST /api/messages/seen` (#seen) flips per-message read state: body `{ ids: string[], seen: boolean }`,
returns `{ ok, updated }` (rows actually changed; unknown ids are skipped, an empty list is a no-op).
It is **`read`-scoped**, not send/admin: marking mail read is a side effect of READING it, and the IMAP
read door commonly holds only a read token, so a read token must be able to persist its own read state.
It backs the IMAP `\Seen` flag (`postern-imap` STOREs it) and the webmail unread view. Inbound mail is
stored unread; outbound sent copies are stored read. IMAP hard delete uses a dedicated `delete`
token; read-only IMAP credentials can still mark `\Seen`.
stored unread and outbound sent copies read (`store.put`); the column DEFAULT is `read` so migration
0007 backfills existing rows without resurfacing the whole historical mailbox as unread.

`GET /api/mobileconfig` (#187) returns a per-user Apple configuration profile
(`application/x-apple-aspen-config`) that sets up iOS Mail in one tap: IMAP
`imap.<domain>:993` (implicit TLS) plus submission `smtp.<domain>:587` (STARTTLS,
expressed as `OutgoingMailServerUseSSL=true` on port 587, per Apple's schema, which
has no separate STARTTLS key). It is `read`-scoped: it bakes in NO password (iOS
prompts on install), so it emits no secret. Params: `user` (required, an address on
`ALLOWED_FROM_DOMAIN`), optional `username` (login, defaults to the address local part -- the mail doors bind by bare directory username) and
`name` (display name); all user-supplied fields are XML-escaped. The two
`PayloadUUID`s are minted per generation while the `PayloadIdentifier`s are stable
per user, so a reinstall REPLACES the profile instead of duplicating the account on
the device. Hostnames/labels come from the `MOBILECONFIG_*` env (domain-derived
defaults).

`POST /send` (today's bare endpoint) stays as a back-compat alias of `/api/send`. All responses
keep the current `{ ok, ... }` + `E_*` code shape from `INTEGRATION.md`, so existing callers
(skyphusion-llm-public, the relay) do not break.

**Compose parity (#353).** Caller-authored HTML is sanitized server-side at SEND
by a zero-dependency closed allowlist (`sanitize-html.ts`). The same sanitized
string is dispatched and persisted in the outbound Sent row's `body_html`; draft
HTML remains authored state until send. Reply-all recipients come from stored
Reply-To/From + To/Cc, are case-insensitively deduped, and exclude the resolved
sending identity. Reply/forward quote text uses `body_text`, falling back through
HTML-to-text when the original is HTML-only.

Draft attachment staging is identity-bound metadata in `draft_attachments` plus
R2 bytes under `drafts/<draft-id>/...`. It shares send's hard caps (20 parts,
25 MiB decoded total). A failed draft send leaves the draft and staged bytes
unchanged; deletion occurs only after dispatch and Sent-copy storage succeed.

**Draft-send idempotency.** Delivery is at-least-once, not exactly-once. A
confirmed success deletes the draft, so later retries do not resend; failures
preserve it. A crash after provider acceptance but before draft deletion, or two
concurrent sends racing before deletion, can still duplicate delivery. Clients
must suppress concurrent submits. A durable send claim/general idempotency key is
the separate C2 follow-up.

The RPC entrypoint mirrors the read + write operations as typed methods (`list`, `get`,
`thread`, `search`, `send`, `reply`) returning the same shapes, no HTTP envelope.

---

## 5. Auth

- **Same-account Workers:** the `MailboxService` RPC entrypoint (or legacy `EmailService` alias), tokenless.
- **Everyone else:** `Authorization: Bearer <token>`, **constant-time** compare. Keep the
  existing `timingSafeEqual`; do not switch to `===`. Length may leak (tokens are high-entropy);
  the byte contents must not.
- `POSTERN_API_TOKEN` is the back-compatible `both` secret. Optional comma-set slots
  `POSTERN_API_TOKEN_READ`, `POSTERN_API_TOKEN_SEND`, `POSTERN_API_TOKEN_DELETE`, and
  `POSTERN_API_TOKEN_IMAP`
  grant only their named function. `both` alone preserves the single-key posture.

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

**Where M2 landed (status).** The outbound loop lives in the `inbound/` worker, the isolate
that owns the store (D1/R2/Vectorize/AI). `inbound/` holds the `send_email` (EMAIL) binding,
the transport seam (`transport/index.ts` + `transport/cf.ts`), `mailbox.ts` (send/reply),
`store.ts` (the sole D1/R2/Vectorize owner), and `api.ts` (the HTTP routes) plus
`MailboxService` RPC entrypoint (and a legacy `EmailService` alias for send-only bindings,
#190). The standalone `worker/` send-only Worker was retired in #190. Send + store share one
isolate (no cross-worker hop), which is the property section 6 required; the directory rename
to `core/` is cosmetic and deferred.

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
- API secret is `POSTERN_API_TOKEN` (formerly `RELAY_TOKEN`, rename complete as of #190).
- **Transport auth (DECIDED):** `/ingest` and `dispatch`-to-relay use a **separate**
  `POSTERN_TRANSPORT_TOKEN`, never the mailbox API token. Transports are infra, not API clients,
  so an API-token leak cannot inject mail and a transport-token leak cannot read the mailbox.
- **Attachment delivery (DECIDED):** stream **bytes** for v1, base64-encoded over JSON on the
  `/ingest` body (`ParsedInbound.attachments[].content`) and as raw bytes on
  `GET /api/messages/{messageId}/attachments/{i}`. A short-lived signed R2 URL for large files
  is a post-v1 enhancement, not built now.
- **Runtime deps (DECIDED):** `postal-mime` is accepted in `core` (the store/ingest path needs
  it). The Go relay's core transport + the default (native) submission auth are stdlib-only
  (`go-smtp` + `enmime`, plus `go-sasl` which IS go-smtp's own server AUTH API surface). The
  optional `ldap` auth backend adds pure-Go `go-ldap` (no cgo); the optional `system` (PAM)
  backend is a cgo, build-tagged (`-tags pam`) extra (`msteinert/pam`) excluded from the default
  static binary. The lean-default spirit holds: a fresh clone with `AUTH_BACKEND=native` pulls no
  auth dependency beyond the go-smtp family.
- **Submission auth is PLUGGABLE (DECIDED, #68):** the daemon has an `AuthProvider` interface
  (`Authenticate(username, secret) -> identity`) selected by `AUTH_BACKEND`, with three backends.
  **native** (DEFAULT, zero extra deps): validate at the worker `POST /api/smtp-auth` (transport
  token) against the `smtp_credentials` D1 table (PBKDF2 hash, never plaintext); the fresh-clone
  quickstart uses this and needs no LDAP/PAM. **ldap**: direct-bind + self-read over TLS via
  pure-Go `go-ldap` (`LDAP_BIND_DN_TEMPLATE`; the search+bind path is retired, #182); bound
  identity = the mail attribute read from the user's own entry. **system**: local Unix accounts via PAM,
  a cgo build-tagged (`-tags pam`) extra excluded from the default static binary; bound identity =
  `<user>@<configured-domain>`. From-enforcement is identical for every backend.
- **Submission attachments (DECIDED, #68 + #70 + #363, DONE):** `/api/send` AND `/api/reply` carry attachments as
  `SendRequest.attachments?: { filename?; mimeType?; content }[]` (reply takes the SAME shape and validation,
  #363), where `content` is standard base64
  over JSON (the same shape as inbound `ParsedInbound.attachments`). The submission daemon maps the
  parsed MIME parts (attachments, inline, and other non-body parts) to that shape and forwards them; the
  worker hands them to the Cloudflare Email Sending binding, which builds the multipart MIME itself, so
  there is no hand-rolled RFC 5322 and no added runtime dependency. `CfEmailTransport` base64-DECODES
  `content` to bytes for the binding. Limits: at most 20 parts and 25 MiB decoded total (the CF message
  cap), else `E_PAYLOAD_TOO_LARGE` (413, mapped to SMTP `552`). For v1 every part is delivered with
  disposition `attachment`; rendering inline parts inline (cid) is a tracked refinement, never a silent
  drop (the bytes are always preserved). The default CF transport is the supported attachment path for
  The relay `/dispatch` OUTBOUND bridge (`OUTBOUND_TRANSPORT=relay`) carries attachments as
  `OutboundMessage.attachments` (base64 over JSON, multipart/mixed MIME, #92 DONE).
- **AI Search: hand-rolled Vectorize query, not managed AutoRAG (DECIDED, #31).** The store
  populates a Vectorize index (one vector per body chunk, `@cf/baai/bge-base-en-v1.5`, metadata
  carries `message_id`, `chunk`, `direction`, `from`, `to`, `date`, `subject`). The index covers
  mail in BOTH directions (#116 ws2): inbound received mail AND the outbound sends / replies the
  mailbox stores back, so a status / decision query finds the answer WE wrote, not just the
  question. `direction` ("inbound" | "outbound") in the metadata lets a query attribute or filter
  "what we said" vs "what was asked". Indexing default is index-ALL: outbound is always our own mail
  and is indexed unconditionally; inbound indexing is index-all by default, optionally NARROWED by
  the `VECTORIZE_FOR` allowlist (opt-in privacy gate for shared-domain crew mail). M4 semantic/hybrid
  query THAT index directly (embed query -> Vectorize
  query -> collapse chunks to messages -> hydrate from D1) rather than standing up managed CF AI
  Search / AutoRAG. Rationale: AutoRAG would re-index from a separate data source, duplicating
  storage + embeddings and adding a managed dependency, against the no-rent/no-lock-in thesis. The
  hand-rolled path reuses the existing index, the existing `SearchHit`/`Page` read shape, and adds
  zero dependencies. If a deployment omits the AI/Vectorize bindings, semantic/hybrid degrade to
  empty (fts still works).

Lane split: Strummer = transports / #23 + relay; Rollins = store + API + send / #25 / #26 /
#27; Joan = the API client surface (#32). Mackaye owns this contract end to end.

---

## 9. Submission transport seam: authenticated SMTP for clients (#68)

The third transport seam, paired with M5's IMAP read proxy so postern is a real human mailbox:
a standard IMAP client (Thunderbird / Apple Mail / mobile) sends AS the operator's own domain
through an authenticated **SMTP submission** endpoint that bridges to the existing `/api/send` seam.
This is the generic send-as-your-own-domain feature, not skyphusion-specific: nothing below hardcodes
a domain (the bound identity comes from the auth backend), so postern is self-hostable from a fresh
clone with only the operator's own domain configured. Workers cannot listen on submission ports, so
this lives in the Go **relay** (`relay/submission.go`), alongside the inbound `ingest` and outbound
`dispatch` bridges; it reuses the proven send seam rather than a new send path.

```
 IMAP client ──TLS (STARTTLS or implicit)──▶ relay submission daemon
   │  AUTH PLAIN/LOGIN (only after TLS)                 │
   │                              AuthProvider backend (native | ldap | system)
   │                                                    ▼
   │                                   resolve the bound identity (the user's address)
   │  MAIL/RCPT/DATA (MIME)                             │
   ▼  enforce From == bound identity                    ▼
 relay ──POST /api/send (mailbox API token)──▶ worker: DKIM-sign + send + store sent copy ─▶ MX
```

### Listeners (arbitrary, configurable)

`SUBMISSION_LISTENERS` is a comma-separated list of `<addr>:<mode>` entries (mode = `starttls` or
`implicit`; a bare port means `:<port>`). It is a LIST, not a fixed 587/465: ISPs/providers commonly
block 25/587, so an operator can bind alternate ports (e.g. `2525`, `8025`) to route around the
block. Every listener shares the same AUTH + From-enforcement + `/api/send` bridge; AUTH is offered
only after TLS on all of them. The TLS cert is read from `SUBMISSION_TLS_CERT` / `_KEY` and
**hot-reloaded** when the file changes (a renewal needs no daemon restart); how the operator obtains
and renews the cert (certbot, acme.sh, DNS-01, commercial, self-signed for testing) is THEIR choice,
never a daemon dependency.

### Auth (pluggable: native | ldap | system)

The daemon offers SMTP AUTH (PLAIN + LOGIN) **only after TLS** (go-smtp `AllowInsecureAuth=false` +
`TLSConfig`; a cleartext `AUTH` is answered `523`). An `AuthProvider` interface verifies the login
and returns the bound identity; the backend is chosen by `AUTH_BACKEND` (default `native`). All three
share the same From-enforcement.

- **native** (default, zero extra deps): validate `{username, secret}` at the worker via:

```
POST /api/smtp-auth          Authorization: Bearer <POSTERN_TRANSPORT_TOKEN>
  { "username": "...", "secret": "..." }
  200 { "ok": true,  "from": "user@your-domain" }      // good credential
  200 { "ok": false }                                   // bad credential -> daemon answers 535
  401                                                    // wrong transport token (relay misconfig)
  400 { "ok": false, "error": "E_FIELD_MISSING" }      // missing username/secret
```

The endpoint is gated by the **transport token**, never the mailbox API token (section 5): the relay
is an infra seam, not an API client. `smtp_credentials` (migration `0004`) stores the secret only as
a `pbkdf2$<iterations>$<salt>$<hash>` derivation (Web Crypto PBKDF2-HMAC-SHA256); an unknown user is
verified against a dummy hash so timing does not reveal whether the username exists. Operators mint /
rotate / revoke credentials via the API-token-gated `POST` / `DELETE /api/admin/smtp-credentials`
(the generated secret is returned once and never logged).

  The endpoint is gated by the **transport token**, never the mailbox API token (section 5): the
  relay is an infra seam, not an API client. `smtp_credentials` (migration `0004`) stores the secret
  only as a `pbkdf2$<iterations>$<salt>$<hash>` derivation (Web Crypto PBKDF2-HMAC-SHA256); an
  unknown user is verified against a dummy hash so timing does not reveal whether the username
  exists. Operators mint / rotate / revoke credentials via the API-token-gated `POST` /
  `DELETE /api/admin/smtp-credentials` (the secret is returned once and never logged).
- **ldap**: LDAP direct-bind + self-read (`LDAP_BIND_DN_TEMPLATE` required) over TLS (`ldaps://`
  or `LDAP_STARTTLS`). After bind success the backend self-reads the user's entry for the
  `LDAP_MAIL_ATTR` identity (default `mail`) and optional `LDAP_REQUIRE_GROUP` gate (#182).
  The search+bind vars (`LDAP_BIND_DN`, `LDAP_SEARCH_*`) are retired. Pure-Go `go-ldap`, no cgo.
  An empty password is rejected before the wire (an empty bind can be an anonymous-bind bypass).
- **system**: local Unix accounts via PAM. The bound identity is `<user>@AUTH_SYSTEM_DOMAIN`. PAM
  needs cgo, so this backend is **build-tagged**: the default static binary excludes it and rejects
  `AUTH_BACKEND=system` with a "rebuild with -tags pam" error. Build `go build -tags pam` (libpam
  headers) and add a PAM service file (default `/etc/pam.d/postern`).

### From-enforcement (the core safety property)

On authenticated `DATA` the message header `From` MUST equal the bound identity returned by
`/api/smtp-auth` (case-insensitive). A missing or mismatched `From` is a spoof attempt and is
rejected `550`. SPF/DKIM/DMARC alignment stays owned by `/api/send`; submission never bypasses it.
Only the SENDER is authenticated per user; the mailbox/store stays the shared per-domain D1.

### Bridge to `/api/send`

The parsed MIME is mapped to a `SendRequest` and POSTed to `/api/send` (gated by the **mailbox API
token**, carried by the relay as `POSTERN_SEND_TOKEN`), so it gets the same DKIM-signing + sent-copy
store as an API send. Recipient reconstruction keeps Bcc private through the field-based API:

- `to` / `cc` are the `To` / `Cc` header addresses **intersected with the envelope** (a header
  address not in `RCPT TO` is not a real recipient and is not delivered);
- `bcc` = envelope `RCPT TO` minus those (kept envelope-only, never headered);
- `In-Reply-To` / `References` ride in `headers` so a client reply threads on the wire.

The relay maps `/api/send` status to SMTP replies: `2xx` -> `250`; `400`/`403` -> `550` (permanent);
`401` (relay's send token wrong) and `5xx` / network -> `451` (transient, MTA may retry); `413` ->
`552`.

### v1 limitations (locked, honest, not silent)

- **Attachments are supported** (#70): a real MUA (Thunderbird / Apple Mail) can send with attachments.
  The daemon maps the parsed MIME parts to `SendRequest.attachments` (base64 over JSON) and forwards them
  to `/api/send`, which hands them to the Cloudflare Email Sending binding. Limits: 20 parts and 25 MiB
  decoded total (the CF message cap); over that is rejected (`552`). The remaining v1 limitation is
  *fidelity*: every part is delivered with disposition `attachment`, so an inline image arrives as an
  attachment rather than rendered inline (cid). The bytes are always preserved, never a silent drop.
- **Bcc-only submission is rejected** (`550`): the worker requires at least one `To`; the daemon
  does not silently rewrite the visible header. A normal client always sets a `To`.

Both are documented follow-ups, not silent degrades.

### Config (relay)

`SUBMISSION_LISTENERS` (the `<addr>:<mode>` list) enables the daemon; `SUBMISSION_TLS_CERT` / `_KEY`
(required, AUTH is TLS-only, hot-reloaded), `SUBMISSION_HOSTNAME` (cosmetic greeting, default
`localhost`), `POSTERN_SEND_URL` + `POSTERN_SEND_TOKEN` (the send bridge, the mailbox API token), and
`AUTH_BACKEND` (`native` | `ldap` | `system`) with its backend-specific vars: native needs
`POSTERN_SMTP_AUTH_URL` + `POSTERN_TRANSPORT_TOKEN`; ldap needs `LDAP_URL` (+ template or search
vars); system needs `AUTH_SYSTEM_DOMAIN` and a `-tags pam` build. Unlike the loopback-only intake
listener, these listeners are AUTH-required, so binding them publicly is correct. See
`relay/skyphusion-email-relay.env.example` for every variable.

---

## 10. Envelope fidelity v2 (M8, #189)

The v1 model stores a single `to_addr` string, no Cc/Bcc/Sender/Reply-To, and dedups on
Message-ID alone. That minimalism is the common root of a live symptom family: IMAP ENVELOPE
returning NIL for Cc/Bcc/Sender/Reply-To, per-recipient copies of multi-recipient mail dropped
by the dedup (#178), and no stored record of the wire size (see the RFC822.SIZE rule in
10.3 for what "spec-true SIZE" actually means for a projection-serving door). v2 closes
the class. Everything below is ADDITIVE: old rows keep NULL in every new column and render
exactly as today; no data rewrite, no backfill.

### 10.1 The fidelity / semantics split

Two kinds of address data, kept deliberately separate:

- **Header fidelity columns** carry the RFC 5322 headers as they appeared on the wire
  (raw decoded header strings, display names and all; NEVER re-formatted, NEVER naively
  split -- a display name may contain a comma). These exist so ENVELOPE and human clients
  can render the truth.
- **Envelope semantics** carry who this message was actually DELIVERED to, as a normalized
  set of bare lower-cased addresses. This is what mailbox views filter on.

```sql
-- migration 0006 (additive ALTERs only; flows through the #112 gate, auto-applies)
ALTER TABLE messages ADD COLUMN delivered_to  TEXT;  -- semantics: ",a@x,b@y," normalized set
ALTER TABLE messages ADD COLUMN cc_addr       TEXT;  -- fidelity: raw Cc header
ALTER TABLE messages ADD COLUMN bcc_addr      TEXT;  -- fidelity: outbound only (see 10.4)
ALTER TABLE messages ADD COLUMN sender_addr   TEXT;  -- fidelity: raw Sender header
ALTER TABLE messages ADD COLUMN reply_to_addr TEXT;  -- fidelity: raw Reply-To header
ALTER TABLE messages ADD COLUMN wire_size     INTEGER; -- raw RFC822 byte size at intake
```

`to_addr` changes MEANING for new inbound rows: it becomes the raw decoded `To` HEADER
(fidelity), because `delivered_to` now owns the envelope role `to_addr` played in v1.
Outbound `to_addr` was already the header To list; unchanged. Old inbound rows keep the
single envelope address they were written with, which every consumer treats as both (the
`COALESCE` below).

`delivered_to` stores the set with LEADING AND TRAILING commas (`",a@x,b@y,"`) so
membership is one delimiter-safe predicate (`delivered_to LIKE '%,' || ? || ',%'`) with no
string surgery, and so the atomic append in 10.2 needs no edge-casing. Addresses in it are
bare and lower-cased; display names never enter this column.

### 10.2 Dedup v2: merge, not duplicate rows (#178)

CF Email Routing delivers a multi-recipient message once per envelope recipient, each
invocation carrying the same Message-ID. v1's `message_id UNIQUE` + `INSERT OR IGNORE`
stored the first and silently dropped the rest.

**`message_id` stays the unique message identity.** Everything keys on it (R2 attachment
keys, thread resolution, FTS rowids, Vectorize ids, the IMAP `uid`); one row per recipient
would fork that identity and duplicate body storage, search hits, and embeddings. Instead,
a dedup hit MERGES: the new envelope recipient is appended to the existing row's
`delivered_to`. One message, one row, N mailbox views -- which is what the mail actually is.

The merge is ONE atomic upsert, safe under CF's concurrent per-recipient invocations:

```sql
INSERT INTO messages (message_id, ..., delivered_to) VALUES (?, ..., ',' || ? || ',')
ON CONFLICT(message_id) DO UPDATE SET
  delivered_to = CASE
    WHEN COALESCE(delivered_to, ',' || to_addr || ',') LIKE '%,' || excluded_recipient || ',%'
      THEN delivered_to                                   -- retry/loop: true dedup, no-op
    ELSE COALESCE(delivered_to, ',' || to_addr || ',') || excluded_recipient || ','
  END;
```

(Illustrative; the real statement binds the bare recipient once. The `COALESCE(...,
to_addr)` arm seeds `delivered_to` from a v1 row's envelope address on its first merge, so
pre-0006 rows join the new world lazily and correctly.)

- `store.put()` returns `{ stored: false, merged: true, threadId }` on a merge;
  `{ stored: false, merged: false }` stays the true-dedup (retry/loop) result. Attachments,
  FTS, and Vectorize run ONLY on first insert (`stored: true`) -- a merge touches one column.
- The dedup KEY is effectively `(message_id, envelope recipient)`; the table constraint
  stays `message_id UNIQUE`, so NO core-table rebuild and no supervised window.
- Outbound is untouched: we generate our own Message-IDs; `mailbox` writes `delivered_to`
  complete at insert (10.4).

### 10.3 Read side: views filter on semantics, render fidelity

Every place that answers "mail for X" (the `to=` filter in `ListQuery`, `/api/messages`,
the IMAP account mapping) switches its predicate to:

```sql
COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || ? || ',%'
```

Old rows (NULL `delivered_to`) match on their v1 envelope `to_addr` exactly as today; new
rows match on the delivered set, so a message to `support@` AND `security@` appears in BOTH
views (the #178 acceptance). The rendered `to` field stays the fidelity column.

`StoredMessage` / `StoredMessageSummary` gain (all nullable; absent = old row = render as
today):

```ts
cc: string | null;           // messages.cc_addr        raw header
bcc: string | null;          // messages.bcc_addr       outbound only
sender: string | null;       // messages.sender_addr    raw header
replyTo: string | null;      // messages.reply_to_addr  raw header
deliveredTo: string[];       // parsed from messages.delivered_to; v1 fallback [to_addr]
wireSize: number | null;     // messages.wire_size
```

The IMAP proxy fills ENVELOPE Cc/Bcc/Sender/Reply-To from the fidelity fields (NIL when
NULL -- today's render, honest for old rows).

**RFC822.SIZE (corrected during M8 review; supersedes the first cut of this section).**
RFC 3501's SIZE is the size of the message AS THE SERVER SERVES IT: a client may validate
the BODY[] literal against an earlier SIZE, so the two MUST agree byte-for-byte. This
proxy serves a rendered projection as BODY[] (raw wire bytes are deliberately not stored,
section 10.7), therefore RFC822.SIZE stays the PROJECTED size -- self-consistent is what
spec-true means here. `wireSize` is stored fidelity for API consumers and diagnostics; it
becomes the IMAP SIZE only in a future milestone where FETCH itself is byte-exact (raw
blob storage). Serving `wireSize` against a projected body would make SIZE and the
literal disagree, which is the one combination that actually breaks clients.

### 10.4 Write side: who populates what

| field | inbound (in-Worker driver) | inbound (relay `/ingest`) | outbound (`mailbox`) |
|---|---|---|---|
| `to_addr` | raw To header (postal-mime), fallback envelope rcpt | `toHeader`, fallback `to` | joined To list (as v1) |
| `delivered_to` | envelope rcpt (`message.to`), merged per delivery | `to`, merged per delivery | full recipient set: to + cc + bcc, complete at insert |
| `cc_addr` | raw Cc header | `cc` | joined cc |
| `bcc_addr` | never (sender's secret, not on our wire) | never | joined bcc |
| `sender_addr` | raw Sender header | `sender` | never (we are the author) |
| `reply_to_addr` | raw Reply-To header | `replyTo` | replyTo when set |
| `wire_size` | raw message byte size | `rawSize` | NULL (CF builds the MIME; no wire size to know) |

Inbound `bcc_addr` is structurally NULL: a Bcc that reaches us was the sender's secret and
is not in our headers. Outbound `bcc_addr` is our own sent copy in our own store, same
privacy boundary as v1's stored body; the API exposes it only where the full message is
already exposed. Outbound `delivered_to` includes bcc recipients so "mail involving X"
views are complete for our own sent mail.

`ParsedInbound` gains optional fields (wire-compatible: an old relay simply omits them):

```ts
toHeader?: string;   // raw decoded To header; core stores it as to_addr when present
cc?: string;         // raw decoded Cc header
sender?: string;     // raw decoded Sender header
replyTo?: string;    // raw decoded Reply-To header
rawSize?: number;    // RFC822 wire byte size as received
```

`to` keeps its v1 meaning (THE delivered-to envelope recipient) so every existing driver
stays correct without changes.

**Reply routing (RFC 5322 fidelity):** `mailbox.reply()` routes to the stored message's
`reply_to_addr` when present, else `from` -- v1 always used `from`, which mis-routes replies
to any list or role mail that sets Reply-To. Still resolved from STORED state, never caller
input.

### 10.5 Intake keeps every MIME part (#184)

The relay's inbound intake (`buildParsedInbound`) carries only `env.Attachments`; the
submission path deliberately carries Attachments + Inlines + OtherParts so nothing is
silently dropped. The intake seam adopts the SAME mapping (one shared collector). An inline
image or multipart/related part arrives as a stored attachment part -- fidelity of BYTES is
the contract; inline (cid) RENDERING remains the tracked refinement it already is on the
submission side. The in-Worker driver already stores postal-mime's full attachment set.

### 10.6 Search direction (#128)

`/api/search` reads the `direction` query param (`inbound` | `outbound`, else
`E_VALIDATION_ERROR`), passing it into `store.search()` exactly as `/api/messages` already
does. Additive; the param was previously ignored.

### 10.7 What v2 deliberately does NOT do

- No recipients TABLE. The delimiter-set column + `LIKE` predicate serves every current
  view; a normalized table buys nothing until a per-recipient STATE (read/flagged per
  mailbox) exists, and it would fork the message identity today. Revisit only with that
  feature.
- No backfill/rewrite of old rows (NULLs render as today; `COALESCE` carries them), no
  destructive migration, no supervised window: 0006 is ALTER-ADD only.
- No raw-wire (RFC822 blob) storage. `wire_size` fixes SIZE honestly; storing full raw
  MIME is an R2-cost decision for a future milestone if byte-exact FETCH ever matters.


### 10.8 Substring search (#212, M9)

`mode=substr` serves IMAP `SEARCH` parity (#148). IMAP `SEARCH SUBJECT/BODY/TEXT` are
case-insensitive **substring** matches (RFC 3501); the default `fts` mode is FTS5
word-token matching and returns a DIFFERENT set (a token query cannot express a
substring: `foo` does not match `foobar`, and a multi-word query is OR-of-tokens, not
a contiguous phrase), so pushing IMAP `SEARCH` to `fts` would lose behavior and break
the RFC-as-source-of-truth rule. `substr` is the exact-substring predicate the IMAP
door pushes to.

Semantics (`field` selects the column, default `text`):

- `field=subject` -> `lower(subject) LIKE '%' || q || '%'`
- `field=body` -> `lower(body_text) LIKE '%' || q || '%'`
- `field=text` (default) -> the RFC 3501 `TEXT` key (header OR body). We implement the
  RFC semantics, NOT Twisted's body-only `search_TEXT` stub: declaring
  `ISearchableMailbox` means the door owns `search()` end to end, so it serves the spec,
  not the library bug. The predicate is a substring match, via `COALESCE(col,'')`, over
  every header column the store SERVES in the rendered projection UNION `body_text`:
  `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `sender_addr`,
  `reply_to_addr`, `message_id`, `in_reply_to`. Post-M8 these hold the RAW header
  fidelity (e.g. `from_addr`/`to_addr` carry display names), so a display-name substring
  IS matched. Same honesty frame as RFC822.SIZE (#207): `TEXT` searches exactly the
  headers `BODY[]` would render, never raw wire bytes we do not store; headers we never
  persist (`Received`, `X-*`, etc.) are not searchable, and that self-consistency IS the
  spec-true posture, not a gap.

The `direction` filter (`inbound` | `outbound`) applies exactly as for `fts` (10.6).

Rules:

- **`LIKE` metacharacters are escaped, BACKSLASH FIRST.** The predicate is
  `LIKE ? ESCAPE '\'`, so the escape character itself must be escaped before the
  wildcards, in this order: `\` -> `\\`, THEN `%` -> `\%`, THEN `_` -> `\_`. Doing
  `%`/`_` first would let a literal backslash in `q` corrupt the following escape.
  So `50%` and `a\b` match literally. `q` is a bound param (no injection).
- **ASCII-only case folding.** SQLite `LIKE` folds case for ASCII only, while the IMAP
  door's in-memory fallback uses full-Unicode `.lower()`. So the door pushes to `substr`
  ONLY for an ASCII query and FALLS BACK to the manual scan for a query containing
  non-ASCII, so a non-ASCII `SEARCH` is never served wrong. The split is the door's; the
  API contract is simply "ASCII case-insensitive substring".
- **Not indexed.** A leading-`%` `LIKE` cannot use an index: `substr` is a bounded table
  scan (same `limit` / cursor shape as `fts`). Acceptable at current mailbox sizes;
  documented here, not hidden.
- **Scope + errors.** `read` scope; `E_FIELD_MISSING` when `q` is empty;
  `E_VALIDATION_ERROR` for an unknown `field` or `direction`, matching the existing
  `/api/search` handler.

`SearchQuery` gains `mode: "substr"` and an optional `field: "subject" | "body" |
"text"` (default `text`; ignored by the other modes).

### 10.9 Recipient-relative views: viewer-relative INBOX + per-recipient seen (#350)

The store is ONE mailbox shared by many identities. Two facts that were row-global
become **viewer-relative** the moment a read carries a viewer address (`to=V`): which
direction-default view a message appears in, and whether it has been read. Both are
additive; a read with no `to` is the estate lens and behaves exactly as before. The
`message_id` stays the identity and `delivered_to` stays the semantics set (10.1);
nothing forks a message into per-recipient copies.

**Why:** a same-domain send (a@ALLOWED to b@ALLOWED) is stored ONCE, `direction=outbound`,
`messages.seen=1` (the sender Sent copy, 10.4). So every new-mail lens the recipient has
missed it: it is not `direction=inbound`, and it is not unseen. This is the fc#792 false
"relay ate the mail" report; no mail was ever lost, it was invisible to the recipient
lens. External recipients read through their own provider, never our lenses, so only
same-domain recipients are in scope.

**Viewer-relative INBOX (the direction lens).** `direction` stays the stored wire fact.
The READ predicate changes ONLY when a query is viewer-scoped (`to=V`) AND asks for
`direction=inbound`:

```sql
-- "INBOX for V" = mail delivered to V that V did not send
COALESCE(m.delivered_to, ',' || m.to_addr || ',') LIKE '%,' || :V || ',%'
AND (m.direction = 'inbound' OR (m.direction = 'outbound' AND lower(m.from_addr) <> :V))
```

Applied in ONE builder (`store.recipientWhere`) shared by `list`, `fts`, and `substr`
search. Sent stays sender-based (`from=V`), not `to=V`. Unscoped queries (no `to`) are
unchanged. **Edge (accepted, documented):** a true self-send (V to V only) stays
Sent-only for V, born seen; correct, you wrote it.

**Per-recipient seen (sparse override).** A new table (migration 0009):

```sql
CREATE TABLE message_seen_by (
  message_id TEXT NOT NULL,
  recipient  TEXT NOT NULL,   -- bare lower-cased address
  seen       INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient)
);
```

Effective seen for viewer V = `COALESCE(override(id, V), messages.seen)`. `messages.seen`
stays the row-level / legacy flag and the estate-lens truth. **No backfill:** an absent
override renders as today, so nothing historical floods a recipient unread count. This is
the per-mailbox state 10.7 named as the precondition for normalizing recipients; it
layers beside message identity, it does not fork it.

- **Write (seed):** a fresh same-domain outbound insert seeds `seen=0` overrides for
  every `delivered_to` recipient on `ALLOWED_FROM_DOMAIN` except the sender
  (`store.seedSameDomainSeen`). `messages.seen` stays 1 (Sent view unchanged). Inbound
  seeds nothing (`messages.seen=0` is already honest for all recipients).
- **Write (`POST /api/messages/seen`):** gains optional `for` (a bare address). With
  `for`: upsert the `(id, for)` override only, never touching `messages.seen`; unknown
  ids are skipped (as legacy). Without `for` (legacy callers): UPDATE `messages.seen`
  AND realign any EXISTING override rows for those ids, so the estate lens stays
  authoritative when used. Old callers keep working unchanged. `read`-scoped as before.
- **Read:** viewer-scoped `list`/`search` (`to=V`) render effective seen via the
  COALESCE join; unscoped reads render `messages.seen`. `/api/search` gains an optional
  `to=` mirroring `/api/messages` across ALL modes: `fts` and `substr` push the
  membership + effective-seen into SQL (the shared builder); `semantic` and `hybrid` are
  score-ranked and the vector index is not recipient-keyed, so they enforce `to=` by
  post-filtering the hydrated hits on delivered-set membership + the viewer-relative
  direction rule (and hydrate effective seen). No mode silently ignores `to=`.
- **Delete:** `deleteMessage` also purges `message_seen_by` rows for the id.

**IMAP door (as-shipped): a shared estate view, unchanged by #350.** The door is a
whole-estate shared mailbox (`INBOX` = `direction=inbound` with no `to=`; `Sent` =
`direction=outbound` with no `from=`; `All` = both), so it reads the estate lens and keeps
calling `POST /api/messages/seen` WITHOUT `for` (bit-identical to before #350). Concretely:
**the door's INBOX stays BLIND to same-domain sends** (they are `direction=outbound`, and
the door's INBOX has no viewer to trigger the viewer-relative predicate); such mail is
visible in the door's **Sent** and **All** folders. This is unchanged behavior, not a
regression #350 introduces. Per-recipient honesty lands in the viewer-scoped
API/webmail/MCP callers that pass `to=V`, which is where fc#792 actually lived.

**Per-account door mode (#357, opt-in).** The door gained a `POSTERN_IMAP_VIEWER_MODE`:
`estate` (default) is byte-identical to the above; `per_account` scopes each login to a
viewer address V derived from the authenticated username, turning the shared folders into
viewer lenses: INBOX = `to=V` + `direction=inbound` (the recipient predicate above, so it
now surfaces same-domain sends), Sent = `from=V` + `direction=outbound`, All = `to=V` both
directions (unwindowed). `\Seen` STOREs on the `to=V` lenses carry `for=V` (per-recipient
override); Sent keeps the estate flag, matching what a `from=V` read renders. This is a
VIEW tier (a deterrent), NOT a credential boundary: the door still reads with an
estate-wide token, so per-user privacy stays the later credential work (#351 / D-AUTH-2).
Flipping a live door bumps `POSTERN_IMAP_UIDVALIDITY` on the same roll (folder membership
changes; RFC 3501). See `imap/README.md`.

`/api/folders` unread counts (#352) MUST use effective seen when they land.
