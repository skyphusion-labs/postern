// #813 recall eval, step 2: recall at k, before and after, through the REAL store.
//
// For each variant this builds a fresh real-sqlite postern (realdb), stores the generated
// corpus through store.put, and fills an in-memory vector index with the REAL bge-base
// vectors cached by eval/embed813.mjs (chunk texts from embedtext.ts, the recipe the store
// uses). Queries then go through store.search, so the semantic and hybrid ranking measured
// here IS the shipped code. The index is exact cosine kNN, not Vectorize's approximate
// search, so production recall can only be lower.
//
//   EVAL_CACHE=<embeddings.json> EVAL_OUT=<dir> npx vitest run --config eval/vitest.eval.config.ts
import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCorpus } from "./corpus813.mjs";
import { embedChunks } from "../src/embedtext";
import * as store from "../src/store";
import { realEnv, AUTH } from "../realdb";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const VARIANTS = [
  { name: "V0 today (body only, no tiebreak)", recipe: 1, familyRank: false, collapse: false, modes: ["semantic", "hybrid"] },
  { name: "V1 + subject in chunk 0", recipe: 2, familyRank: false, collapse: false, modes: ["semantic", "hybrid"] },
  { name: "V2 + family tiebreak", recipe: 2, familyRank: true, collapse: false, modes: ["semantic", "hybrid"] },
  { name: "V3 + collapse", recipe: 2, familyRank: true, collapse: true, modes: ["semantic"] },
];
const FAMILIES = ["token", "latest", "subject", "paraphrase", "diversity"];

async function buildVariant(corpus, cache, recipe) {
  const vec = (t) => {
    const v = cache[sha(t)];
    if (!v) throw new Error(`no cached embedding for a text (run eval/embed813.mjs): ${t.slice(0, 60)}`);
    return v;
  };
  const index = [];
  const AI = { async run(_m, i) { return { data: i.text.map(vec) }; } };
  const VECTORIZE = {
    async query(q, o) {
      return { matches: index.map((x) => ({ id: x.id, score: cos(q, x.values), metadata: x.metadata })).sort((a, b) => b.score - a.score).slice(0, o.topK) };
    },
    async upsert() { return {}; },
  };
  const r = realEnv({ AI, VECTORIZE });
  for (const m of corpus.messages) {
    await store.put(r.env, {
      messageId: m.id, direction: "inbound", from: m.from, to: m.to, subject: m.subject, date: m.date,
      inReplyTo: m.inReplyTo, references: m.inReplyTo ? [m.inReplyTo] : [], bodyText: m.body, auth: AUTH, trusted: false, deliveredTo: [m.to],
    }, r.ctx);
    const chunks = embedChunks(m.subject, m.body, recipe);
    const ids = await store.vectorIdsForMessage(m.id, chunks.length);
    chunks.forEach((t, i) => index.push({ id: ids[i], values: vec(t), metadata: { message_id: m.id, chunk: i } }));
  }
  return r.env;
}

function score(corpus, query, items) {
  const fam = new Map(corpus.messages.map((m) => [m.id, m.family]));
  if (query.family === "diversity") {
    const seen = new Set(items.slice(0, 10).map((h) => fam.get(h.message.messageId)));
    return { coverage: query.goldFamilies.filter((f) => seen.has(f)).length / query.goldFamilies.length };
  }
  const gold = new Set(query.gold);
  const strict = items.findIndex((h) => gold.has(h.message.messageId));
  // Surfaced: the gold id is the hit, or folded into the hit's `similar` ids.
  const surfaced = items.findIndex((h) => gold.has(h.message.messageId) || (h.similar?.ids ?? []).some((id) => gold.has(id)));
  return { strict, surfaced };
}

function summarise(rows) {
  const out = {};
  for (const f of FAMILIES) {
    const rs = rows.filter((r) => r.family === f);
    if (!rs.length) continue;
    if (f === "diversity") { out[f] = { n: rs.length, coverage10: rs.reduce((s, r) => s + r.coverage, 0) / rs.length }; continue; }
    const at = (k, key) => rs.filter((r) => r[key] >= 0 && r[key] < k).length / rs.length;
    out[f] = {
      n: rs.length, r1: at(1, "strict"), r5: at(5, "strict"), r10: at(10, "strict"),
      mrr: rs.reduce((s, r) => s + (r.strict >= 0 && r.strict < 10 ? 1 / (r.strict + 1) : 0), 0) / rs.length,
      surfaced10: at(10, "surfaced"),
    };
  }
  return out;
}

it("#813 recall at k, before and after", async () => {
  const cachePath = process.env.EVAL_CACHE;
  const outDir = process.env.EVAL_OUT;
  expect(cachePath, "EVAL_CACHE must point at eval/embed813.mjs output").toBeTruthy();
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const corpus = buildCorpus();
  const results = [];
  for (const v of VARIANTS) {
    const env = await buildVariant(corpus, cache, v.recipe);
    for (const mode of v.modes) {
      const rows = [];
      for (const query of corpus.queries) {
        const page = await store.search(env, { q: query.q, mode, limit: 10, collapse: v.collapse, familyRank: v.familyRank });
        rows.push({ family: query.family, q: query.q, ...score(corpus, query, page.items) });
      }
      results.push({ variant: v.name, mode, summary: summarise(rows), rows });
    }
  }
  const pct = (x) => (x === undefined ? "" : `${Math.round(x * 100)}%`);
  const lines = ["| variant | mode | token r@1 / r@10 | latest r@1 / r@10 | subject r@1 / r@10 | paraphrase r@1 / r@5 / r@10 | diversity coverage@10 | MRR (all single-gold) |", "|---|---|---|---|---|---|---|---|"];
  for (const r of results) {
    const s = r.summary;
    const single = r.rows.filter((x) => x.family !== "diversity");
    const mrr = single.reduce((a, x) => a + (x.strict >= 0 && x.strict < 10 ? 1 / (x.strict + 1) : 0), 0) / single.length;
    lines.push(`| ${r.variant} | ${r.mode} | ${pct(s.token.r1)} / ${pct(s.token.r10)} | ${pct(s.latest.r1)} / ${pct(s.latest.r10)} | ${pct(s.subject.r1)} / ${pct(s.subject.r10)} | ${pct(s.paraphrase.r1)} / ${pct(s.paraphrase.r5)} / ${pct(s.paraphrase.r10)} | ${pct(s.diversity.coverage10)} | ${mrr.toFixed(3)} |`);
  }
  const table = lines.join("\n");
  console.log(`\n${corpus.messages.length} messages, ${corpus.queries.length} queries\n${table}\n`);
  if (outDir) {
    writeFileSync(`${outDir}/recall813-results.json`, JSON.stringify(results, null, 1));
    writeFileSync(`${outDir}/recall813-table.md`, table + "\n");
  }
  expect(results.length).toBe(7);
}, 600_000);
