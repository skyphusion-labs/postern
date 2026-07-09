# Vectorize reconcile / orphan-vector audit (#134)

Status: **read-only tooling of record** for the orphan-vector audit. The one-time
prune (section 6, option 1) **completed 2026-07-09** on the fleet index; the tool
remains the audit path for any future drift. This document is reproducible from itself
(ICD discipline): the id scheme,
the enumerability constraint, the report shape, and the prune options below were
verified read-only against the code in `inbound/src/store.ts` and the live
`@cloudflare/workers-types` `VectorizeIndex` surface.

## 1. The finding (recap)

The #130 backfill wrote 2,100 vectors covering all 1,861 current messages, but the
live index `skyphusion-mail-vec` settled at vectorCount 3,123. That leaves ~1,023
vectors with **no live message behind them** ("orphans"). Idempotency is proven (one
`store.ts embedAndUpsert` path, deterministic id), so these are **not duplicates** of
current messages. Two candidate roots:

- **(a) deleted-message orphans**: a message removed from the store with no Vectorize
  delete propagated.
- **(b) pre-#116 id scheme**: vectors written under an earlier id scheme that the
  unified `embedAndUpsert` id does not overwrite.

## 1a. Measured results (live audit, 2026-06-27)

Run read-only against the live `skyphusion-mail` D1 + `skyphusion-mail-vec` index via
`wrangler dev --remote` (the deployed worker stayed frozen; zero Workers-AI spend; the
index vectorCount was 3125 before and after, confirming nothing was mutated).

| metric | value |
| --- | --- |
| messages in D1 | 1864 |
| gated (indexable, `VECTORIZE_FOR=""`) | 1864 |
| expected vectors (current scheme) | 2103 |
| live vectors (`describe`) | 3125 |
| expected present (`getByIds` verify) | 2103 |
| expected MISSING (under-coverage) | **0** |
| **ORPHAN COUNT** | **1022** |
| cause determination | **(b)** pre-#116 id scheme |
| sample | 120 probes, 314 distinct orphans: causeB **314**, causeA **0**, unknown **0** |

Findings:

- **Orphan count is 1022** (3125 - 2103), matching the issue's ~1,023 estimate.
- **Coverage is complete:** all 2103 current-scheme vectors are present; zero
  under-coverage. The backfill did its job.
- **Cause is (b), decisively:** every one of the 314 distinct sampled orphans ties back
  to a STILL-LIVE message; **zero** deleted-message (a) orphans in the sample. This
  matches the grounded prediction (no delete path exists, so nothing produces (a)).
- **Two pre-#116 schemes** were identified in the orphan population, both carrying only
  `{date, from, subject}` metadata (no `message_id` / `chunk` / `direction`):
  1. **raw-message-id-as-vector-id** -- the vector id IS the message_id (e.g.
     `...review/4530171109@github.com`). All sampled instances are live messages.
  2. **bare 64-hex, no chunk suffix** -- a full-length hash id (vs the current 56-char
     prefix + `.chunk`). Not reproducible from any tested hash of the live message_id,
     but every sampled instance matches a live message by `(date, subject)`.

The orphans are overwhelmingly GitHub-notification mail re-indexed as the id scheme
evolved across the #116 epic; the old-scheme vectors were never overwritten because
their ids differ from the unified `base.chunk`.

## 1b. Prune completed (fleet, 2026-07-09)

Option 1 (full rebuild from D1) was executed against the live fleet store:

| step | outcome |
| --- | --- |
| new index | `skyphusion-mail-vec-v2` (768-dim, cosine) |
| backfill | 3762 messages, 4718 vectors (`reindex.mjs`, two passes) |
| binding flip | `skyphusion-email-inbound` VECTORIZE -> v2 |
| legacy index | `skyphusion-mail-vec` deleted (1022 orphans retired with it) |
| post-flip reconcile | 4718/4718 expected present, **0 orphans**, **0 missing** |

Hybrid semantic search (`mode=hybrid`) was live-verified immediately after the flip.
Issue **#134** is closed; this section is the durable record of the prune landing.

## 2. The id scheme (the contract the audit mirrors)

`embedAndUpsert` (`inbound/src/store.ts`) is the SINGLE vector-construction path for
both live ingest and the backfill. For a message it writes one vector per body chunk:

