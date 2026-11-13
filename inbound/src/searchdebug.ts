// GET /api/admin/search-debug (#950): the raw Vectorize ranking behind one search.
//
// The offline recall eval (eval/) ranks with EXACT cosine kNN. Production ranks with
// Vectorize, which is approximate. Twice the eval control could not reproduce the
// production miss, so the next measurement has to read the LIVE ranking. This route
// answers, for one query: the matches Vectorize returned (vector id, score, rank, chunk,
// message id) BEFORE the collapse to messages, scope, family tiebreak or hybrid blend;
// the fused page the shipped search returned from that SAME call; and, for an optional
// `gold` message, where its own vectors sit against that list.
//
// Guards, all three required:
//   - the static `both` (operator) token ONLY. The route row is `admin` scope, so the gate
//     also admits the POSTERN_API_TOKEN_ADMIN slot, and this handler then refuses it (403
//     E_FORBIDDEN, audited): the #904 slot cannot read mail, and a query-to-ids rank
//     oracle is a mail read by another name. Never a read token, a registry identity or a
//     session, so webmail cannot reach it.
//   - OFF BY DEFAULT: answers 404 unless the deploy sets SEARCH_DEBUG=1. A query plus the
//     ids that match it is a content oracle over the whole estate, so the operator turns it
//     on for a measurement window and off again.
//   - APPROXIMATE SCORES. Production queries without returnValues, so Vectorize scores
//     approximately (developers.cloudflare.com/vectorize/best-practices/query-vectors, read
//     2026-11-13); window 1 of #950 measured a 0.10 to 0.11 gap against the exact cosine.
//     So every raw match also carries its EXACT cosine, recomputed from its stored vector,
//     and the gold verdict compares exact with exact (floorExact), never exact with the
//     approximate floorScore.
//   - ids and scores only. No subject, sender, recipient, date or body leaves this route,
//     though Vectorize metadata carries some of them. Each call writes one audit row
//     (`search.debug`) with the mode, the limit and the query LENGTH, never the query.

import type { AuditActor } from "./adminkit";
import { auditStatement } from "./adminkit";
import * as store from "./store";

