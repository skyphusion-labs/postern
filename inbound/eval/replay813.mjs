// #813 live replay: the issue's known-item probe against a REAL deploy, before and after the
// re-embed. Read-only (GET /api/messages and GET /api/search). Run by the operator:
//
//   POSTERN_URL=https://mail.example POSTERN_TOKEN=... \
//     node eval/replay813.mjs [--n 8] [--queries paraphrase.json] [--show] [--json] > result.txt
//
// Known-item probe: the N newest INBOUND messages, each searched by its own subject; a hit
// is that messageId in the top 10 (strict), or folded into a top-10 hit's `similar` ids
// (surfaced). --queries adds a file of [{ "q": "...", "gold": ["<messageId>", ...] }] for
// paraphrased queries. Mail content stays local: the summary prints counts and latencies
// only; --show also prints each probe's subject to THIS terminal; --json also prints the per-probe
// rows (ranks and latencies, no content) as JSON. The token is never printed.
import { readFileSync } from "node:fs";

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

const list = await get(`/api/messages?direction=inbound&limit=${Math.max(n * 3, 25)}&fields=messageId,subject,date`);
const probes = list.body.items.filter((m) => (m.subject ?? "").trim()).slice(0, n).map((m) => ({ q: m.subject, gold: [m.messageId], family: "known-item" }));
const extra = flag("--queries") ? JSON.parse(readFileSync(flag("--queries"), "utf8")).map((x) => ({ ...x, family: "paraphrase" })) : [];
const all = [...probes, ...extra];

const rows = [];
for (const [label, mode] of MODES) {
  for (const [i, p] of all.entries()) {
    let r;
    try {
      r = await get(`/api/search?q=${encodeURIComponent(p.q)}&${mode}&limit=10`);
    } catch (e) {
      // A deploy from before #813 refuses collapse=0: that column is then "n/a", not a miss.
      rows.push({ label, family: p.family, i, error: String(e.message) });
      continue;
    }
    const items = r.body.items ?? [];
    const gold = new Set(p.gold);
    const strict = items.findIndex((h) => gold.has(h.message.messageId));
    const surfaced = items.findIndex((h) => gold.has(h.message.messageId) || (h.similar?.ids ?? []).some((id) => gold.has(id)));
    rows.push({ label, family: p.family, i, strict, surfaced, ms: Math.round(r.ms) });
    if (show) console.log(`${label.padEnd(20)} #${i} ${strict >= 0 ? `hit@${strict + 1}` : surfaced >= 0 ? `surfaced@${surfaced + 1}` : "MISS"}  ${p.q}`);
  }
}
console.log("\n| mode | family | hits (strict) | surfaced | mean latency |\n|---|---|---|---|---|");
for (const [label] of MODES) {
  for (const family of ["known-item", "paraphrase"]) {
    const rs = rows.filter((r) => r.label === label && r.family === family);
    if (!rs.length) continue;
    if (rs.some((r) => r.error)) { console.log(`| ${label} | ${family} | n/a (${rs.find((r) => r.error).error}) | | |`); continue; }
    const hit = rs.filter((r) => r.strict >= 0).length;
    const sur = rs.filter((r) => r.surfaced >= 0).length;
    const ms = rs.reduce((s, r) => s + r.ms, 0) / rs.length;
    console.log(`| ${label} | ${family} | ${hit}/${rs.length} | ${sur}/${rs.length} | ${(ms / 1000).toFixed(2)}s |`);
  }
}
if (args.includes("--json")) console.log(JSON.stringify(rows.map(({ label, family, i, strict, surfaced, ms, error }) => ({ label, family, i, strict, surfaced, ms, error }))));
