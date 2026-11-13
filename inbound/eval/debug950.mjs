// #950 live measurement: where a semantic probe loses its gold, read from the operator
// debug route (GET /api/admin/search-debug, #952). Read-only. Run by the operator inside a
// SEARCH_DEBUG=1 window (OPERATIONS.md section 7):
//
//   POSTERN_URL=https://mail.example POSTERN_TOKEN=<the both token> \
//     node eval/debug950.mjs [--class '^PR run failed:'] [--min 8] [--controls 3] [--json]
//
// Probes (fixed on #950 before the window):
//   class    every inbound message in the newest 80 whose subject matches --class. If fewer
//            than --min, the newest --min from the newest 200.
//   control  the newest --controls inbound messages of a unique template shape (no other
//            listed message shares the family) that are not in the class.
// Each probe is its own subject as the query, its own Message-ID as the gold. Calls per probe:
//   debug semantic limit=10   the production pool (topK 30)
//   debug semantic limit=50   the deepest pool with metadata (topK 50)
//   debug hybrid   limit=10   control: hybrid finds this class today
//   search semantic limit=10  FOUND as the replay counts it (strict row, or folded into `similar`)
//
// PRIVACY (primary): the output is counts, ranks, cosines and verdicts. It never prints a
// subject, a sender, a Message-ID or a vector id. Probes are numbered. The token is never
// printed. Mail read by the listing stays in this process.
import { pathToFileURL } from "node:url";
import { shapeKey } from "./shape813.mjs";

export const DEFAULTS = { classRe: "^PR run failed:", min: 8, controls: 3, window: 80, wideWindow: 200 };
export const CALLS = [
  { key: "sem10", mode: "semantic", limit: 10 },
  { key: "sem50", mode: "semantic", limit: 50 },
  { key: "hyb10", mode: "hybrid", limit: 10 },
];
/** A cosine is trusted only when the route recomputes rank 1 within this of Vectorize. */
export const SCORE_DELTA_MAX = 1e-3;

/** Pick the class probes and the controls from a newest-first inbound listing. */
export function selectProbes(listed, wide, opts = DEFAULTS) {
  const re = new RegExp(opts.classRe);
  const usable = (m) => typeof m?.messageId === "string" && m.messageId && (m.subject ?? "").trim();
  const isClass = (m) => re.test((m.subject ?? "").trim());
  let cls = listed.filter((m) => usable(m) && isClass(m));
  let source = "window";
  if (cls.length < opts.min && wide) {
    cls = wide.filter((m) => usable(m) && isClass(m)).slice(0, opts.min);
    source = "wide";
  }
  const counts = familyCounts(wide ?? listed);
  const controls = listed
    .filter((m) => usable(m) && !isClass(m) && (counts.get(shapeKey(m.from, m.subject)) ?? 1) === 1)
    .slice(0, opts.controls);
  return { cls, controls, source, counts };
}

export function familyCounts(listed) {
  const c = new Map();
  for (const m of listed) {
    const k = shapeKey(m.from, m.subject);
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return c;
}

/**
 * Read one debug response for one gold. rawMessageRank is 1 + the number of DISTINCT messages
 * in `raw` before the gold's first vector: the position the slice to `limit` cuts on
 * (store.ts nearestMessageIds). familyInRaw counts raw messages whose family (known from the
 * listing) equals the gold's.
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
  const delta = body.scoreCheck?.delta;
  return {
    verdict: g.verdict ?? null,
    rawMessageRank,
    rawVectorRank,
    rawMessages: seen.size,
    topK: body.topK ?? null,
    exhausted: body.exhausted ?? null,
    floorScore: round(body.floorScore),
    bestCosine: round(g.bestCosine),
    fusedRank: g.fusedRank ?? null,
    familyInRaw: familyIds.size,
    scoreDelta: typeof delta === "number" ? delta : null,
    scoreTrusted: typeof delta === "number" && delta < SCORE_DELTA_MAX,
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
 * The #950 decision table (fixed on the issue before the window), for one class probe.
 * sem10 is the production pool; sem50 is the depth test.
 */
export function classify(row, limit = 10) {
  const a = row.sem10;
  const b = row.sem50;
  if (!a || a.error) return "error";
  if (row.found) return "found";
  if (a.verdict === "in-raw") {
    if (a.rawMessageRank !== null && a.rawMessageRank > limit) return "H1-cut-before-tiebreak";
    return "post-retrieval-defect";
  }
  if (a.verdict === "outranked") return b && b.verdict === "in-raw" ? "H1-shallow-pool" : "outranked-at-50";
  return a.verdict ?? "unknown";
}

function round(x) {
  return typeof x === "number" ? Math.round(x * 1e4) / 1e4 : null;
}

/** The whole measurement. `get(path)` returns the parsed JSON body, or throws on non-2xx. */
export async function run(get, opts = DEFAULTS) {
  const fields = "fields=messageId,subject,date,from";
  const listed = (await get(`/api/messages?direction=inbound&limit=${opts.window}&${fields}`)).items ?? [];
  const wide = (await get(`/api/messages?direction=inbound&limit=${opts.wideWindow}&${fields}`)).items ?? [];
  const { cls, controls, source, counts } = selectProbes(listed, wide, opts);
  const famById = new Map();
  for (const m of [...wide, ...listed]) famById.set(m.messageId, shapeKey(m.from, m.subject));
  const familyOf = (id) => famById.get(id);

  const rows = [];
  const probes = [...cls.map((m) => ({ m, kind: "class" })), ...controls.map((m) => ({ m, kind: "control" }))];
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
    row.reading = kind === "class" ? classify(row) : controlOk(row) ? "control-ok" : "control-FAILED";
    rows.push(row);
  }
  return { source, listed: listed.length, wide: wide.length, classProbes: cls.length, controls: controls.length, rows };
}