```
base      = sha256hex(message_id).slice(0, 56)     // 56 hex chars
vector id = `${base}.${chunkIndex}`                // base.0, base.1, ...
chunks    = chunkText(body, 1200, 150).slice(0, 24)  // CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNKS
```

`message_id` is stable: `store.put` dedups with `INSERT OR IGNORE ... message_id`, so a
message's vector ids never change. The reconcile audit recomputes this **exact** scheme
from D1 to derive the EXPECTED id set, and the conformance test
(`inbound/reconcile.test.ts`) asserts the recomputed ids equal the live ids.

The same VECTORIZE_FOR gate live ingest applies (`ingest.ts` ->
`store.shouldVectorize`) is applied when deriving the expected set, so gated-out mail
is not mis-counted.

## 3. CRITICAL CONSTRAINT: the orphan SET is not cleanly enumerable

The `VectorizeIndex` binding exposes **only**:

```
describe()       -> { vectorsCount }      // (legacy field; V2 binding: vectorCount)
query(vec, opts) -> { matches }           // similarity top-k, NOT enumeration
insert / upsert  -> mutate
getByIds(ids)    -> raw vectors for ids YOU already know
deleteByIds(ids) -> mutate
```

There is **no "list all vectors" / scan API.** Consequences:

- The orphan **COUNT** is exact and cheap: `describe().vectorsCount - presentExpected`,
  where `presentExpected` is the count of expected ids confirmed via `getByIds`.
- The orphan **SET** cannot be listed directly. `query()` only returns the top-k nearest
  to a probe vector; it can never guarantee it has surfaced every vector. So the orphan
  ids we CAN name come only from **sampling** (section 4), and that set is, by
  construction, **partial**. The report carries `enumerable: false` to make this honest.

This is the answer to the dispatch's "investigate first": **we have the exact count and a
sampled, partial set, but not a clean, complete, listable orphan id set.** Section 6
lists the viable durable options for getting a complete, deletable target.

## 4. What the reconcile tool does (read-only)

