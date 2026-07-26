#!/usr/bin/env node
// Prod-mailbox smoke-debris sweep (tracking issue: see repo issue tracker,
// filed sprint 8; parked since sprint 4, #483).
//
// inbound/smoke.mjs (the v1.0 acceptance smoke, run by smoke-staging.yml
// nightly and by deploy.yml tag-deploy live probe) creates real messages in
// the production mailbox every run. Its own leg 10 cleanup only fires when
// POSTERN_DELETE_TOKEN is set on the run -- and neither
// .github/workflows/deploy.yml nor .github/workflows/smoke-staging.yml sets
// that secret today, so cleanup never runs in CI, pass or fail. Every smoke
// run against production (nightly plus tag-deploy probe, back to whichever
// run first had POSTERN_SMOKE_* secrets configured) has left probe messages
// behind. This is broader than "failed runs never reach cleanup" (#483
// framing): a fully green run leaves debris too, because the cleanup leg is
// opt-in and nothing opts it in.
//
// This script only LISTS or DELETES messages matching the smoke probe exact
// subject signature (derived from inbound/smoke.mjs, not guessed):
//
//   const tag = `postern-smoke ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 10)}`;
//
// That literal format has been stable since the smoke script original
// commit (ac42e62, issue #25) through the current HEAD (checked via
// `git log -p -- inbound/smoke.mjs`; the tag line is untouched across every
// v1.2.x and v1.3.x commit that touched the file). Every message the smoke
// run creates has a subject of the exact form:
//
//   postern-smoke <ISO-8601 timestamp> <base36 token> send
//   Re: postern-smoke <ISO-8601 timestamp> <base36 token> send        (leg 3, reply)
//   postern-smoke <ISO-8601 timestamp> <base36 token> attachment      (leg 8)
//   postern-smoke <ISO-8601 timestamp> <base36 token> inbound         (leg 4, --expect-inbound only; not used by either workflow today)
//   postern-smoke <ISO-8601 timestamp> <base36 token> draft           (leg 9; needs POSTERN_IDENTITY_TOKEN, not set by either workflow today, so drafts are never created by CI smoke runs)
//   postern-smoke <ISO-8601 timestamp> <base36 token> draft v2        (leg 9, PUT)
//
// In the two workflows that actually run against production today, only the
// "send", "Re: ... send", and "attachment" subjects are ever produced (the
// identity and expect-inbound legs are both dark). The other two forms are
// included in the match regex anyway because they are real signatures the
// smoke script itself can produce, not guesses; if the drafts leg is ever
// wired to a per-identity token, or --expect-inbound to a real domain, this
// script stays correct without a rewrite.
//
// SMOKE_SUBJECT_RE anchors the whole subject: it cannot match a real message
// from a human sender (nobody hand-writes an ISO-8601 timestamp plus a random
// base36 token into a subject line) and it cannot partially match a message
// that merely mentions "postern-smoke" in passing. This is deliberately NOT a
// substring or fuzzy match.
//
// Usage (dry run, the default -- LISTS candidates, changes nothing):
//   POSTERN_BASE_URL=https://your-instance \
//   POSTERN_API_TOKEN=<read-scoped or both-scoped bearer> \
//     node scripts/smoke-debris-sweep.mjs
//
// Usage (delete -- requires BOTH --delete and --yes, plus a delete-scoped token):
//   POSTERN_BASE_URL=https://your-instance \
//   POSTERN_API_TOKEN=<read-scoped or both-scoped bearer> \
//   POSTERN_DELETE_TOKEN=<delete-scoped bearer> \
//     node scripts/smoke-debris-sweep.mjs --delete --yes
//
// Flags:
//   --delete   switch from list-only to hard-delete mode (still prints the
//              full candidate list first; requires POSTERN_DELETE_TOKEN)
//   --yes      required alongside --delete as a second explicit gate; delete
//              mode with --delete but no --yes refuses to run
//   --json     print the candidate list as JSON (id/subject/date/direction)
//              instead of a human table; useful for a reviewer to diff runs
//   --limit N  stop after N matches (default: no cap, pages through all
//              results); a safety valve for a first look at a large mailbox
//
// Never reads a token or the base URL from argv; both come from the
// environment only, and neither is ever echoed to stdout/stderr.
//
// Deliberately conservative: this script does not delete anything unless
// told to twice (--delete AND --yes), and even then only messages whose
// subject matches SMOKE_SUBJECT_RE exactly. It does not run against
// production on its own; that is a separate, credentialed, sign-off step.

