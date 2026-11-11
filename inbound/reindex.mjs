#!/usr/bin/env node
// Backfill runner (#116 ws4): drive POST /api/admin/reindex one page at a time
// until the whole mailbox is (re)embedded into Vectorize. The worker does the
// work (it holds the AI + VECTORIZE bindings); this is just the loop.
//
// Usage:
//   POSTERN_API_BASE=https://mail.example POSTERN_API_TOKEN=<both-scoped> \
//     node reindex.mjs [--dry-run] [--stale-only] [--limit N] [--pause MS]
//
// --dry-run  count the chunks/vectors WITHOUT embedding (exact cost up front)
// --stale-only  re-embed only messages below the current embed recipe (#813), so an
//               interrupted re-embed resumes without paying twice
// --limit N  messages per page (server clamps to 1..50; default 25)
// --pause MS sleep between pages (default 0); raise it if Workers AI rate-limits
// --cursor C  resume from a page cursor printed by an earlier run (each page line ends with it)
// A page that fails on the network (including mid-body) or with HTTP 5xx is tried up to 6 times
// (5 retries, waits 2 s to 32 s), so
// one connection reset does not end a long run and send the next run back to page 0.
//
// The token MUST be a `both`-scoped mailbox token (#85): reindex is an admin route.
// Idempotent + resumable: re-running is safe (deterministic vector ids overwrite).

const base = (process.env.POSTERN_API_BASE || "").replace(/\/$/, "");
const token = process.env.POSTERN_API_TOKEN || "";
if (!base || !token) {
  console.error("set POSTERN_API_BASE and POSTERN_API_TOKEN");
  process.exit(2);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const staleOnly = args.includes("--stale-only");
const limit = numFlag("--limit");
const pause = numFlag("--pause") ?? 0;
const startCursor = strFlag("--cursor");

function strFlag(name) {
  const i = args.indexOf(name);
  const v = i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  if (v !== undefined && v.startsWith("--")) {
    console.error(`${name} needs a value (got ${v})`);
    process.exit(2);
  }
  return v;
}

function numFlag(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let cursor = startCursor;
  let total;
  let processed = 0;
  let indexed = 0;
  let vectors = 0;
  let skipped = 0;
  let current = 0;
  let page = 0;

  for (;;) {
    const body = { dryRun, staleOnly };
    if (cursor) body.cursor = cursor;
    if (limit) body.limit = limit;

    let res;
    let r;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(`${base}/api/admin/reindex`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status < 500) {
          // Read the body inside the retry: a reset mid-body is the same failure as a reset
          // before it. The route is idempotent, so sending the page again is safe.
          if (res.ok) r = await res.json();
          break;
        }
        console.error(`page ${page + 1} attempt ${attempt}: HTTP ${res.status}`);
      } catch (e) {
        console.error(`page ${page + 1} attempt ${attempt}: ${e.cause?.code ?? e.message}`);
      }
      if (attempt >= 6) {
        console.error(`page ${page + 1} gave up; resume with --cursor ${cursor ?? "(start)"}`);
        process.exit(1);
      }
      await sleep(1000 * 2 ** attempt);
    }
    if (!res.ok) {
      console.error(`page ${page + 1} failed: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    page++;
    if (total === undefined && typeof r.total === "number") total = r.total;
    processed += r.processed;
    indexed += r.indexed;
    vectors += r.vectors;
    skipped += r.skippedByGate;
    current += r.skippedCurrent ?? 0;

    const pct = total ? ` (${Math.min(100, Math.round((processed / total) * 100))}%)` : "";
    console.log(
      `page ${page}: processed ${processed}${total ? "/" + total : ""}${pct}, ` +
        `${dryRun ? "would-embed" : "indexed"} ${indexed}, vectors ${vectors}, skippedByGate ${skipped}` +
        (r.nextCursor ? `, cursor ${r.nextCursor}` : ""),
    );

    if (r.done) break;
    cursor = r.nextCursor;
    if (pause > 0) await sleep(pause);
  }

  console.log(
    `DONE${dryRun ? " (dry run -- nothing embedded)" : ""}: ${processed} messages, ` +
      `${indexed} ${dryRun ? "would be " : ""}indexed, ${vectors} vectors, ${skipped} skipped by the allowlist` +
      (staleOnly ? `, ${current} already at the current recipe.` : "."),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
