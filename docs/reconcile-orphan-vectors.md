# Vectorize reconcile / orphan-vector audit (#134)

Status: **read-only tooling of record** for the orphan-vector audit. The prune itself
is **not implemented here**: it is a separate, Conrad-supervised, gated step (see
section 6). This document is reproducible from itself (ICD discipline): the id scheme,
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

1. **Enumerate expected.** Page D1 (`pageForReindex`), apply the vectorize gate, and for
   each gated, non-empty message compute its `base.0..base.(n-1)` ids. Yields
   `expectedVectors` and the set of still-live `message_id`s.
2. **Read live count.** `describe()` -> `liveVectorCount`.
3. **Verify presence.** `getByIds` over the expected ids (batched 100/call) ->
   `presentExpected` + `missingExpected`. Missing expected ids are **under-coverage** (a
   distinct bug from orphans) and are surfaced separately.
4. **Headline.** `orphanCount = liveVectorCount - (verified ? presentExpected : expectedVectors)`.
5. **Cause sampling.** Take up to `sampleSize` live vectors, pull their VALUES via
   `getByIds` (no new embeddings -> **zero Workers-AI spend**), and `query` each with a
   high topK. Every returned id not in the expected set is an orphan; classify it:
   - `metadata.message_id` **present in D1**  -> **cause (b)** (live message, stale id).
   - `metadata.message_id` **absent from D1**  -> **cause (a)** (deleted-message orphan).
   - no usable `message_id`                   -> `unknown`.
   `causeDetermination` is `a` / `b` / `mixed` / `indeterminate` from the sample.

The whole pass uses D1 + Vectorize `describe`/`getByIds`/`query` only. **It never calls
`deleteByIds`.** Nothing is mutated; the conformance test pins index-unchanged.

### Report shape (`ReconcileResult`)

```
messages, gatedMessages, expectedVectors,
liveVectorCount, verified, presentExpected, missingExpected, missingExpectedSample,
orphanCount, enumerable: false,
sample: { probes, matchesInspected, distinctOrphans, causeA, causeB, unknown, orphanIds },
causeDetermination, note
```

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
an ongoing leak. With `message_id` stable, the standing hypothesis is that the bulk are
**cause (b)** pre-#116-scheme vectors for still-live messages. The reconcile **sample**
settles the actual a-vs-b split empirically; run it before deciding the prune target.

## 6. Proposed prune plan (NOT implemented; Conrad-supervised, gated)

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

Whichever path: it runs **with Conrad watching**, after a reconcile dry-run report is
signed off, and is **out of scope for this PR**. #134 stays open until the prune lands.

## 7. Delete-tombstone assessment (#134 item 4)

A delete-tombstone path (propagate a mailbox delete -> `VECTORIZE.deleteByIds`) is the
correct durable guard so the orphan set cannot regrow **once a delete path exists**. It is
**not needed today**: there is no message-delete path (IMAP read-only; no worker
`DELETE FROM messages`), so nothing is currently orphaning vectors. The recommendation is
to wire the tombstone **in tandem with** any future feature that deletes a message (IMAP
write mode, a webmail/API delete, a retention job): the deleting code computes the
message's `base.0..base.(n-1)` ids (same scheme) and calls `deleteByIds`. Building it
ahead of any delete path would be dead code; building it after, but separately from, the
delete path would reintroduce exactly this orphan class. So: **bundle the tombstone with
the delete path, not before, not after.**