/** A control must come back as the first message of the raw list in the production pool. */
export function controlOk(row) {
  return row.sem10?.verdict === "in-raw" && row.sem10?.rawMessageRank === 1 && row.sem10?.scoreTrusted === true;
}

/** Human summary: counts and the per-probe numbers. No content. */
export function summarize(res) {
  const out = [];
  out.push(`#950 debug: ${res.classProbes} class probes (from the ${res.source === "wide" ? "newest 200" : "newest 80"}), ${res.controls} controls; listed ${res.listed} / ${res.wide}`);
  const ctl = res.rows.filter((r) => r.kind === "control");
  const ctlOk = ctl.filter((r) => r.reading === "control-ok").length;
  out.push(`controls ok: ${ctlOk} of ${ctl.length}${ctlOk === ctl.length && ctl.length > 0 ? "" : "  << INSTRUMENT NOT TRUSTED: read nothing else"}`);
  const untrusted = res.rows.filter((r) => CALLS.some((c) => r[c.key] && !r[c.key].error && !r[c.key].scoreTrusted)).length;
  out.push(`probes with a scoreCheck delta >= ${SCORE_DELTA_MAX} on any call: ${untrusted}`);
  const tally = new Map();
  for (const r of res.rows.filter((x) => x.kind === "class")) tally.set(r.reading, (tally.get(r.reading) ?? 0) + 1);
  out.push(`class readings: ${[...tally].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  const hyb = res.rows.filter((r) => r.kind === "class" && r.hyb10?.verdict === "in-raw").length;
  out.push(`class probes in-raw under hybrid limit=10 (control): ${hyb} of ${res.classProbes}`);
  out.push("");
  out.push("probe kind    reading                   famListed | sem10: verdict  msgRank vecRank famInRaw best    floor   fused | sem50: verdict  msgRank | found strict");
  for (const r of res.rows) {
    const a = r.sem10 ?? {};
    const b = r.sem50 ?? {};
    out.push(
      [
        String(r.i).padStart(5),
        r.kind.padEnd(7),
        String(r.reading).padEnd(25),
        String(r.familyListed).padStart(9),
        "|",
        String(a.verdict ?? a.error ?? "-").padEnd(14),
        String(a.rawMessageRank ?? "-").padStart(7),
        String(a.rawVectorRank ?? "-").padStart(7),
        String(a.familyInRaw ?? "-").padStart(8),
        String(a.bestCosine ?? "-").padEnd(7),
        String(a.floorScore ?? "-").padEnd(7),
        String(a.fusedRank ?? "-").padStart(5),
        "|",
        String(b.verdict ?? b.error ?? "-").padEnd(14),
        String(b.rawMessageRank ?? "-").padStart(7),
        "|",
        String(r.found ?? "-").padEnd(5),
        String(r.strict ?? "-"),
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
    classRe: flag("--class") ?? DEFAULTS.classRe,
    min: Number(flag("--min") ?? DEFAULTS.min),
    controls: Number(flag("--controls") ?? DEFAULTS.controls),
  };
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    // The path carries the probe subject in its query string: print the route only.
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return res.json();
  };
  const res = await run(get, opts);
  console.log(summarize(res));
  if (args.includes("--json")) console.log(JSON.stringify(res.rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`debug950 failed: ${String(e.message ?? e).split("?")[0]}`);
    process.exit(1);
  });
}
