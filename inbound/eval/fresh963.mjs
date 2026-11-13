// #963 (a): how long a fresh message takes to become findable in semantic search. Passive and
// read-only: it sends no mail. Run by the operator inside a SEARCH_DEBUG=1 window
// (docs/OPERATIONS.md section 7), on a deploy whose debug route gives `index`, `serverNowMs` and
// the gold's `upsertedMs` (#963):
//
//   POSTERN_URL=https://mail.example POSTERN_TOKEN=<the both token> \
//     node eval/fresh963.mjs [--minutes 30] [--poll 5] [--list-every 30] [--max-wait 600] [--json]
//
// It lists the newest inbound messages every --list-every seconds. A message that was not in the
// first listing is NEW: from then on, every --poll seconds, it reads the operator debug route for
// it (semantic, its own subject as q, its Message-ID as gold) and the shipped semantic search,
// until the search FINDS it (row or `similar`, as replay813 counts) or --max-wait passes.
//
// Every time is the WORKER's clock: the gold's upsertedMs and each answer's serverNowMs. So a gap
// never mixes this machine's clock with the Worker's. Per message:
//   processedS  serverNowMs of the first answer that says the index processed past the upsert
//               (gold.pending false), minus upsertedMs
//   foundS      serverNowMs of the first answer whose search FOUND it, minus upsertedMs
//   firstSeenS  how old it already was when the driver first read it (the resolution floor)
// The resolution is one poll. The decision table (#963 design) reads p95 and max of foundS.
//
// PRIVACY (primary): the output is counts, seconds and verdict sequences. It never prints a
// subject, a sender, a Message-ID or a vector id. The token is never printed.
import { pathToFileURL } from "node:url";

export const DEFAULTS = { minutes: 30, poll: 5, listEvery: 30, maxWait: 600, window: 25 };

/** The decision rows of the #963 design, fixed before the measurement. */
export function decide(found) {
  const xs = found.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (xs.length < 10) return { row: "too-few", n: xs.length };
  const p95 = xs[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)];
  const max = xs[xs.length - 1];
  return { row: p95 <= 30 && max <= 120 ? "no-change" : "semantic-adds-fresh-fts", n: xs.length, p95, max };
}