`store.reconcile(env, opts)`, exposed at `POST /api/admin/reconcile` (admin / both-scoped,
#85), driven by `inbound/reconcile.mjs`:

1. **Enumerate expected.** When `vector_ledger` has rows (#279), read that set directly
   (O(ledger), no full D1 re-derive). Otherwise page D1 (`pageForReindex`), apply the
   vectorize gate, and compute `base.0..base.(n-1)` ids. Always compute `computedVectors`
   from D1 for drift (`ledgerDrift = computed - ledger`). Yields `expectedVectors`,
   `expectedSource` (`ledger` | `computed`), and still-live `message_id`s for sampling.
2. **Read live count.** `describe()` -> `liveVectorCount`.
3. **Verify presence.** `getByIds` over the expected ids (batched at the live cap of
   **20 ids/call** -- `VECTOR_GET_ERROR 40007` above that -- and bounded-parallel so a
   full-size index finishes inside the request wall-clock) -> `presentExpected` +
   `missingExpected`. Missing expected ids are **under-coverage** (a distinct bug from
   orphans) and are surfaced separately.
4. **Headline.** `orphanCount = liveVectorCount - (verified ? presentExpected : expectedVectors)`.
5. **Cause sampling.** Take up to `sampleSize` live vectors, pull their VALUES via
   `getByIds` (no new embeddings -> **zero Workers-AI spend**), and `query` each with
   `topK=20` (Vectorize caps topK at 20 when `returnMetadata="all"`). Every returned id
   not in the expected set is an orphan; classify it by EVERY linkage it exposes, since
   the old schemes carry neither the unified id nor a `message_id` field:
   - `metadata.message_id` in D1, OR the vector id itself is a live message_id, OR the
     `(date, subject)` metadata matches a live message -> **cause (b)** (still-live).
   - a `message_id` or `(date, subject)` that is NOT in D1 -> **cause (a)** (deleted).
   - no usable linkage at all -> `unknown`.
   `causeDetermination` is `a` / `b` / `mixed` / `indeterminate` from the sample. (The
   first live run returned `indeterminate` because the old vectors lack `message_id`;
   the multi-signal classifier above fixed that -> `b`.)

The whole pass uses D1 + Vectorize `describe`/`getByIds`/`query` only. **It never calls
`deleteByIds`.** Nothing is mutated; the conformance test pins index-unchanged.

### Report shape (`ReconcileResult`)

```
messages, gatedMessages, expectedVectors, expectedSource, ledgerVectors, computedVectors, ledgerDrift,
liveVectorCount, verified, presentExpected, missingExpected, missingExpectedSample,
orphanCount, enumerable: false,
sample: { probes, matchesInspected, distinctOrphans, causeA, causeB, unknown, orphanIds },
causeDetermination, note
```

**Backfill the ledger on an existing store:** run `POST /api/admin/reindex` (not dry-run)
once after migration `0008_vector_ledger`; every page calls `embedAndUpsert`, which syncs
`vector_ledger` rows. Until then reconcile uses the computed D1 path (`expectedSource:
computed`).

### Running it

```
POSTERN_API_BASE=https://postern.skyphusion.org POSTERN_API_TOKEN=<both-scoped> \
  node inbound/reconcile.mjs [--no-verify] [--sample N] [--ids] [--json]
```

A custom `user-agent` is sent (the CF WAF 403s a default node/undici UA on this estate).

## 5. Likely cause, grounded in the code

There is **no message-delete path anywhere in Postern today**:

- the IMAP layer is **strictly read-only** -- `posternimap` `expunge()` / `store` /
  `destroy` all raise `ReadOnlyError`;
- there is **no `DELETE FROM messages`** in the worker (only `smtp_credentials` deletes).

So messages are not being removed through any live application path, which means the
orphan population is **static, not regrowing**, and cause (a) -- if present -- comes from
a one-time historical event (e.g. a manual D1 prune / re-seed during the #116 epic), not
an ongoing leak. With `message_id` stable, the standing hypothesis was that the bulk are **cause (b)**
pre-#116-scheme vectors for still-live messages. **The live audit confirmed it: 314/314
sampled orphans are cause (b), zero cause (a)** (section 1a).

## 6. Prune plan (option 1 executed on fleet, 2026-07-09)

The live audit (section 1a) confirmed the orphans are cause (b): stale-id vectors for
messages that are STILL in D1. A **full rebuild from D1 (option 1)** is the clean fix:
it re-keys every live message under the unified `base.chunk` scheme and carries none of
the old-scheme ids across, so the orphan class disappears in one pass. **Fleet executed
this on 2026-07-09** (section 1b). The steps below remain the operator playbook for
any other account that inherits the pre-#116 orphan class.

Because the orphan SET is not cleanly enumerable, "list the orphans then delete them" is
**not** safely complete. Options, in recommended order:

1. **Full rebuild from D1 (recommended to clear the existing cruft).** Create a fresh
   Vectorize index, backfill from D1 via the proven idempotent `reindex` path, cut the
   binding over (wrangler), then delete the old index. This sidesteps enumeration
   entirely -- you never need the orphan ids, you simply don't carry them over -- and
   provably leaves ONLY live-message vectors. Cost: one full re-embed (Workers-AI spend,
   same as #130). Downtime: none if the new index is built before the binding flips.
2. **Sampled targeted delete (only for confirmed cause (b) with exact ids).** When the
   sample surfaces a concrete old-scheme id whose `message_id` is live, that id is
   individually, safely deletable by `deleteByIds`. This can chip away at known orphans
   but, being sample-bound, **cannot prove completeness** -- so it is a supplement, not a
   substitute for option 1.
3. **Id-ledger going forward (durable anti-regrowth, not a fix for existing cruft).**
   Maintain a D1 table of `(message_id, vector_id)` written alongside `embedAndUpsert`.
   Once it exists, the index id set becomes enumerable from our own ledger, so future
   reconciles can diff exactly. It does **not** know about the pre-existing ~1,023
   orphans (they predate it), so it complements, not replaces, option 1.

Whichever path: run it supervised, after a reconcile dry-run report is signed off.
On the fleet store, option 1 landed 2026-07-09 and #134 is closed.

## 7. Delete-tombstone (#278)

`store.deleteMessage()` and `DELETE /api/messages/{messageId}` (admin-scoped) hard-delete
the D1 row, attachment metadata, R2 bytes, `vector_ledger` rows, and call
`VECTORIZE.deleteByIds` for the message's chunk-vectors (ledger ids when present, else
computed from `body_text`). This is bundled so cause (a) orphans cannot regrow after a
delete. IMAP `\Deleted`/EXPUNGE mapping is a follow-on (#278).