const baseUrl = required("POSTERN_BASE_URL").replace(/\/+$/, "");
const readToken = required("POSTERN_API_TOKEN");
const deleteToken = process.env.POSTERN_DELETE_TOKEN || "";

const args = process.argv.slice(2);
const doDelete = args.includes("--delete");
const confirmed = args.includes("--yes");
const asJson = args.includes("--json");
const limit = Number(flag("--limit") || 0) || Infinity;

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

if (doDelete && !confirmed) {
  console.error("FATAL: --delete requires --yes as a second explicit confirmation");
  process.exit(2);
}
if (doDelete && !deleteToken) {
  console.error("FATAL: --delete requires POSTERN_DELETE_TOKEN (a delete-scoped bearer)");
  process.exit(2);
}

// The exact probe signature, derived from inbound/smoke.mjs `tag` (see header
// comment). Anchored start-to-end; optional "Re: " only for the reply leg.
const SMOKE_SUBJECT_RE =
  /^(?:Re: )?postern-smoke \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [0-9a-z]+ (send|attachment|inbound|draft(?: v2)?)$/;

async function api(method, path, { token } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token || readToken}` },
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

/**
 * Page through /api/search for the anchor substring "postern-smoke" in the
 * subject field, then re-check every hit against SMOKE_SUBJECT_RE client-side
 * (the server-side substr match is only a coarse pre-filter; the regex is the
 * real gate). direction is left unfiltered on purpose: the reply/send/
 * attachment legs are outbound, but a legacy --expect-inbound run would have
 * left an inbound-direction row, and the regex still has to clear it.
 */
async function findCandidates() {
  const seen = new Map();
  let cursor;
  for (;;) {
    const qs = new URLSearchParams({ q: "postern-smoke", field: "subject", mode: "substr", limit: "50" });
    if (cursor) qs.set("cursor", cursor);
    const res = await api("GET", `/api/search?${qs.toString()}`);
    if (res.status !== 200 || !res.json?.ok) {
      throw new Error(`search failed: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    }
    for (const hit of res.json.items || []) {
      const m = hit.message;
      if (!m || !m.messageId) continue;
      if (!SMOKE_SUBJECT_RE.test(m.subject || "")) continue;
      seen.set(m.messageId, { messageId: m.messageId, subject: m.subject, date: m.date, direction: m.direction });
      if (seen.size >= limit) return [...seen.values()];
    }
    // Page<T>.cursor is string|null; null (not an absent nextCursor field) is
    // the documented no-more-pages signal (store.ts Page<T> / #497 review).
    cursor = res.json.cursor;
    if (cursor === null || cursor === undefined) break;
  }
  return [...seen.values()];
}

async function main() {
  console.log(`Postern smoke-debris sweep against ${baseUrl}`);
  console.log(doDelete ? "MODE: DELETE (--delete --yes)" : "MODE: dry-run (list only; pass --delete --yes to remove)");

  const candidates = await findCandidates();
  console.log(`\n${candidates.length} candidate message(s) matched the exact smoke-probe subject signature:\n`);

  if (asJson) {
    console.log(JSON.stringify(candidates, null, 2));
  } else {
    for (const c of candidates) {
      console.log(`  ${c.messageId}  ${c.direction ?? "?"}  ${c.date ?? "?"}  ${c.subject}`);
    }
  }

  if (!doDelete) {
    console.log("\nDry run only. Nothing was deleted. Re-run with --delete --yes (and POSTERN_DELETE_TOKEN set) to remove these.");
    return;
  }

  console.log("\nDeleting...");
  let deleted = 0;
  let failed = 0;
  for (const c of candidates) {
    const del = await api("DELETE", `/api/messages/${encodeURIComponent(c.messageId)}`, { token: deleteToken });
    if (del.status === 200 && del.json?.ok === true) {
      const gone = await api("GET", `/api/messages/${encodeURIComponent(c.messageId)}`);
      if (gone.status === 404) {
        deleted++;
        console.log(`  ok    deleted ${c.messageId}`);
      } else {
        failed++;
        console.error(`  FAIL  ${c.messageId} deleted but still readable back (status ${gone.status})`);
      }
    } else {
      failed++;
      console.error(`  FAIL  ${c.messageId} DELETE returned HTTP ${del.status} ${JSON.stringify(del.json)}`);
    }
  }
  console.log(`\n${deleted} deleted, ${failed} failed, out of ${candidates.length} candidates.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("unexpected error:", e?.stack || String(e));
  process.exit(1);
});
