#!/usr/bin/env node
// projected_size backfill runner (#507).
//
// WHY THIS EXISTS. The IMAP door serves BODY[] from a rendered projection and
// announces RFC822.SIZE from the projected_size cached in D1. It only trusts a
// cached size whose stored projection_version matches the renderer it is running
// (imap/posternimap/message.py getSize). #507 bumps PROJECTION_VERSION, because the
// projection moved to CRLF line endings and every projected byte changed, so on the
// day that ships EVERY pre-existing row is a cache MISS.
//
// A miss is correct but expensive: the door hydrates the whole message (one
// GET /api/messages/{id}) to answer a single RFC822.SIZE, which is exactly the cost
// the #342 cache exists to remove, and a client that syncs sizes across the mailbox
// pays it per message. Nothing refills the cache on its own: refreshProjectedSize is
// only ever called at store time, and this repo has no backfill for it. This runner
// is that backfill. Measured scale at the time of writing: 10634 rows.
//
// It is a thin loop over POST /api/admin/reproject, which does one keyset page per
// call and returns a cursor. The worker recomputes each size through the SAME
// projection entry point live ingest uses (store.projectedSizeFor) and READS BACK
// every row it writes, so a write that did not land is reported as `failed` rather
// than counted as success.
//
// Usage (dry run, the DEFAULT -- reports exactly what would change, writes nothing):
//   POSTERN_BASE_URL=https://your-instance \
//   POSTERN_ADMIN_TOKEN=<both-scoped bearer> \
//     node scripts/reproject-sweep.mjs
//
// Usage (write -- requires --yes as an explicit second gate):
//   POSTERN_BASE_URL=https://your-instance \
//   POSTERN_ADMIN_TOKEN=<both-scoped bearer> \
//     node scripts/reproject-sweep.mjs --yes
//
// Flags:
//   --yes        switch from dry-run to writing. Without it nothing is written.
//   --limit N    rows per page (default: the worker default; the worker clamps it)
//   --max-pages N  refuse to run longer than N pages (default 5000). A safety valve,
//                  not a completion signal: hitting it is reported as an ERROR.
//   --json       emit the per-page results as JSON lines for a reviewer to diff
//
// Credentials come from the environment ONLY, never argv, and are never echoed.
//
// SAFE TO RE-RUN. Reprojection is idempotent: the same message projects to the same
// number, and a row already at the current version is counted `unchanged` and left
// alone. A run interrupted halfway can simply be run again from the start.

