#!/usr/bin/env node
// Backfill runner (#116 ws4): drive POST /api/admin/reindex one page at a time
// until the whole mailbox is (re)embedded into Vectorize. The worker does the
// work (it holds the AI + VECTORIZE bindings); this is just the loop.
//
// Usage:
//   POSTERN_API_BASE=https://mail.example POSTERN_API_TOKEN=<both-scoped> \
//     node reindex.mjs [--dry-run] [--limit N] [--pause MS]
//
// --dry-run  count the chunks/vectors WITHOUT embedding (exact cost up front)
// --limit N  messages per page (server clamps to 1..50; default 25)
// --pause MS sleep between pages (default 0); raise it if Workers AI rate-limits
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
const limit = numFlag("--limit");
const pause = numFlag("--pause") ?? 0;

function numFlag(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let cursor;
  let total;
  let processed = 0;
  let indexed = 0;
  let vectors = 0;
  let skipped = 0;
  let page = 0;

  for (;;) {
    const body = { dryRun };
    if (cursor) body.cursor = cursor;
    if (limit) body.limit = limit;

    const res = await fetch(`${base}/api/admin/reindex`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`page ${page} failed: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const r = await res.json();
    page++;
    if (total === undefined && typeof r.total === "number") total = r.total;
    processed += r.processed;
    indexed += r.indexed;
    vectors += r.vectors;
    skipped += r.skippedByGate;

    const pct = total ? ` (${Math.min(100, Math.round((processed / total) * 100))}%)` : "";
    console.log(
      `page ${page}: processed ${processed}${total ? "/" + total : ""}${pct}, ` +
        `${dryRun ? "would-embed" : "indexed"} ${indexed}, vectors ${vectors}, skippedByGate ${skipped}`,
    );

    if (r.done) break;
    cursor = r.nextCursor;
    if (pause > 0) await sleep(pause);
  }

  console.log(
    `DONE${dryRun ? " (dry run -- nothing embedded)" : ""}: ${processed} messages, ` +
      `${indexed} ${dryRun ? "would be " : ""}indexed, ${vectors} vectors, ${skipped} skipped by the allowlist.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
