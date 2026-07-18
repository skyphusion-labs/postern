# Operating Postern: backup, restore, and monitoring

Running a mailbox means owning its durability. This guide is for a **self-hoster
on their own Cloudflare account**: how to back the mailbox up, restore it into a
fresh store, and watch that it stays alive. It assumes the clean install in
[DEPLOY.md](../DEPLOY.md) is done. Every command here is generic; substitute your
own database name, bucket, hostname, and token. Examples use `example.com`
(RFC 2606) and `mail.example.com`.

## 1. What is durable, and what is derived

Back up the durable state; the derived state you can always rebuild.

| State | Where | Durable? | If lost |
|---|---|---|---|
| Messages (headers, bodies, flags, threads) | D1 `postern`, table `messages` (+ `attachments`, `smtp_credentials`, `vector_ledger`) | **DURABLE** | Gone unless backed up |
| Attachment bytes | R2 bucket `postern-attachments` | **DURABLE** | Gone unless backed up; `attachments.r2_key` rows would dangle |
| Full-text search index | D1 virtual table `messages_fts` | Derived | Rebuilt from `messages` by the FTS triggers (see restore) |
| Vectorize embeddings | Vectorize index | Derived | Rebuilt from D1 via `POST /api/admin/reindex` |
| Worker config + bindings | `inbound/wrangler.jsonc` (+ the operator `wrangler.ci.json`) | **DURABLE** | Keep it in your own git / secret store |
| Worker secrets (`POSTERN_API_TOKEN`, send registry) | `wrangler secret` / CF secret store | **DURABLE** | Not exportable; keep your own copy |

The FTS index and the Vectorize embeddings are the only things you never back up:
both are a function of the message rows, and both are rebuilt on restore.

## 2. Backup

### 2.1 D1 message store

