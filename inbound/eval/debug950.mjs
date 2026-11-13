// #950 live measurement: where a semantic probe loses its gold, read from the operator
// debug route (GET /api/admin/search-debug, #952). Read-only. Run by the operator inside a
// SEARCH_DEBUG=1 window (OPERATIONS.md section 7):
//
//   POSTERN_URL=https://mail.example POSTERN_TOKEN=<the both token> \
//     node eval/debug950.mjs [--class-match 'PR run failed:'] [--min 8] [--controls 3] [--json]
//   ... node eval/debug950.mjs --gold-file <path> [--controls 3] [--json]          (#963)
//
// --gold-file (#963): probe named messages instead of a class. The file is OPERATOR-PRIVATE: a
// JSON list of Message-IDs (strings, or objects with a messageId), 1 to 20 of them, owner-only
// (mode 600; a file that group or others can read is refused) and never committed. Each gold is
// read with GET /api/messages/<Message-ID> (the operator token), and its own subject is the
// query. The same calls as a class probe, plus search semantic with collapse=0. The ids stay in
// the file: the output numbers the probes, and an error names the route as /api/messages/<id>.
//
// Probes:
//   class    the newest --min inbound messages whose subject CONTAINS --class-match (literal
//            text, never a regular expression; real GitHub subjects carry a "[owner/repo] "
//            prefix, which is why window 1 found none with a prefix match). They are found
//            with the FTS list (/api/messages?q=), so they are found at any age.
//   control  the newest --controls inbound messages of a unique template shape in the newest
//            80 that are not in the class.
// Each probe is its own subject as the query, its own Message-ID as the gold. Calls per probe:
//   debug semantic limit=10   the production call. Semantic always asks Vectorize for the
//                             ceiling (topK 50) and slices AFTER the family tiebreak
//                             (store.ts hasPostRetrievalFilter, the #813 clause), so a
//                             limit=50 call would read the same pool; window 1 showed it.
//   debug hybrid   limit=10   control: hybrid finds this class today
//   search semantic limit=10  FOUND as the replay counts it (strict row, or folded into `similar`)
//
// Scale: Vectorize scores APPROXIMATELY (no returnValues). Window 1 measured a 0.10 to 0.11
// gap. The route now gives every raw match its EXACT cosine and judges the gold on the exact
// scale (floorExact). A deploy whose route predates that gives no exact scores, and this
// driver then says INSTRUMENT NOT TRUSTED.
//
// PRIVACY (primary): the output is counts, ranks, cosines and verdicts. It never prints a
// subject, a sender, a Message-ID or a vector id. Probes are numbered. The token is never
// printed. Mail read by the listing stays in this process.
import { pathToFileURL } from "node:url";
import { shapeKey } from "./shape813.mjs";

export const DEFAULTS = { classMatch: "PR run failed:", min: 8, controls: 3, window: 80, classLimit: 200 };
/** At most this many named golds per run: a measurement, not a crawl of the mailbox. */
export const GOLD_MAX_IDS = 20;
export const CALLS = [
  { key: "sem10", mode: "semantic", limit: 10 },
  { key: "hyb10", mode: "hybrid", limit: 10 },
];
/** Semantic retrieval always uses Vectorize's ceiling with metadata (store.ts VECTOR_TOPK_MAX). */
export const SEMANTIC_TOPK = 50;

const usable = (m) => typeof m?.messageId === "string" && m.messageId && (m.subject ?? "").trim();

/** The class: subjects that contain the literal match text, newest first, at most `min`. */
export function selectClass(candidates, opts = DEFAULTS) {
  return candidates.filter((m) => usable(m) && (m.subject ?? "").includes(opts.classMatch)).slice(0, opts.min);
}

/** Controls: unique template shape in the window listing, and not in the class. */
export function selectControls(listed, counts, opts = DEFAULTS) {
  return listed
    .filter((m) => usable(m) && !(m.subject ?? "").includes(opts.classMatch) && (counts.get(shapeKey(m.from, m.subject)) ?? 1) === 1)
    .slice(0, opts.controls);
}

