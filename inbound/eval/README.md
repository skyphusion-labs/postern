# Semantic recall eval (#813)

This eval measures recall at k for semantic and hybrid search, before and after the #813 changes. It runs postern's real search code, so the numbers describe what ships. It is not part of `npm test`.

| file | what it does |
|---|---|
| `corpus813.mjs` | Builds a deterministic mailbox: 300 synthetic messages and 98 queries with gold ids. The same seed gives the same corpus. |
| `embed813.mjs` | Embeds every text the eval needs with the real model (`@cf/baai/bge-base-en-v1.5`, Workers AI REST) into a JSON cache keyed by sha256 of the text. It fetches only what is missing. |
| `recall813.eval.mjs` | For each variant: builds a fresh real-sqlite postern, stores the corpus through `store.put`, fills an in-memory index with the cached vectors, and runs every query through `store.search`. |
| `vitest.eval.config.ts` | The only config that runs the eval. |
| `replay813.mjs` | The live replay for an operator: the issue's known-item probe against a real deploy. It is read-only, and its summary prints counts and latencies, not mail content. |

## Run

From `inbound/`:

```sh
# 1. Embed (needs a Workers AI read token; about 18k tokens for this corpus, inside the free tier)
CLOUDFLARE_ACCOUNT_ID=... CF_WORKERS_AI_TOKEN=... EVAL_CACHE=/path/embeddings.json node eval/embed813.mjs
# 2. Measure
EVAL_CACHE=/path/embeddings.json EVAL_OUT=/path/out npx vitest run --config eval/vitest.eval.config.ts
```

## The corpus and the query families

**Corpus.** 300 messages:

- Templated notifications that differ only in a hash, an id or a number: 120 CI run failures over 3 jobs, 40 PR check failures, 40 orders shipped, 30 sign-in alerts.
- 25 short human mails whose subject carries the meaning.
- 15 three-message human threads.

**Query families.**

| family | the query | the gold |
|---|---|---|
| `token` (26) | a known item by its distinguishing token (commit hash, PR number, order number) | that item |
| `latest` (4) | the exact subject a whole family shares | its newest member |
| `subject` (25) | a short mail's exact subject | that mail |
| `paraphrase` (40) | a reworded question | the short mail, or any message of the thread |
| `diversity` (3) | a broad question several families answer | scored as the share of those families present in the top 10 |

**Metrics.** Recall at 1, 5 and 10 (strict: the gold id is a hit itself), and MRR over every single-gold query.

## Result (2026-11-11, with #926)

| variant | mode | token r@1 / r@10 | latest r@1 / r@10 | subject r@1 / r@10 | paraphrase r@1 / r@5 / r@10 | diversity coverage@10 | MRR (all single-gold) | distinct threads@10, paraphrase |
|---|---|---|---|---|---|---|---|---|
| V0 today (body only, no tiebreak) | semantic | 85% / 100% | 0% / 50% | 32% / 56% | 35% / 70% / 78% | 44% | 0.556 | 9.25 |
| V0 today (body only, no tiebreak) | hybrid | 100% / 100% | 50% / 100% | 100% / 100% | 35% / 70% / 78% | 44% | 0.771 | 9.25 |
| V1 + subject in chunk 0 | semantic | 85% / 100% | 0% / 0% | 100% / 100% | 88% / 100% / 100% | 39% | 0.902 | 8.00 |
| V1 + subject in chunk 0 | hybrid | 100% / 100% | 0% / 100% | 100% / 100% | 88% / 100% / 100% | 39% | 0.942 | 8.00 |
| V2 + family tiebreak | semantic | 100% / 100% | 75% / 75% | 100% / 100% | 88% / 100% / 100% | 39% | 0.960 | 8.00 |
| V2 + family tiebreak | hybrid | 100% / 100% | 75% / 100% | 100% / 100% | 88% / 100% / 100% | 39% | 0.962 | 8.00 |
| V3 + collapse | semantic | 100% / 100% | 75% / 75% | 100% / 100% | 88% / 100% / 100% | 69% | 0.960 | 8.25 |
| V4 + thread collapse | semantic | 100% / 100% | 75% / 75% | 100% / 100% | 88% / 100% / 100% | 69% | 0.960 | 9.75 |

What ships: semantic is V3 (collapse on by default, `collapseThreads` off), and hybrid is V2.

**#926 thread collapse (V4).** V4 against V3: every recall family is equal, and distinct threads in the top 10 for the paraphrase queries rise from 8.25 to 9.75 (today, V0: 9.25). Embedding the subject made the messages of one thread cluster; folding them recovers more than that. No recall family improved, and by the same rule as collapse a default changes only on a recall gain. So `collapseThreads` ships opt-in.

The new metric is "distinct threads@10": the number of different threads among the top 10 hits, with a folded thread counted once.

**Collapse default.** The lead's rule: default-on only if the collapse variant improves recall at k on the families and regresses none. V3 against V2 on semantic: diversity coverage rises from 39% to 69%, and every other family is equal. So it is on.

**Read honestly:**

- **The remaining `latest` miss is the sign-in alerts.** Their bodies differ by device and city, so the newest member's cosine falls outside the 0.03 tie window, and no tie forms.
- **Hybrid has no collapse.** Its diversity drops from 44% (V0) to 39% (V2): one of three queries ("automated notifications") covers 1 of 6 families instead of 2. Embedding the subject tightens each template family, and hybrid cannot fold them.
- **The index is exact cosine kNN.** Vectorize is approximate, so production recall can only be lower.
- **The sample is small** (98 queries, 3 for diversity). It shows the direction and the size of the effect, not a precise rate.
