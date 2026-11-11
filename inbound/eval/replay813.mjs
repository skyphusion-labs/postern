// #813 live replay: the issue's known-item probe against a REAL deploy, before and after the
// re-embed. Read-only (GET /api/messages and GET /api/search). Run by the operator:
//
//   POSTERN_URL=https://mail.example POSTERN_TOKEN=... \
//     node eval/replay813.mjs [--n 8] [--queries paraphrase.json] [--show] [--json] > result.txt
//
// Known-item probe: the N newest INBOUND messages, each searched by its own subject.
//   FOUND  (the primary metric, #940): the messageId is in the top 10, or folded into a top-10
//          hit's `similar` ids. Semantic folds a template family into one hit by default
//          (collapse), so when the gold is one of several same-template messages, a sibling
//          stands for the group and the gold is one expand away. That is the designed answer,
//          and strict counts it as a miss.
//   STRICT the messageId is itself a top-10 row. Still printed: it is the right metric for
//          collapse=0, and for a probe whose subject shape is unique.
//   SHAPE  each known-item probe is "repeated" when another message in the listed window
//          shares its template family (eval/shape813.mjs, the server's semrank key), else
//          "unique". A miss on a unique shape is a real recall miss; a strict miss on a
//          repeated shape is usually the group being represented by a sibling.
// --queries adds a file of [{ "q": "...", "gold": ["<messageId>", ...] }] for paraphrased
// queries. Mail content stays local: the summary prints counts and latencies only; --show also
// prints each probe's subject to THIS terminal; --json also prints the per-probe rows (ranks,
// shape and latencies, no content) as JSON. The token is never printed.
import { readFileSync } from "node:fs";
import { shapeKey } from "./shape813.mjs";

const base = (process.env.POSTERN_URL ?? "").replace(/\/+$/, "");
const token = process.env.POSTERN_TOKEN;
if (!base || !token) {
  console.error("need POSTERN_URL and POSTERN_TOKEN (the token is never printed)");
  process.exit(2);
}
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const n = Number(flag("--n") ?? 8);
const show = args.includes("--show");
const MODES = [
  ["fts", "mode=fts"],
  ["hybrid", "mode=hybrid"],
  ["semantic", "mode=semantic"],
  ["semantic collapse=0", "mode=semantic&collapse=0"],
];

async function get(path) {
  const t0 = performance.now();
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} failed: HTTP ${res.status}`);
  return { body: await res.json(), ms };
}

const window = Math.max(n * 3, 25);
const list = await get(`/api/messages?direction=inbound&limit=${window}&fields=messageId,subject,date,from`);
const listed = list.body.items ?? [];
const shapeCount = new Map();
for (const m of listed) {
  const k = shapeKey(m.from, m.subject);
  shapeCount.set(k, (shapeCount.get(k) ?? 0) + 1);
}
const probes = listed
  .filter((m) => (m.subject ?? "").trim())
  .slice(0, n)
  .map((m) => ({
    q: m.subject,
    gold: [m.messageId],
    family: "known-item",
    shape: (shapeCount.get(shapeKey(m.from, m.subject)) ?? 1) > 1 ? "repeated" : "unique",
  }));
const extra = flag("--queries") ? JSON.parse(readFileSync(flag("--queries"), "utf8")).map((x) => ({ ...x, family: "paraphrase", shape: "-" })) : [];
const all = [...probes, ...extra];

const rows = [];
for (const [label, mode] of MODES) {
  for (const [i, p] of all.entries()) {
    let r;
    try {
      r = await get(`/api/search?q=${encodeURIComponent(p.q)}&${mode}&limit=10`);
    } catch (e) {
      // A deploy from before #813 refuses collapse=0: that column is then "n/a", not a miss.
      rows.push({ label, family: p.family, shape: p.shape, i, error: String(e.message) });
      continue;
    }
    const items = r.body.items ?? [];
    const gold = new Set(p.gold);
    const strict = items.findIndex((h) => gold.has(h.message.messageId));
    const surfaced = items.findIndex((h) => gold.has(h.message.messageId) || (h.similar?.ids ?? []).some((id) => gold.has(id)));
    rows.push({ label, family: p.family, shape: p.shape, i, strict, surfaced, ms: Math.round(r.ms) });
    if (show) console.log(`${label.padEnd(20)} #${i} ${p.shape.padEnd(8)} ${strict >= 0 ? `hit@${strict + 1}` : surfaced >= 0 ? `found@${surfaced + 1}` : "NOT FOUND"}  ${p.q}`);
  }
}

const groups = [
  ["known-item", (r) => r.family === "known-item"],
  ["  unique shape", (r) => r.family === "known-item" && r.shape === "unique"],
  ["  repeated shape", (r) => r.family === "known-item" && r.shape === "repeated"],
  ["paraphrase", (r) => r.family === "paraphrase"],
];
console.log(`\nFOUND is the primary metric (#940): gold in the top 10, or folded into a top-10 hit's \`similar\`.`);
console.log(`STRICT counts only top-10 rows. Shape is "repeated" when another of the ${listed.length} newest inbound messages shares the template family.`);
console.log("\n| mode | probes | found | strict | not found | mean latency |\n|---|---|---|---|---|---|");
for (const [label] of MODES) {
  for (const [gname, pick] of groups) {
    const rs = rows.filter((r) => r.label === label && pick(r));
    if (!rs.length) continue;
    if (rs.some((r) => r.error)) { console.log(`| ${label} | ${gname} | n/a (${rs.find((r) => r.error).error}) | | | |`); continue; }
    const found = rs.filter((r) => r.surfaced >= 0).length;
    const hit = rs.filter((r) => r.strict >= 0).length;
    const ms = rs.reduce((s, r) => s + r.ms, 0) / rs.length;
    console.log(`| ${label} | ${gname} | ${found}/${rs.length} | ${hit}/${rs.length} | ${rs.length - found} | ${(ms / 1000).toFixed(2)}s |`);
  }
}
if (args.includes("--json")) console.log(JSON.stringify(rows.map(({ label, family, shape, i, strict, surfaced, ms, error }) => ({ label, family, shape, i, strict, surfaced, ms, error }))));