export function familyCounts(listed) {
  const c = new Map();
  const seen = new Set();
  for (const m of listed) {
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    const k = shapeKey(m.from, m.subject);
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return c;
}

/**
 * Read one debug response for one gold. rawMessageRank is 1 + the number of DISTINCT messages
 * in `raw` before the gold's first vector. exactScored is true only when the route gave the
 * exact scale (floorExact field, an exact score on raw matches); without it no verdict is used.
 */
export function readDebug(body, goldId, family, familyOf) {
  if (!body || body.ok !== true) return { error: body?.error ?? "no body" };
  const g = body.gold ?? {};
  const raw = Array.isArray(body.raw) ? body.raw : [];
  const seen = new Set();
  let rawMessageRank = null;
  let rawVectorRank = null;
  const familyIds = new Set();
  for (const r of raw) {
    if (!r.messageId) continue;
    if (familyOf(r.messageId) === family) familyIds.add(r.messageId);
    if (rawMessageRank === null && r.messageId === goldId) {
      rawMessageRank = seen.size + 1;
      rawVectorRank = r.rank;
    }
    seen.add(r.messageId);
  }
  const exactScored = "floorExact" in body && raw.length > 0 && raw.every((r) => typeof r.exact === "number");
  return {
    verdict: g.verdict ?? null,
    rawMessageRank,
    rawVectorRank,
    exactRankInRaw: g.exactRankInRaw ?? null,
    rawMessages: seen.size,
    topK: body.topK ?? null,
    exhausted: body.exhausted ?? null,
    floorScore: round(body.floorScore),
    floorExact: round(body.floorExact),
    bestCosine: round(g.bestCosine),
    fusedRank: g.fusedRank ?? null,
    familyInRaw: familyIds.size,
    approxErrorMax: round(body.approxError?.max),
    exactScored,
  };
}

/** FOUND as replay813 counts it: a top-10 row, or folded into a top-10 hit's `similar` ids. */
export function readSearch(body, goldId) {
  const items = body?.items ?? [];
  const strict = items.findIndex((h) => h?.message?.messageId === goldId);
  const surfaced = items.findIndex((h) => h?.message?.messageId === goldId || (h?.similar?.ids ?? []).includes(goldId));
  return { strict: strict >= 0 ? strict + 1 : null, found: surfaced >= 0 };
}

/**
 * The reading for one class probe, on the production call (sem10). Only on the exact scale.
 *   found               the shipped semantic search surfaces it (row or `similar`)
 *   in-raw-not-found    Vectorize returned it, and a step after retrieval (scope, the family
 *                       tiebreak, the collapse, the thread fold, the slice) lost it
 *   ann-miss            its exact cosine beats a vector Vectorize returned, yet it was left out
 *   outranked           50 returned vectors beat it on the exact scale: crowded out
 *   (index verdicts pass through: not-indexed, vectors-missing, not-in-short-result, unscored)
 */
export function classify(row) {
  const a = row.sem10;
  if (!a || a.error) return "error";
  if (!a.exactScored) return "no-exact-scale";
  if (row.found) return "found";
  if (a.verdict === "in-raw") return "in-raw-not-found";
  return a.verdict ?? "unknown";
}

/**
 * A control is a message the shipped search finds. It must come back in-raw and FOUND, on the
 * exact scale. Not "raw rank 1": approximate scores reorder near ties, and a subject unique in
 * the inbound listing can still be shared by another stored message (window 1: 2 of 3 at rank 2,
 * all found).
 */
export function controlOk(row) {
  return row.sem10?.verdict === "in-raw" && row.sem10?.exactScored === true && row.found === true;
}

function round(x) {
  return typeof x === "number" ? Math.round(x * 1e4) / 1e4 : null;
}

/**
 * Parse an operator gold file (#963): a JSON list of Message-IDs, or of objects with a
 * messageId. Angle brackets are stripped. Throws on anything else, without echoing the content.
 */
export function parseGoldFile(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("gold file: not JSON");
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > GOLD_MAX_IDS) throw new Error(`gold file: must be a JSON list of 1 to ${GOLD_MAX_IDS} Message-IDs`);
  const ids = v.map((x) => (typeof x === "string" ? x : x && typeof x.messageId === "string" ? x.messageId : null));
  if (ids.some((x) => x === null)) throw new Error("gold file: every entry must be a Message-ID string or { messageId }");
  const clean = ids.map((x) => x.trim().replace(/^<|>$/g, ""));
  if (clean.some((x) => x.length === 0 || x.length > 998)) throw new Error("gold file: a Message-ID is empty or too long");
  return [...new Set(clean)];
}

/** The gold file holds Message-IDs: refuse it unless only its owner can read it (mode 600 or 400). */
export function goldFileModeOk(mode) {
  return (mode & 0o077) === 0;
}