function pct(xs, p) {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

/**
 * The measurement. `get(path)` returns the parsed body or throws; `sleep(ms)` waits; `now()` is
 * this machine's clock, used only to pace the loop, never in a gap.
 */
export async function track(get, sleep, now, opts = DEFAULTS) {
  const fields = "fields=messageId,subject,date";
  const list = async () => (await get(`/api/messages?direction=inbound&limit=${opts.window}&${fields}`)).items ?? [];
  const known = new Set((await list()).map((m) => m.messageId));
  const tracked = new Map(); // messageId -> state
  const start = now();
  const end = start + opts.minutes * 60_000;
  let nextList = start + opts.listEvery * 1000;
  let errors = 0;
  while (now() < end) {
    if (now() >= nextList) {
      nextList = now() + opts.listEvery * 1000;
      for (const m of await list()) {
        if (known.has(m.messageId) || !m.messageId || !(m.subject ?? "").trim()) continue;
        known.add(m.messageId);
        tracked.set(m.messageId, { subject: m.subject, n: tracked.size + 1, verdicts: [], upsertedMs: null, firstSeenMs: null, processedMs: null, foundMs: null, done: false, timeout: false, started: now() });
      }
    }
    for (const [id, t] of tracked) {
      if (t.done) continue;
      try {
        const d = await get(`/api/admin/search-debug?${new URLSearchParams({ q: t.subject, gold: id, mode: "semantic", limit: "10" })}`);
        const s = await get(`/api/search?${new URLSearchParams({ q: t.subject, mode: "semantic", limit: "10" })}`);
        const g = d?.gold ?? {};
        const at = typeof d?.serverNowMs === "number" ? d.serverNowMs : null;
        if (typeof g.upsertedMs === "number") t.upsertedMs = g.upsertedMs;
        if (t.firstSeenMs === null && at !== null) t.firstSeenMs = at;
        const v = g.verdict ?? "none";
        if (t.verdicts[t.verdicts.length - 1] !== v) t.verdicts.push(v);
        if (t.processedMs === null && g.pending === false && at !== null) t.processedMs = at;
        const items = s?.items ?? [];
        const found = items.some((h) => h?.message?.messageId === id || (h?.similar?.ids ?? []).includes(id));
        if (found && at !== null) {
          t.foundMs = at;
          t.done = true;
        }
      } catch {
        errors += 1;
      }
      if (!t.done && now() - t.started > opts.maxWait * 1000) {
        t.done = true;
        t.timeout = true;
      }
    }
    await sleep(opts.poll * 1000);
  }
  const rows = [...tracked.values()].map((t) => {
    const rel = (x) => (x !== null && t.upsertedMs !== null ? Math.round((x - t.upsertedMs) / 100) / 10 : null);
    return { n: t.n, firstSeenS: rel(t.firstSeenMs), processedS: rel(t.processedMs), foundS: rel(t.foundMs), verdicts: t.verdicts, timeout: t.timeout, noUpsertTime: t.upsertedMs === null };
  });
  return { minutes: opts.minutes, poll: opts.poll, tracked: rows.length, errors, rows };
}

/** Human summary: counts, seconds, the decision row. No content. */
export function summarize(res) {
  const found = res.rows.map((r) => r.foundS);
  const proc = res.rows.map((r) => r.processedS);
  const d = decide(found);
  const out = [];
  out.push(`#963 fresh: ${res.tracked} new messages in ${res.minutes} min (poll ${res.poll} s), ${res.errors} failed reads`);
  const noTime = res.rows.filter((r) => r.noUpsertTime).length;
  if (noTime) out.push(`messages with no upsertedMs: ${noTime}  << the deployed route predates #963, or the binding returns no mutation; deploy it first`);
  out.push(`found:     n ${found.filter((x) => x !== null).length}, p50 ${pct(found, 0.5)} s, p95 ${pct(found, 0.95)} s, max ${pct(found, 1)} s, not found in the wait ${res.rows.filter((r) => r.timeout).length}`);
  out.push(`processed: n ${proc.filter((x) => x !== null).length}, p50 ${pct(proc, 0.5)} s, p95 ${pct(proc, 0.95)} s, max ${pct(proc, 1)} s`);
  const lag = res.rows.filter((r) => r.foundS !== null && r.processedS !== null && r.foundS - r.processedS > res.poll).length;
  out.push(`found more than one poll after "processed": ${lag}${lag ? "  << processedUpToDatetime is not a safe signal (design row 3)" : ""}`);
  const floor = res.rows.map((r) => r.firstSeenS).filter((x) => x !== null);
  out.push(`age at first read (resolution floor): p50 ${pct(floor, 0.5)} s, max ${pct(floor, 1)} s`);
  out.push(`decision: ${d.row}${d.p95 !== undefined ? ` (p95 ${d.p95} s, max ${d.max} s, n ${d.n})` : ` (n ${d.n}; at least 10 needed)`}`);
  out.push("");
  out.push("  n firstSeenS processedS foundS timeout verdicts");
  for (const r of res.rows) out.push(`${String(r.n).padStart(3)} ${String(r.firstSeenS ?? "-").padStart(10)} ${String(r.processedS ?? "-").padStart(10)} ${String(r.foundS ?? "-").padStart(6)} ${String(r.timeout).padEnd(7)} ${r.verdicts.join(">")}`);
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
  const flag = (name, d) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : d;
  };
  const opts = { ...DEFAULTS, minutes: flag("--minutes", DEFAULTS.minutes), poll: flag("--poll", DEFAULTS.poll), listEvery: flag("--list-every", DEFAULTS.listEvery), maxWait: flag("--max-wait", DEFAULTS.maxWait) };
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    // The path carries a subject and a Message-ID in its query string: print the route only.
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return res.json();
  };
  const res = await track(get, (ms) => new Promise((r) => setTimeout(r, ms)), () => Date.now(), opts);
  console.log(summarize(res));
  if (args.includes("--json")) console.log(JSON.stringify(res.rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`fresh963 failed: ${String(e.message ?? e).split("?")[0]}`);
    process.exit(1);
  });
}
