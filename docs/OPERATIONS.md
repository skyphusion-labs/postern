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
| Per-recipient read state, drafts, folder placement, UID counters, webmail sessions | D1 `postern`, tables `message_seen_by`, `drafts`, `draft_attachments`, `mailbox_placement`, `mailbox_uid_counter`, `webmail_sessions` | **DURABLE** | Same-domain unread state, in-progress drafts, and Archive/Trash/Junk placement are gone; losing `mailbox_uid_counter` is a UIDVALIDITY-class event (RFC 3501) since a restore without it reissues folder UIDs from scratch, so an IMAP client must be told (bump UIDVALIDITY) to discard its cache instead of trusting stale UIDs |
| Attachment bytes | R2 bucket `postern-attachments` | **DURABLE** | Gone unless backed up; `attachments.r2_key` rows would dangle |
| Full-text search index | D1 virtual table `messages_fts` | Derived | Rebuilt from `messages` by the FTS triggers (see restore) |
| Vectorize embeddings | Vectorize index | Derived | Rebuilt from D1 via `POST /api/admin/reindex` |
| Worker config + bindings | `inbound/wrangler.jsonc` (+ the operator `wrangler.ci.json`) | **DURABLE** | Keep it in your own git / secret store |
| Worker secrets (`POSTERN_API_TOKEN`, scoped tokens) | `wrangler secret` / CF secret store | **DURABLE** | Not exportable; keep your own copy |
| Per-identity registry (`POSTERN_SEND_IDENTITIES`) | Worker **var** (hashes only; in deploy config) | **DURABLE** | Readable + mergeable; keep in your git / deploy config (#335) |
| Delegation grants (#740 S1) | D1 `postern`, table `delegation_grants` | **DURABLE** | Every grant is gone; once S2 to S4 enforce them, every delegated agent loses its delegated reach until re-granted |
| Runtime agent identities + audit log (#801) | D1 `postern`, tables `agent_identities` (token hashes only), `audit_log` | **DURABLE** | Every runtime-minted agent token stops resolving (401) and must be re-minted; the record of who minted, listed and revoked what is gone |

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
  --table message_seen_by --table drafts --table draft_attachments \
  --table mailbox_placement --table mailbox_uid_counter --table webmail_sessions \
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
- **After an embed recipe change** (for example #813, `EMBED_VERSION` 2): `POST
  /api/admin/reconcile` reports `staleEmbedMessages`; re-embed only those with
  `node inbound/reindex.mjs --stale-only` (dry-run first for the vector count). Search
  keeps working during the re-embed: an older vector is still a valid body embedding.
- **Verify:** run `inbound/smoke.mjs` (DEPLOY.md section 2). A green run means the
  store reads, sends, threads, and searches again.

This drill was validated locally: a scoped `--no-schema` export loaded into a
fresh `schema.sql` store returns every message, and a full-text query matches,
because the triggers repopulate `messages_fts` as the rows are inserted.

## 4. Monitoring

Postern exposes an un-gated health endpoint and structured Worker logs. Watch it
from outside (an uptime checker) and from inside (logs + capacity).

### 4.1 Uptime probe (outside-in)

`GET /health` is **not** token-gated and returns
`{"ok":true,"service":"postern","version":"1.4.5"}`. `version` mirrors
`inbound/package.json` (single-sourced in `inbound/src/version.ts`, guarded by a
test against drift), so "confirm the live Worker version" after a release is a
`curl` away instead of trusting a green pipeline. Point any uptime checker at
`/health`. `GET /` is a public HTML landing (links to `/webmail`); do not use
the root path as a JSON probe.

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

## 5. Projection version after a renderer bump

When `PROJECTION_VERSION` in the worker changes, every cached `projected_size` is
stale until backfilled. The IMAP door ignores a cached size whose stored version
does not match its renderer, so pre-existing rows become live hydrates until the
sweep finishes. Full contract: [CONTRACT.md](CONTRACT.md) section 10.3.

```bash
# Authoritative census: how many rows are still not at the live version (#520).
# Needs an admin/both token. No writes.
curl -fsS -X POST https://mail.example.com/api/admin/reproject \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"countOnly":true}'
# -> { ok, countOnly, total, atCurrent, notCurrent, projectionVersion }

# Dry-run sweep (default), then write:
cd inbound
node scripts/reproject-sweep.mjs              # reports would-update
node scripts/reproject-sweep.mjs --yes        # writes; FATALs if census still notCurrent
```

Trust `notCurrent` from `countOnly` over the runner's paging start/end totals when
closing a projection window. A green walk with residual `notCurrent` is not done.

## 6. Failure modes worth watching

- **Email Routing disabled or misrouted.** Inbound delivery just stops; the send
  probe stays green while no new mail arrives. Watch the inbound arrival rate and
  keep an inbound canary (4.3). Confirm the routing rule still points every
  address at the worker (the installer does this; by hand, DEPLOY.md Appendix A3).
- **Quota exhaustion.** D1 storage/rows, R2 storage, and Workers request limits
  are all finite; outbound send needs the Workers Paid plan. Watch
  `wrangler d1 info` and the dashboard analytics; a store that stops accepting
  writes looks like dropped mail.
- **Token revocation or rotation.** Rotating `POSTERN_API_TOKEN` makes every
  client (webmail, IMAP proxy, relay, MCP, the smoke) `401` until each is updated.
  Rotate deliberately and update every consumer in the same change.
- **Backups that block.** A running `d1 export` blocks other database requests;
  schedule it off-peak so a backup never looks like an outage.

## 7. Measuring the live semantic ranking (#950)

The offline recall eval (`inbound/eval/`) ranks with exact cosine kNN. Vectorize is an
approximate index, so the eval cannot see where a live query loses a message.
`GET /api/admin/search-debug` reads the live ranking for one query. It is OFF by default:
the route answers 404 until the deploy sets `SEARCH_DEBUG=1`. A query plus the ids that
match it is a content oracle over the whole mailbox, so turn it on for a measurement
window only, then remove the var and redeploy.

```bash
# Needs the operator (both) token. The admin-only slot is refused (403): it cannot read mail.
curl -fsS -G https://mail.example.com/api/admin/search-debug \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" \
  --data-urlencode "q=<the probe query>" \
  --data-urlencode "gold=<the Message-ID the probe should find>" \
  --data-urlencode "mode=semantic" --data-urlencode "limit=10"
```

Read `gold.verdict` first:

- `in-raw`: Vectorize returned the gold. Any miss happened after it: compare
  `gold.chunks[].rawRank` with `gold.fusedRank` (null = scope, the family tiebreak or the
  collapse dropped or folded it; check `fused[].similarCount`).
- `ann-miss`: the gold's exact cosine is above `floorExact`, the lowest EXACT score among
  the vectors Vectorize returned, yet Vectorize left it out. The approximate index lost a
  true neighbour.
- `outranked`: the gold's exact cosine is at or below `floorExact`. Every returned vector
  beats it on the exact scale: the embedding ranks it too low, or the crowd is too big.
- `not-in-short-result`, `not-indexed`, `vectors-missing`: fewer than topK came back, no
  ledger rows exist, or the ledger names vectors the index no longer holds. `unscored`: a full
  list, but no returned vector could be scored exactly.
- `not-yet-queryable` (#963): Vectorize has not processed the gold's upsert yet. Vectorize
  mutations are asynchronous: the ledger records the upsert's `mutationId` and when it
  returned (`upserted_ms`, migration 0025), and `describe()` says how far the index has
  processed (`processedUpToDatetime`). It is read after `in-raw` and `not-indexed` and before
  the others, so a fresh message is never reported as lost. A ledger row from before 0025, or a
  binding with no processing point, concludes nothing from the clock (`gold.pending` is null).

Every answer also carries `index` (`processedUpToMs`, `processedUpToMutation`, `vectorCount`)
and `serverNowMs` (the Worker's clock, the one `upsertedMs` was read with).

**The two scales.** The search queries Vectorize without `returnValues`, so Vectorize scores
APPROXIMATELY ([query vectors](https://developers.cloudflare.com/vectorize/best-practices/query-vectors/),
read 2026-11-13). On 2026-11-13 the production gap was 0.10 to 0.11. So every `raw` row
carries `score` (Vectorize, approximate) and `exact` (recomputed from its stored vector), and
every verdict compares exact with exact. `floorScore` is the approximate K-th score, for
reference only. `approxError` (`n`, `max`, `median`) and `scoreCheck` (rank 1) report the gap.
They are measurements, not a trust gate. `gold.exactRankInRaw` is where exact scores would
place the gold among the returned messages. The `fused` page comes from the same Vectorize
call as `raw`, not a second query.

Semantic search always asks Vectorize for the ceiling (topK 50), and slices to `limit` only
after the family tiebreak and the collapse (`hasPostRetrievalFilter`, the #813 clause). So
`limit` changes the `fused` page, not the `raw` pool.

For #950 the operator runs the probe set, not single calls:
`POSTERN_URL=... POSTERN_TOKEN=<both token> node inbound/eval/debug950.mjs --json`. It picks the
probes, makes every call, and prints counts, ranks, cosines and verdicts only. It needs a
deploy whose route gives `floorExact`; against an older route it says INSTRUMENT NOT TRUSTED.

To probe named messages (#963), put their Message-IDs in a file only you can read, and pass it:

```bash
printf '%s' '["<the first Message-ID>", "<the second>"]' > gold.json && chmod 600 gold.json
POSTERN_URL=... POSTERN_TOKEN=<both token> node inbound/eval/debug950.mjs --gold-file gold.json --json
```

The driver refuses a gold file that group or others can read. Each gold's own subject is its
query. The output adds `found0`/`strict0` (semantic search with `collapse=0`). Never commit the
file: a Message-ID names a real message.

To measure how long fresh mail takes to become findable in semantic search (#963), run the
passive driver for the window. It sends no mail; it follows each message that arrives after it
starts until semantic search finds it:

```bash
POSTERN_URL=... POSTERN_TOKEN=<both token> node inbound/eval/fresh963.mjs --minutes 30 --json
```

It prints counts and seconds only, on the Worker's clock: `processedS` (upsert to the index
processing past it) and `foundS` (upsert to FOUND), with p50, p95, max and the decision row
fixed in the #963 design (at least 10 messages).

Count the audit rows of a window (D1, the store database). The time column is `at`, an ISO
8601 UTC string:

```sql
SELECT outcome, COUNT(*) FROM audit_log
WHERE action = 'search.debug' AND at >= '<arm time, e.g. 2026-11-13T12:30:00Z>'
GROUP BY outcome;
```

`ok` counts the calls the route answered. `refused` counts admin-slot calls (403). A 404
(unarmed) writes no row.