/** Vectorize's own topK ceiling with returnMetadata "all" (store.ts VECTOR_TOPK_MAX). */
const LIMIT_MAX = 50;
const LIMIT_DEFAULT = 10;
/** A Message-ID longer than this is not one the store would hold verbatim. */
const GOLD_MAX = 998;
/** The audit actor id of the #904 admin-only slot (api.ts adminActorOf). */
const ADMIN_SLOT_ACTOR = "svc_admin";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** SEARCH_DEBUG is on only when set to exactly 1 or true. Unset, empty or a typo is off. */
export function searchDebugEnabled(env: Env): boolean {
  const v = (env.SEARCH_DEBUG ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function cosine(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / Math.sqrt(na * nb);
}

export type GoldVerdict =
  | "in-raw" // a gold vector is in the raw topK: any loss happened after Vectorize
  | "ann-miss" // exact cosine beats the K-th raw score, yet Vectorize did not return it
  | "outranked" // exact cosine is below the K-th raw score: crowded out of the topK
  | "not-in-short-result" // Vectorize returned fewer than topK and still left it out
  | "unscored" // a full list, but no raw match had a stored vector to score exactly
  | "not-indexed" // no vector_ledger rows for this message
  | "not-yet-queryable" // #963: the index has not processed the gold's upsert yet (describe())
  | "vectors-missing"; // ledger rows exist, but Vectorize holds none of those vectors

/** The /api/search defaults for an omitted collapse / collapseThreads / familyCap (api.ts). */
export interface SearchDefaults {
  collapse: boolean;
  collapseThreads: boolean;
  familyCap: number;
}

export async function handleSearchDebug(
  request: Request,
  env: Env,
  url: URL,
  actor: AuditActor,
  defaults: SearchDefaults,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  // Before the flag check, so the admin slot cannot even learn whether the route is armed.
  if (actor.id === ADMIN_SLOT_ACTOR) {
    await auditStatement(
      env,
      new Date().toISOString(),
      { action: "search.debug", outcome: "refused", detail: { reason: "admin-slot" } },
      undefined,
      actor,
    ).run();
    return json(
      { ok: false, error: "E_FORBIDDEN", message: "search debug needs the operator (both) token; the admin-only slot cannot read mail" },
      403,
    );
  }
  if (!searchDebugEnabled(env)) {
    return json(
      { ok: false, error: "E_NOT_FOUND", message: "search debug is off on this deploy; set SEARCH_DEBUG=1 to enable it" },
      404,
    );
  }
  const p = url.searchParams;
  const q = (p.get("q") ?? "").trim();
  if (!q) return json({ ok: false, error: "E_FIELD_MISSING", message: "q is required" }, 400);
  const modeParam = p.get("mode") ?? "semantic";
  if (modeParam !== "semantic" && modeParam !== "hybrid") {
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: "mode must be semantic or hybrid" }, 400);
  }
  const mode: "semantic" | "hybrid" = modeParam;
  const limitParam = p.get("limit");
  let limit = LIMIT_DEFAULT;
  if (limitParam !== null) {
    if (!/^[0-9]{1,3}$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > LIMIT_MAX) {
      return json({ ok: false, error: "E_VALIDATION_ERROR", message: `limit must be an integer 1..${LIMIT_MAX}` }, 400);
    }
    limit = Number(limitParam);
  }
  const goldParam = p.get("gold");
  const gold = goldParam === null ? undefined : goldParam.trim().replace(/^<|>$/g, "");
  if (gold !== undefined && (gold.length === 0 || gold.length > GOLD_MAX)) {
    return json({ ok: false, error: "E_VALIDATION_ERROR", message: `gold must be a Message-ID of 1..${GOLD_MAX} characters` }, 400);
  }
  if (!env.AI || !env.VECTORIZE) {
    return json(
      { ok: false, error: "E_UNAVAILABLE", message: "search debug needs both the AI and the Vectorize bindings" },
      503,
    );
  }

  // Exactly what /api/search runs for this q, mode and limit with every other parameter
  // omitted: no viewer, no filters, the shipped collapse and family-cap defaults.
  const settings = {
    collapse: mode === "semantic" ? defaults.collapse : false,
    collapseThreads: mode === "semantic" ? defaults.collapseThreads : false,
    familyCap: mode === "hybrid" ? defaults.familyCap : 0,
  };
  const { page, traces } = await store.searchTraced(env, { q, mode, limit, ...settings });
  const trace = traces[0];
  await auditStatement(
    env,
    new Date().toISOString(),
    { action: "search.debug", outcome: "ok", detail: { mode, limit, qLength: q.length, gold: gold !== undefined } },
    undefined,
    actor,
  ).run();
  if (!trace) {
    return json(
      { ok: false, error: "E_UNAVAILABLE", message: "no Vectorize query ran (the query embedding failed)", degraded: page.degraded ?? null },
      503,
    );
  }

  // The exact cosine of every raw match, from its stored vector (getByIds, batched). The
  // Vectorize score is approximate, so this is the scale every comparison below uses.
  const rawStored = trace.matches.length ? await store.vectorsByIds(env, trace.matches.map((m) => m.id)) : [];
  const rawValues = new Map(rawStored.map((v) => [v.id, v.values]));
  const raw = trace.matches.map((m, i) => {
    const values = rawValues.get(m.id);
    return {
      rank: i + 1,
      vectorId: m.id,
      score: m.score,
      exact: values ? cosine(trace.queryVec, values) : null,
      chunk: typeof m.metadata?.chunk === "number" ? m.metadata.chunk : null,
      messageId: typeof m.metadata?.message_id === "string" ? m.metadata.message_id : null,
    };
  });
  const firstRawRank = new Map<string, number>();
  for (const r of raw) if (r.messageId && !firstRawRank.has(r.messageId)) firstRawRank.set(r.messageId, r.rank);
  const fused = page.items.map((h, i) => ({
    rank: i + 1,
    messageId: h.message.messageId,
    score: h.score ?? null,
    rawRank: firstRawRank.get(h.message.messageId) ?? null,
    similarCount: h.similar?.count ?? 0,
    threadHitsCount: h.threadHits?.count ?? 0,
  }));
  const full = trace.matches.length >= trace.topK;
  const floorScore = full && raw.length > 0 ? raw[raw.length - 1].score : null;
  // The lowest EXACT score among what Vectorize returned. A gold whose exact cosine beats
  // it would have displaced a returned vector under exact search.
  const exacts = raw.map((r) => r.exact).filter((x): x is number => x !== null);
  const floorExact = full && exacts.length > 0 ? Math.min(...exacts) : null;
  // The size of the approximate-scoring gap, over every raw match that has an exact score.
  const gaps = raw.filter((r) => r.exact !== null).map((r) => Math.abs(r.score - (r.exact as number))).sort((a, b) => a - b);
  const approxError = gaps.length
    ? { n: gaps.length, max: gaps[gaps.length - 1], median: gaps[Math.floor((gaps.length - 1) / 2)] }
    : { n: 0, max: null, median: null };

  // The rank-1 score against its exact recompute. Under approximate scoring the delta is the
  // scorer's error, not a defect; approxError above gives it over the whole list.
  let scoreCheck: Record<string, unknown> | null = null;
  if (raw.length > 0) {
    const recomputed = raw[0].exact;
    scoreCheck = {
      vectorId: raw[0].vectorId,
      vectorizeScore: raw[0].score,
      recomputed,
      delta: recomputed === null ? null : Math.abs(recomputed - raw[0].score),
    };
  }

  // #963: how far the index has processed its mutations (one describe()). A vector whose upsert
  // returned after processedUpTo is stored but not yet served by query().
  const progress = await store.indexProgress(env);

  let goldReport: Record<string, unknown> | undefined;
  if (gold !== undefined) {
    const { results } = await env.DB.prepare(
      "SELECT vector_id, chunk, embed_version, mutation_id, upserted_ms FROM vector_ledger WHERE message_id = ? ORDER BY chunk",
    )
      .bind(gold)
      .all<{ vector_id: string; chunk: number; embed_version: number; mutation_id: string | null; upserted_ms: number | null }>();
    const ledger = results ?? [];
    const rawRankById = new Map(raw.map((r) => [r.vectorId, r.rank]));
    const stored = ledger.length ? await store.vectorsByIds(env, ledger.map((l) => l.vector_id)) : [];
    const valuesById = new Map(stored.map((v) => [v.id, v.values]));
    const chunks = ledger.map((l) => {
      const values = valuesById.get(l.vector_id);
      return {
        vectorId: l.vector_id,
        chunk: l.chunk,
        embedVersion: l.embed_version,
        inIndex: valuesById.has(l.vector_id),
        cosine: values ? cosine(trace.queryVec, values) : null,
        rawRank: rawRankById.get(l.vector_id) ?? null,
      };
    });
    const best = chunks.reduce<number | null>((m, c) => (c.cosine !== null && (m === null || c.cosine > m) ? c.cosine : m), null);
    // The latest upsert of the gold's vectors (one upsert writes every chunk), and whether the
    // index has processed past it. null when the ledger row predates 0025 or describe() gives no
    // processing point: then nothing is concluded from it.
    const upsertedMs = ledger.reduce<number | null>((m, l) => (typeof l.upserted_ms === "number" && (m === null || l.upserted_ms > m) ? l.upserted_ms : m), null);
    const mutationId = ledger.find((l) => typeof l.mutation_id === "string")?.mutation_id ?? null;
    const pending = upsertedMs !== null && progress?.processedUpToMs != null ? progress.processedUpToMs < upsertedMs : null;
    let verdict: GoldVerdict;
    if (chunks.some((c) => c.rawRank !== null)) verdict = "in-raw";
    else if (ledger.length === 0) verdict = "not-indexed";
    else if (pending === true) verdict = "not-yet-queryable";
    else if (!chunks.some((c) => c.inIndex)) verdict = "vectors-missing";
    else if (!full) verdict = "not-in-short-result";
    else if (floorExact === null) verdict = "unscored";
    else verdict = best !== null && best > floorExact ? "ann-miss" : "outranked";
    // Where exact scores would place the gold among the messages Vectorize returned: 1 + the
    // number of OTHER raw messages whose best exact score beats the gold's.
    const bestByMsg = new Map<string, number>();
    for (const r of raw) {
      if (r.messageId && r.exact !== null) bestByMsg.set(r.messageId, Math.max(bestByMsg.get(r.messageId) ?? -Infinity, r.exact));
    }
    const exactRankInRaw =
      best === null ? null : 1 + [...bestByMsg].filter(([id, v]) => id !== gold && v > best).length;
    goldReport = {
      messageId: gold,
      verdict,
      bestCosine: best,
      exactRankInRaw,
      fusedRank: fused.find((f) => f.messageId === gold)?.rank ?? null,
      // #963: when its upsert returned, and whether the index had processed past it. The
      // mutation id is an opaque UUID, never content; mutationIsLatest is the exact match.
      upsertedMs,
      pending,
      mutationIsLatest: mutationId !== null && progress?.processedUpToMutation ? progress.processedUpToMutation === mutationId : null,
      chunks,
    };
  }

  return json({
    ok: true,
    query: { mode, limit, qLength: q.length, ...settings },
    model: "@cf/baai/bge-base-en-v1.5",
    topK: trace.topK,
    wide: trace.wide,
    exhausted: !full,
    floorScore,
    floorExact,
    scoring: "approximate",
    approxError,
    raw,
    fused,
    complete: page.complete ?? page.cursor === null,
    degraded: page.degraded ?? null,
    scoreCheck,
    // #963: the index's processing point. processedUpToMs is Vectorize's clock, upsertedMs the
    // Worker's: a skew between them shifts "pending" by that much.
    index: progress,
    // #963: the Worker's clock at this answer, the clock upsertedMs was read with, so a driver
    // measures "send to queryable" on one clock, never the operator's against the Worker's.
    serverNowMs: Date.now(),
    ...(goldReport ? { gold: goldReport } : {}),
  });
}