`wrangler d1 export` does not support databases that contain virtual tables, and
Postern's store has one (`messages_fts`, an FTS5 index). The official guidance is
to exclude the virtual table and recreate it afterward
(https://developers.cloudflare.com/d1/best-practices/import-export-data/). So
export the base tables only, as **data** (the schema lives in the repo, in
`inbound/schema.sql`):

```bash
cd inbound
npx wrangler d1 export postern --remote \
  --no-schema \
  --table messages --table attachments \
  --table smtp_credentials --table vector_ledger \
  --output postern-data-$(date +%Y%m%d-%H%M).sql
```

Store the `.sql` file off Cloudflare (your own encrypted backup location). Run it
on a schedule that matches how much mail you can afford to re-receive (daily is a
sane default for a personal mailbox). A running export **blocks other database
requests**, so prefer a low-traffic window.

`vector_ledger` is included because it is cheap and lets a restore skip a full
reindex; it is still derivable, so dropping it from the list is harmless.

### 2.2 Time Travel (point-in-time, in place)

D1 Time Travel is **always on**; you do not enable it. It restores the *same*
database to any minute within the retention window: **30 days on Workers Paid, 7
days on the Free plan**
(https://developers.cloudflare.com/d1/reference/time-travel/).

```bash
npx wrangler d1 time-travel info postern                       # current bookmark
npx wrangler d1 time-travel restore postern --timestamp=UNIX   # or --bookmark=ID
```

Time Travel is the fast fix for a bad write or an accidental delete. It is **not**
a substitute for the export in 2.1: it lives inside the same D1 database and the
same account, so it does not protect against account loss, a deleted database, or
a need to move providers. Keep both.

### 2.3 R2 attachment bytes

Attachment bytes are the one thing that is **not** rebuildable; if the bucket is
lost, the `attachments` rows in D1 point at objects that no longer exist. The
`wrangler r2 object` commands act on a single object at a time, so back up the
whole bucket with an S3-compatible client against the R2 S3 API (for example
`rclone sync` or `aws s3 sync` pointed at your account's R2 endpoint). Set a
retention/expiry policy with lifecycle rules:

```bash
npx wrangler r2 bucket lifecycle list postern-attachments
npx wrangler r2 bucket lifecycle add postern-attachments   # follow the prompts
```

### 2.4 Config and secrets

`inbound/wrangler.jsonc` (and, if you deploy with the operator secret, the
materialized `wrangler.ci.json`) is durable config: keep it in your own version
control. Worker **secrets cannot be exported**; keep your own copy of
`POSTERN_API_TOKEN` and any send-registry tokens in an encrypted store, because a
restored worker needs them re-set with `wrangler secret put`.

## 3. Restore (disaster-recovery drill)

Restoring into a **fresh, empty** D1 (do not restore over a store that still has
the tables; the CREATE statements collide). Order matters:

```bash
cd inbound

# 1. New store, and paste the printed database_id into wrangler.jsonc.
npx wrangler d1 create postern
npx wrangler r2 bucket create postern-attachments

# 2. Build the full schema FIRST. This creates messages_fts and the FTS sync
#    triggers, so the data load in step 3 repopulates search automatically.
npx wrangler d1 execute postern --remote --file=schema.sql

# 3. Load the message data. Each INSERT fires the AFTER INSERT trigger, so
#    messages_fts is rebuilt as the rows land (no manual rebuild needed).
npx wrangler d1 execute postern --remote --file=postern-data-YYYYMMDD-HHMM.sql

# 4. Baseline-seed d1_migrations so CI sees the schema as already applied and does
#    not re-run migrations (the same step as a schema.sql install; see DEPLOY.md
#    "CI deploy and D1 migrations").
```

Then finish the store and the worker:

- **Attachments:** restore the R2 bucket from your S3-side backup (`rclone sync`
  the other direction) so every `attachments.r2_key` resolves again.
- **Secrets + deploy:** `npx wrangler secret put POSTERN_API_TOKEN` (and any send
  tokens), then `npm run deploy`.
- **Vectorize (optional):** if you use semantic search, rebuild the index with
  `POST /api/admin/reindex` (admin-scoped token).
- **Verify:** run `inbound/smoke.mjs` (DEPLOY.md section 4). A green run means the
  store reads, sends, threads, and searches again.

This drill was validated locally: a scoped `--no-schema` export loaded into a
fresh `schema.sql` store returns every message, and a full-text query matches,
because the triggers repopulate `messages_fts` as the rows are inserted.

## 4. Monitoring

Postern exposes an un-gated health endpoint and structured Worker logs. Watch it
from outside (an uptime checker) and from inside (logs + capacity).

### 4.1 Uptime probe (outside-in)

`GET /` and `GET /health` are **not** token-gated and return `{"ok":true,
"service":"postern"}`. Point any uptime checker at it:

```bash
curl -fsS https://mail.example.com/health
```

### 4.2 Store-and-auth liveness

An authed read proves the store and the token gate are both healthy:

```bash
curl -fsS https://mail.example.com/api/messages?limit=1 \
  -H "Authorization: Bearer $POSTERN_API_TOKEN"     # 200 + items[]; 401 if the token is wrong
```

### 4.3 End-to-end send-and-expect

The strongest signal is a real round trip, exactly what `inbound/smoke.mjs`
asserts: `POST /api/send` a marker message, then poll
`GET /api/messages?direction=outbound` until the marker appears. Run the smoke on
a schedule (its outbound leg needs no real inbound mail) and alert if it fails or
times out. For an **inbound** canary, deliver a message to a watched address and
poll `GET /api/search?q=` for it (`smoke.mjs --expect-inbound`).

### 4.4 Logs and capacity (inside)

Observability is enabled in `inbound/wrangler.jsonc`
(`"observability": { "enabled": true }`), so requests and `console` output are
retained and searchable in the dashboard. Tail them live:

```bash
npx wrangler tail postern            # use your real deployed script name
npx wrangler d1 info postern         # database size + state, to watch quota headroom
```

## 5. Failure modes worth watching

- **Email Routing disabled or misrouted.** Inbound delivery just stops; the send
  probe stays green while no new mail arrives. Watch the inbound arrival rate and
  keep an inbound canary (4.3). Confirm the routing rule still points every
  address at the worker (DEPLOY.md section 3).
- **Quota exhaustion.** D1 storage/rows, R2 storage, and Workers request limits
  are all finite; outbound send needs the Workers Paid plan. Watch
  `wrangler d1 info` and the dashboard analytics; a store that stops accepting
  writes looks like dropped mail.
- **Token revocation or rotation.** Rotating `POSTERN_API_TOKEN` makes every
  client (webmail, IMAP proxy, relay, MCP, the smoke) `401` until each is updated.
  Rotate deliberately and update every consumer in the same change.
- **Backups that block.** A running `d1 export` blocks other database requests;
  schedule it off-peak so a backup never looks like an outage.