/** The route as an error may name it: a message lookup carries a Message-ID in its path. */
export function routeOf(path) {
  return path.split("?")[0].replace(/^\/api\/messages\/.+$/, "/api/messages/<id>");
}

/** The whole measurement. `get(path)` returns the parsed JSON body, or throws on non-2xx. */
export async function run(get, opts = DEFAULTS) {
  const fields = "fields=messageId,subject,date,from";
  const listed = (await get(`/api/messages?direction=inbound&limit=${opts.window}&${fields}`)).items ?? [];
  const golds = Array.isArray(opts.golds) ? opts.golds : null;
  let candidates = [];
  let cls = [];
  let goldMissing = 0;
  if (golds) {
    // #963: named golds, each read by its Message-ID. A gold that does not answer is counted,
    // never named.
    for (const id of golds) {
      let m = null;
      try {
        const body = await get(`/api/messages/${encodeURIComponent(id)}`);
        m = body?.message ?? null;
      } catch {
        m = null;
      }
      if (m && (m.subject ?? "").trim()) cls.push({ messageId: id, subject: m.subject, from: m.from ?? "", date: m.date ?? "" });
      else goldMissing += 1;
    }
    candidates = cls;
  } else {
    const classQ = new URLSearchParams({ direction: "inbound", q: opts.classMatch, limit: String(opts.classLimit) });
    candidates = (await get(`/api/messages?${classQ}&${fields}`)).items ?? [];
    cls = selectClass(candidates, opts);
  }
  const counts = familyCounts([...listed, ...candidates]);
  // A named gold is never also a control.
  const controls = selectControls(golds ? listed.filter((m) => !golds.includes(m.messageId)) : listed, counts, opts);
  const famById = new Map();
  for (const m of [...candidates, ...listed]) famById.set(m.messageId, shapeKey(m.from, m.subject));
  const familyOf = (id) => famById.get(id);

  const rows = [];
  const probeKind = golds ? "gold" : "class";
  const probes = [...cls.map((m) => ({ m, kind: probeKind })), ...controls.map((m) => ({ m, kind: "control" }))];
  for (const [i, { m, kind }] of probes.entries()) {
    const fam = shapeKey(m.from, m.subject);
    const row = { i: i + 1, kind, familyListed: counts.get(fam) ?? 1 };
    for (const c of CALLS) {
      const qs = new URLSearchParams({ q: m.subject, gold: m.messageId, mode: c.mode, limit: String(c.limit) });
      try {
        row[c.key] = readDebug(await get(`/api/admin/search-debug?${qs}`), m.messageId, fam, familyOf);
      } catch (e) {
        row[c.key] = { error: String(e.message ?? e) };
      }
    }
    try {
      const s = readSearch(await get(`/api/search?${new URLSearchParams({ q: m.subject, mode: "semantic", limit: "10" })}`), m.messageId);
      row.found = s.found;
      row.strict = s.strict;
    } catch (e) {
      row.found = null;
      row.searchError = String(e.message ?? e);
    }
    if (kind === "gold") {
      // #963: the issue's "they miss with collapse=0 too" is read, not assumed.
      try {
        const s0 = readSearch(await get(`/api/search?${new URLSearchParams({ q: m.subject, mode: "semantic", collapse: "0", limit: "10" })}`), m.messageId);
        row.found0 = s0.found;
        row.strict0 = s0.strict;
      } catch (e) {
        row.found0 = null;
        row.search0Error = String(e.message ?? e);
      }
    }
    row.reading = kind === "control" ? (controlOk(row) ? "control-ok" : "control-FAILED") : classify(row);
    rows.push(row);
  }
  return { probeKind, classCandidates: candidates.length, listed: listed.length, classProbes: cls.length, controls: controls.length, goldMissing, rows };
}