const baseUrl = required("POSTERN_BASE_URL").replace(/\/+$/, "");
const adminToken = required("POSTERN_ADMIN_TOKEN");

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const asJson = args.includes("--json");
const pageLimit = Number(flag("--limit") || 0) || 0;
const maxPages = Number(flag("--max-pages") || 0) || 5000;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} is required (no default; supply your own value)`);
    process.exit(2);
  }
  return v;
}
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
}

async function reprojectPage(body) {
  const res = await fetch(`${baseUrl}/api/admin/reproject`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status !== 200 || json?.ok !== true) {
    throw new Error(`reproject failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  console.log(`Postern projected_size reproject sweep against ${baseUrl}`);
  console.log(
    confirmed
      ? "MODE: WRITE (--yes)"
      : "MODE: dry-run (reports what would change; pass --yes to write)",
  );

  let cursor;
  let pages = 0;
  const totals = { processed: 0, updated: 0, unchanged: 0, missing: 0, failed: 0 };
  let storeTotal = null;

  for (;;) {
    const body = { dryRun: !confirmed };
    if (cursor) body.cursor = cursor;
    if (pageLimit) body.limit = pageLimit;

    const page = await reprojectPage(body);
    pages++;
    if (page.total !== undefined) storeTotal = page.total;
    for (const k of Object.keys(totals)) totals[k] += page[k] ?? 0;

    if (asJson) {
      console.log(JSON.stringify({ page: pages, ...page, cursor: undefined }));
    } else {
      const seen = storeTotal ? `${totals.processed}/${storeTotal}` : String(totals.processed);
      console.log(
        `  page ${pages}: ${seen} rows, +${page.updated} updated, ${page.unchanged} unchanged` +
          (page.missing ? `, ${page.missing} missing` : "") +
          (page.failed ? `, ${page.failed} FAILED` : ""),
      );
    }

    if (page.done === true) break;

    // The cursor field is `nextCursor` and is only meaningful while done is false.
    // Reading a differently named field here is the exact trap that silently stopped
    // an earlier sweep at 50 of 64 rows: it looked like a clean finish. So a page
    // that says it is NOT done and yet hands back no usable cursor is an ERROR, never
    // a quiet exit.
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0) {
      console.error(
        `FATAL: page ${pages} reported done=false but returned no nextCursor ` +
          `(got ${JSON.stringify(page.nextCursor)}). Refusing to report a partial ` +
          `sweep as complete.`,
      );
      process.exit(1);
    }
    cursor = page.nextCursor;

    if (pages >= maxPages) {
      console.error(
        `FATAL: stopped after ${pages} pages (--max-pages). The sweep is INCOMPLETE; ` +
          `re-run to continue (it is idempotent).`,
      );
      process.exit(1);
    }
  }

  const scope = storeTotal === null ? "?" : String(storeTotal);
  console.log(
    `\n${pages} page(s), ${totals.processed} of ${scope} row(s) examined: ` +
      `${totals.updated} ${confirmed ? "updated" : "would be updated"}, ` +
      `${totals.unchanged} already current, ${totals.missing} missing, ${totals.failed} failed.`,
  );

  // storeTotal is a COUNT(*) sampled once, at the START of the sweep, before this
  // page's rows were even read (store.ts reprojectPage, #515). That ordering makes
  // it a lower bound AT THAT INSTANT, but a live mailbox does not only grow: CI's
  // smoke self-clean, hand-run debris sweeps, and IMAP EXPUNGE all delete rows too,
  // and a row deleted mid-run can never be walked once it is gone -- comparing
  // processed to the START total alone would FATAL on a sweep that genuinely
  // covered everything that still exists, the same false-failure class this guard
  // exists to kill, just through deletion instead of growth. So re-sample the
  // total again now, at the END, with one cheap dry-run page (writes nothing,
  // reads at most one row), and check completeness against whichever of the two
  // totals is SMALLER: growth only ever raises the end total (start is then the
  // binding constraint), deletion only ever lowers it (end is then the binding
  // constraint), and a genuinely truncated walk (the bug class above: a renamed or
  // dropped cursor field once stopped a different sweep script quietly at 50 of 64
  // rows) falls short of BOTH.
  let endTotal = null;
  if (storeTotal !== null) {
    try {
      const recheck = await reprojectPage({ dryRun: true, limit: 1 });
      if (typeof recheck.total === "number") endTotal = recheck.total;
    } catch (e) {
      console.error(
        `WARNING: could not re-sample the store total at the end of the run (${e.message}). ` +
          `Falling back to the start-of-run total only -- this run cannot distinguish a ` +
          `deleted-row shortfall from a genuinely incomplete walk.`,
      );
    }
  }
  const floorTotal =
    storeTotal === null ? null : endTotal === null ? storeTotal : Math.min(storeTotal, endTotal);

  if (floorTotal !== null && totals.processed < floorTotal) {
    console.error(
      `FATAL: examined ${totals.processed} rows but ${floorTotal} were guaranteed present ` +
        `throughout this run (start total ${storeTotal}, end total ${endTotal ?? "not re-sampled"}). ` +
        `The sweep did NOT cover the whole mailbox.`,
    );
    process.exit(1);
  }
  if (floorTotal !== null && totals.processed !== floorTotal) {
    const drift =
      endTotal !== null && endTotal !== storeTotal
        ? ` (start total ${storeTotal}, end total ${endTotal}, ${endTotal > storeTotal ? "grew" : "shrank"} by ${Math.abs(endTotal - storeTotal)} during the run)`
        : "";
    console.log(
      `NOTE: examined ${totals.processed} rows, ${totals.processed - floorTotal} more than ` +
        `the ${floorTotal} row(s) floor${drift}. That is expected on a live mailbox -- mail ` +
        `arriving during the run is already at the current projection version and never ` +
        `needed this sweep, and a row deleted during the run never needed it either. It does ` +
        `not indicate missed rows.`,
    );
  }
  if (totals.failed > 0) {
    console.error(
      `FATAL: ${totals.failed} row(s) did not verify on read-back. The sweep is not clean.`,
    );
    process.exit(1);
  }
  if (!confirmed) {
    console.log("\nDry run only. Nothing was written. Re-run with --yes to apply.");
  }
}

main().catch((e) => {
  console.error("unexpected error:", e?.stack || String(e));
  process.exit(1);
});
