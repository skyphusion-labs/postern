#!/usr/bin/env node
// principals-backfill.mjs -- run POST /api/admin/principals/backfill once after a release
// deploy (#901, #854 M1), so the principal tables stay converged with agent_identities and
// the human users without an operator remembering to run it.
//
// Env:
//   POSTERN_BASE_URL            the instance (the deploy job's POSTERN_SMOKE_BASE_URL)
//   POSTERN_DEPLOY_ADMIN_TOKEN  the admin-only credential slot from #904 (never the operator
//                               POSTERN_API_TOKEN). Read from env only,
//                               never argv, never printed.
//   POSTERN_EXPECT_VERSION      the release tag (v1.11.0 or 1.11.0). The route exists only in
//                               the new code, so the call waits until GET /health reports
//                               this version: a POST that reached an edge still serving the
//                               previous version would 404 and fail the release for nothing.
//   BACKFILL_VERSION_TIMEOUT_MS how long to wait for that (default 180000)
//   BACKFILL_POLL_MS            poll interval (default 5000)
//
// Exit 0: 200 with a well-formed report. Exit 1: the instance never reported the version,
// or the backfill answered non-200, or the report is malformed. Exit 2: a required variable
// is missing (named). postern is a PUBLIC repo and Actions logs are public, so nothing here
// prints the token, a response body or a mailbox address. Address conflicts are reported
// by their opaque principal ids only.

const env = process.env;
const need = ["POSTERN_BASE_URL", "POSTERN_DEPLOY_ADMIN_TOKEN", "POSTERN_EXPECT_VERSION"];
const missing = need.filter((k) => !env[k] || !String(env[k]).trim());
if (missing.length) {
  for (const k of missing) console.log(`::error title=principals backfill::${k} is not set, so the backfill cannot run and this release is not converged. Set it in the production environment.`);
  process.exit(2);
}

const base = env.POSTERN_BASE_URL.replace(/\/+$/, "");
const token = env.POSTERN_DEPLOY_ADMIN_TOKEN;
const want = env.POSTERN_EXPECT_VERSION.replace(/^v/, "");
const timeoutMs = Number(env.BACKFILL_VERSION_TIMEOUT_MS || 180000);
const pollMs = Number(env.BACKFILL_POLL_MS || 5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveVersion() {
  try {
    const res = await fetch(`${base}/health`, { method: "GET" });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return typeof j?.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

async function main() {
  const start = Date.now();
  let seen = null;
  for (;;) {
    seen = await liveVersion();
    if (seen === want) break;
    if (Date.now() - start >= timeoutMs) {
      console.log(`::error title=principals backfill::GET /health never reported ${want} within ${timeoutMs} ms (last seen: ${seen ?? "no answer"}), so the backfill did not run.`);
      return 1;
    }
    await sleep(pollMs);
  }
  console.log(`principals backfill: ${base} reports ${seen}; running POST /api/admin/principals/backfill`);
  let res;
  try {
    res = await fetch(`${base}/api/admin/principals/backfill`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
  } catch (e) {
    console.log(`::error title=principals backfill::the request failed (${e?.cause?.code || e?.code || "network error"}).`);
    return 1;
  }
  const j = await res.json().catch(() => null);
  if (res.status !== 200) {
    // The error code is a fixed contract string (E_*), safe to print; the message is not printed.
    const code = typeof j?.error === "string" && /^[A-Za-z_]{1,40}$/.test(j.error) ? ` ${j.error}` : "";
    console.log(`::error title=principals backfill::POST /api/admin/principals/backfill answered HTTP ${res.status}${code}. The release is deployed but its principal tables are not converged.`);
    return 1;
  }
  const n = (x) => (Number.isInteger(x) && x >= 0 ? x : null);
  const r = {
    services_added: n(j?.services?.added),
    agents_added: n(j?.agents?.added), agents_synced: n(j?.agents?.synced),
    humans_added: n(j?.humans?.added), humans_synced: n(j?.humans?.synced), humans_orphans_revoked: n(j?.humans?.orphansRevoked),
  };
  const conflicts = Array.isArray(j?.addressConflicts) ? j.addressConflicts : null;
  if (Object.values(r).some((v) => v === null) || conflicts === null) {
    console.log("::error title=principals backfill::HTTP 200, but the report is not the documented shape {services, agents, humans, addressConflicts}.");
    return 1;
  }
  console.log(`@event principals-backfill ${JSON.stringify({ ...r, address_conflicts: conflicts.length })}`);
  const id = (s) => (typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : "?");
  for (const c of conflicts) {
    console.log(`::warning title=principals backfill::an address claimed by principal ${id(c?.principalId)} is already owned by ${id(c?.ownerId)}; it was left with its owner (address not printed: public log).`);
  }
  return 0;
}

main().then((rc) => process.exit(rc), () => { console.log("::error title=principals backfill::unexpected failure"); process.exit(1); });
