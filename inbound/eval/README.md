# Semantic recall eval (#813)

This eval measures recall at k for semantic and hybrid search, before and after the #813 changes. It runs postern's real search code, so the numbers describe what ships. It is not part of `npm test`.

| file | what it does |
|---|---|
| `corpus813.mjs` | Builds a deterministic mailbox: 300 synthetic messages and 98 queries with gold ids. The same seed gives the same corpus. |
| `embed813.mjs` | Embeds every text the eval needs with the real model (`@cf/baai/bge-base-en-v1.5`, Workers AI REST) into a JSON cache keyed by sha256 of the text. It fetches only what is missing. |
| `recall813.eval.mjs` | For each variant: builds a fresh real-sqlite postern, stores the corpus through `store.put`, fills an in-memory index with the cached vectors, and runs every query through `store.search`. |
| `vitest.eval.config.ts` | The only config that runs the eval. |
| `replay813.mjs` | The live replay for an operator: the issue's known-item probe against a real deploy. It is read-only, and its summary prints counts and latencies, not mail content. Its primary known-item metric is FOUND (the gold is a top-10 row or folded into a top-10 hit's `similar`); STRICT (a top-10 row only) is printed beside it, and known-item probes are split by whether their template family repeats (#940). |
| `shape813.mjs` | The template-family key the replay splits probes by: a copy of `src/semrank.ts` `templateKey`, held equal by `semrank-shape-parity.test.ts`. |

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

## Result (2026-11-11, #930 corpus: 485 messages, 132 queries)

| variant | mode | token r@1 / r@10 | latest r@1 / r@10 | subject r@1 / r@10 | paraphrase r@1 / r@5 / r@10 | diversity coverage@10 | MRR (all single-gold) | distinct threads@10, paraphrase |
|---|---|---|---|---|---|---|---|---|
| V0 today (body only, no tiebreak) | semantic | 85% / 100% | 17% / 67% | 20% / 44% | 37% / 63% / 72% | 51% | 0.511 | 9.22 |
| V0 today (body only, no tiebreak) | hybrid | 100% / 100% | 67% / 100% | 100% / 100% | 37% / 63% / 72% | 51% | 0.712 | 9.22 |
| V1 + subject in chunk 0 | semantic | 85% / 100% | 0% / 33% | 100% / 100% | 85% / 97% / 97% | 53% | 0.878 | 7.87 |
| V1 + subject in chunk 0 | hybrid | 100% / 100% | 33% / 100% | 100% / 100% | 85% / 97% / 97% | 53% | 0.922 | 7.87 |
| V2 + family tiebreak | semantic | 100% / 100% | 83% / 83% | 100% / 100% | 85% / 97% / 97% | 53% | 0.937 | 7.87 |
| V2 + family tiebreak | hybrid | 100% / 100% | 83% / 100% | 100% / 100% | 85% / 97% / 97% | 53% | 0.939 | 7.87 |
| V3 + collapse | semantic | 100% / 100% | 83% / 83% | 100% / 100% | 85% / 98% / 100% | 67% | 0.941 | 7.97 |
| V4 + thread collapse | semantic | 100% / 100% | 83% / 83% | 100% / 100% | 85% / 98% / 100% | 71% | 0.943 | 9.72 |
| H1 hybrid + family fold | hybrid | 100% / 100% | 83% / 83% | 100% / 100% | 85% / 98% / 100% | 67% | 0.941 | 7.97 |
| H2 hybrid + cap 1 per family | hybrid | 100% / 100% | 83% / 83% | 100% / 100% | 85% / 98% / 100% | 67% | 0.941 | 7.97 |
| H3 hybrid + cap 2 per family | hybrid | 100% / 100% | 83% / 100% | 100% / 100% | 85% / 98% / 100% | 64% | 0.944 | 7.42 |
| H4 hybrid + cap 3 per family | hybrid | 100% / 100% | 83% / 100% | 100% / 100% | 85% / 98% / 98% | 63% | 0.943 | 7.67 |

What ships: semantic is V4 (collapse and collapseThreads both on by default), and hybrid is H3 (cap 2 per family by default).

**The rule** (the lead's, from #813): a default changes only when a variant improves a recall family and no family gets worse.

- **#930, hybrid.** H3 (cap 2) against V2 hybrid (no cap, as #813 shipped): diversity coverage 53% to 64%, MRR 0.939 to 0.944, paraphrase r@5 and r@10 up, every other family equal. It ships. H1 (fold) and H2 (cap 1) raise diversity further but drop `latest` r@10 from 100% to 83%: one family member stands for the family, and it is not always the newest. H4 (cap 3) passes with less gain. Distinct threads in the top 10 dip from 7.87 to 7.42 under H3; that is not a recall family, and it is reported here.
- **The #930 premise.** The 44% to 39% hybrid drop was measured on 3 diversity queries. On 15 it does not reproduce: 51% before #813, 53% after.
- **#926, re-judged on this corpus.** V4 (thread fold) against V3: diversity coverage 67% to 71%, MRR 0.941 to 0.943, every other family equal. So `collapseThreads` is on by default. On the smaller #813 corpus it moved no recall family and was off.

**Corpus.** The #930 block is appended with its own seed, so the first 300 messages and 98 queries are byte-identical to the #813 run. It adds 5 notification families, 20 threads (35 in all), 12 diversity queries (15 in all) and 2 `latest` probes.

**Read honestly.** The remaining `latest` miss is still the sign-in alerts. Exact kNN, not Vectorize ANN. 15 diversity queries is better than 3, but still a small sample.

The new metric is "distinct threads@10": the number of different threads among the top 10 hits, with a folded thread counted once.

**Collapse default.** The lead's rule: default-on only if the collapse variant improves recall at k on the families and regresses none. V3 against V2 on semantic: diversity coverage rises from 39% to 69%, and every other family is equal. So it is on.

**Read honestly:**

- **The remaining `latest` miss is the sign-in alerts.** Their bodies differ by device and city, so the newest member's cosine falls outside the 0.03 tie window, and no tie forms.
- **Hybrid has no collapse.** Its diversity drops from 44% (V0) to 39% (V2): one of three queries ("automated notifications") covers 1 of 6 families instead of 2. Embedding the subject tightens each template family, and hybrid cannot fold them.
- **The index is exact cosine kNN.** Vectorize is approximate, so production recall can only be lower.
- **The sample is small** (98 queries, 3 for diversity). It shows the direction and the size of the effect, not a precise rate.

## #950: the Actions-template class

**Corpus.** A third block, appended with its own seed (950), so the first 485 messages and 132
queries are byte-identical to the #930 run. It adds 48 synthetic GitHub Actions "PR run failed"
notifications: 8 workflows times 6 PR titles. Each subject is unique, so the shape key calls all 48 a
unique shape, as production's #6 and #36 were. Every body is the same long Actions template (the job
table, the annotations, the run links and the footer), and only the sha, the run id, the failed job
and the timings differ. Two query families: `actions` (12 probes, the message's own exact subject,
the production probe shape) and `actions-title` (12 probes, "<workflow> failed on <PR title>").

**Recipes** (`recipes950.mjs`, eval only): R2 is what ships. R3a adds a subject-only chunk ahead of
R2. R3b cuts the signature footer and link-only lines before R2. R3c is both.

**Step 0, no token** (`node eval/template950.mjs`): how much of chunk 0 is the shared template.

| recipe | chunks per message | chunk 0 chars | shared template share of chunk 0 (median, min, max) | subject share of chunk 0 (median) |
|---|---|---|---|---|
| R2 | 2 | 1286 | 93% (83%, 94%) | 7% |
| R3a | 3 | 88 | 0% (0%, 0%) | 100% |
| R3b | 1 | 1054 | 91% (80%, 92%) | 8% |
| R3c | 2 | 88 | 0% (0%, 0%) | 100% |

This is structure, not recall. Recall needs the real embeddings: `embed813.mjs` (about 487 new
texts, about 50k tokens), then `recall813.eval.mjs`. Results below.

**Recall, 2026-11-12** (joan, real bge-base embeddings, exact kNN). Run A is the 533-message corpus
(the #930 corpus plus the 48 probe messages). Run B adds 432 older Actions notifications, 480 in all,
because Vectorize reads at most 50 chunks and production's probes competed with older re-runs.

**The control failed in both runs.** R2 with the shipped settings (V4 semantic) finds the `actions`
probes at 100% r@1, in A and in B. The synthetic block does not reproduce the production miss, so
these runs do not show that any recipe fixes the #950 class. Under exact kNN, the family tiebreak
puts the newest member of a near-identical family first, and each probe is the newest of its
re-runs. What these runs cannot see: Vectorize is approximate nearest neighbour, not exact; real
Actions bodies come from HTML; and whether production's two misses were embedded by the current
recipe at all.

Side finding, on the families that are not #950's (V4 and H3 against the candidates):

| run | variant | latest r@1 | paraphrase r@1 / r@5 / r@10 | diversity@10 | MRR | distinct threads@10 |
|---|---|---|---|---|---|---|
| A | V4 semantic | 83% | 85% / 98% / 98% | 59% | 0.952 | 9.77 |
| A | R3a semantic | 100% | 90% / 100% / 100% | 61% | 0.976 | 9.05 |
| A | R3c semantic | 100% | 90% / 100% / 100% | 65% | 0.976 | 8.97 |
| A | H3 hybrid | 83% | 85% / 98% / 98% | 56% | 0.939 | 7.60 |
| A | R3a hybrid | 100% | 90% / 100% / 100% | **55%** | 0.959 | 6.62 |
| A | R3c hybrid | 100% | 90% / 100% / 100% | 59% | 0.959 | 6.62 |
| B | V4 semantic | 83% | 85% / 98% / 98% | 58% | 0.952 | 9.80 |
| B | R3a semantic | 100% | 90% / 100% / 100% | 59% | 0.976 | 9.10 |
| B | R3c semantic | 100% | 90% / 100% / 100% | 58% | 0.976 | 9.08 |
| B | H3 hybrid | 83% | 85% / 98% / 98% | 46% | 0.952 | 7.67 |
| B | R3a hybrid | 100% | 90% / 100% / 100% | 50% | 0.972 | 6.65 |
| B | R3c hybrid | 100% | 90% / 100% / 100% | 49% | 0.972 | 6.65 |

token and subject are 100% / 100% in every row. By the #813 rule, R3c is no worse on any family in
either run. R3a drops hybrid diversity 56% to 55% in run A (one step on 15 queries). Distinct threads
in the top 10 fall by about 0.7 (semantic) and 1.0 (hybrid) under both. That is not a recall family,
and it is reported here.
