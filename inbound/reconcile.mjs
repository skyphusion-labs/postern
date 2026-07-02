#!/usr/bin/env node
// Reconcile / orphan-vector audit runner (#134): drive POST /api/admin/reconcile
// and print the dry-run report. READ-ONLY -- this NEVER deletes a vector. The worker
// does the work (it holds the D1 + VECTORIZE bindings); this is just the caller.
//
// Usage:
//   POSTERN_API_BASE=https://postern.skyphusion.org POSTERN_API_TOKEN=<both-scoped> \
//     node reconcile.mjs [--no-verify] [--sample N] [--ids] [--json]
//
// --no-verify  skip the getByIds presence check (cheaper; orphanCount then falls back
//              to expectedVectors instead of the verified-present count)
// --sample N   live vectors to use as similarity probes for cause sampling (default 32; 0 disables)
// --ids        include the concrete (PARTIAL) orphan id set in the report
// --json       print the raw JSON report instead of the human summary
//
// The token MUST be a `both`-scoped mailbox token (#85): reconcile is an admin route.
// There is NO prune here. Deleting the orphans is a SEPARATE, Conrad-supervised, gated
// step -- see docs/reconcile-orphan-vectors.md for the proposed plan.

const base = (process.env.POSTERN_API_BASE || "").replace(/\/$/, "");
const token = process.env.POSTERN_API_TOKEN || "";
if (!base || !token) {
  console.error("set POSTERN_API_BASE and POSTERN_API_TOKEN");
  process.exit(2);
}

const args = process.argv.slice(2);
const verify = !args.includes("--no-verify");
const includeOrphanIds = args.includes("--ids");
const asJson = args.includes("--json");
const sampleSize = numFlag("--sample");

function numFlag(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const body = { verify, includeOrphanIds };
  if (sampleSize !== undefined) body.sampleSize = sampleSize;

  const res = await fetch(`${base}/api/admin/reconcile`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // Custom UA: the CF WAF 403s a default node/undici UA on this estate.
      "user-agent": "postern-reconcile/1 (#134 orphan-vector audit)",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`reconcile failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const r = await res.json();

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const cause = {
    a: "(a) deleted-message orphans (no live message behind them)",
    b: "(b) pre-#116 id scheme (message still live, stale vector id)",
    mixed: "MIXED: both deleted-message (a) AND pre-#116 (b) orphans seen",
    indeterminate: "INDETERMINATE: the sample surfaced no classifiable orphan",
  }[r.causeDetermination] || r.causeDetermination;

  console.log("Postern Vectorize reconcile (#134) -- READ-ONLY, nothing deleted");
  console.log("-".repeat(64));
  console.log(`messages in D1:        ${r.messages}`);
  console.log(`  gated (indexable):   ${r.gatedMessages}`);
  console.log(`expected vectors:      ${r.expectedVectors}`);
  console.log(`live vectors (index):  ${r.liveVectorCount}`);
  if (r.verified) {
    console.log(`expected present:      ${r.presentExpected}`);
    console.log(`expected MISSING:      ${r.missingExpected}${r.missingExpected ? "  <-- UNDER-coverage, investigate" : ""}`);
    if (r.missingExpectedSample && r.missingExpectedSample.length) {
      console.log(`  missing sample:      ${r.missingExpectedSample.join(", ")}`);
    }
  } else {
    console.log(`expected present:      (not verified -- --no-verify)`);
  }
  console.log(`ORPHAN COUNT:          ${r.orphanCount}`);
  console.log(`enumerable as a set:   ${r.enumerable}  (Vectorize has no list API)`);
  console.log("-".repeat(64));
  console.log("cause sampling:");
  console.log(`  probes:              ${r.sample.probes}`);
  console.log(`  matches inspected:   ${r.sample.matchesInspected}`);
  console.log(`  distinct orphans:    ${r.sample.distinctOrphans}`);
  console.log(`  cause (a) deleted:   ${r.sample.causeA}`);
  console.log(`  cause (b) old id:    ${r.sample.causeB}`);
  console.log(`  unclassifiable:      ${r.sample.unknown}`);
  console.log(`  determination:       ${cause}`);
  if (includeOrphanIds && r.sample.orphanIds && r.sample.orphanIds.length) {
    console.log(`  orphan ids (PARTIAL, ${r.sample.orphanIds.length}):`);
    for (const id of r.sample.orphanIds) console.log(`    ${id}`);
  }
  console.log("-".repeat(64));
  console.log(r.note);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