/** Human summary: counts and the per-probe numbers. No content. */
export function summarize(res) {
  const out = [];
  const gold = res.probeKind === "gold";
  const kind = gold ? "gold" : "class";
  if (gold) out.push(`#963 debug: ${res.classProbes} gold probes from the gold file (${res.goldMissing ?? 0} not readable), ${res.controls} controls (window ${res.listed})`);
  else out.push(`#950 debug: ${res.classProbes} class probes (of ${res.classCandidates} FTS candidates), ${res.controls} controls (window ${res.listed})`);
  const ctl = res.rows.filter((r) => r.kind === "control");
  const ctlOk = ctl.filter((r) => r.reading === "control-ok").length;
  out.push(`controls ok: ${ctlOk} of ${ctl.length}${ctlOk === ctl.length && ctl.length > 0 ? "" : "  << INSTRUMENT NOT TRUSTED: read nothing else"}`);
  const noExact = res.rows.filter((r) => r.sem10 && !r.sem10.error && !r.sem10.exactScored).length;
  if (noExact) out.push(`probes without the exact scale: ${noExact}  << the deployed route predates floorExact; deploy it first`);
  const pool = new Set(res.rows.map((r) => r.sem10?.topK).filter((x) => x !== null && x !== undefined));
  out.push(`semantic pool topK seen: ${[...pool].join(", ") || "none"} (expected ${SEMANTIC_TOPK})`);
  const errs = res.rows.map((r) => r.sem10?.approxErrorMax).filter((x) => typeof x === "number");
  out.push(`approximate-scoring gap (max per probe): ${errs.length ? `${Math.min(...errs)} to ${Math.max(...errs)}` : "none"}`);
  if (res.classProbes === 0) out.push(gold ? "gold probes: none readable  << check the gold file and the token" : "class probes: none matched  << widen --class-match or check the subject shape");
  const tally = new Map();
  for (const r of res.rows.filter((x) => x.kind === kind)) tally.set(r.reading, (tally.get(r.reading) ?? 0) + 1);
  out.push(`${kind} readings: ${[...tally].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  const hyb = res.rows.filter((r) => r.kind === kind && r.hyb10?.verdict === "in-raw").length;
  out.push(`${kind} probes in-raw under hybrid limit=10 (control): ${hyb} of ${res.classProbes}`);
  out.push("");
  out.push(`probe kind    reading            famListed | sem10: verdict  msgRank exactRank famInRaw best    floorEx fused | found strict${gold ? " | found0 strict0" : ""}`);
  for (const r of res.rows) {
    const a = r.sem10 ?? {};
    out.push(
      [
        String(r.i).padStart(5),
        r.kind.padEnd(7),
        String(r.reading).padEnd(18),
        String(r.familyListed).padStart(9),
        "|",
        String(a.verdict ?? a.error ?? "-").padEnd(14),
        String(a.rawMessageRank ?? "-").padStart(7),
        String(a.exactRankInRaw ?? "-").padStart(9),
        String(a.familyInRaw ?? "-").padStart(8),
        String(a.bestCosine ?? "-").padEnd(7),
        String(a.floorExact ?? "-").padEnd(7),
        String(a.fusedRank ?? "-").padStart(5),
        "|",
        String(r.found ?? "-").padEnd(5),
        String(r.strict ?? "-"),
        ...(gold ? ["|", String(r.found0 ?? "-").padEnd(6), String(r.strict0 ?? "-")] : []),
      ].join(" "),
    );
  }
  return out.join("\n");
}

async function main() {
  const base = (process.env.POSTERN_URL ?? "").replace(/\/+$/, "");
  const token = process.env.POSTERN_TOKEN;
  if (!base || !token) {
    console.error("need POSTERN_URL and POSTERN_TOKEN (the both token; it is never printed)");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const opts = {
    ...DEFAULTS,
    classMatch: flag("--class-match") ?? DEFAULTS.classMatch,
    min: Number(flag("--min") ?? DEFAULTS.min),
    controls: Number(flag("--controls") ?? DEFAULTS.controls),
  };
  const goldFile = flag("--gold-file");
  if (goldFile) {
    const { statSync, readFileSync } = await import("node:fs");
    if (!goldFileModeOk(statSync(goldFile).mode)) {
      console.error("gold file: group or others can read it; chmod 600 it first (it holds Message-IDs)");
      process.exit(2);
    }
    opts.golds = parseGoldFile(readFileSync(goldFile, "utf8"));
  }
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    // The path carries the probe subject in its query string, and a message lookup carries a
    // Message-ID in its path: print the route only.
    if (!res.ok) throw new Error(`GET ${routeOf(path)} failed: HTTP ${res.status}`);
    return res.json();
  };
  const res = await run(get, opts);
  console.log(summarize(res));
  if (args.includes("--json")) console.log(JSON.stringify(res.rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`debug950 failed: ${routeOf(String(e.message ?? e))}`);
    process.exit(1);
  });
}
