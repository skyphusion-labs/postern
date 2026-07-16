#!/usr/bin/env node
// Scriptable inbound-routing setup (#314): the one non-Dashboard step DEPLOY.md
// section 3 otherwise asks a human to click through. Points the zone's
// catch-all Email Routing rule at the deployed inbound Worker via the
// Cloudflare API, so an agent-driven or CI install never needs the Dashboard.
//
// Requires a Cloudflare API token scoped to (both zone-level, on the sending
// zone, plus one account-level read):
//   - Email Routing Rules: Edit  (zone)   -- create/update the catch-all rule
//   - Workers Scripts: Read      (account) -- look up the Worker's owner_worker_tag
// The Dashboard path (DEPLOY.md section 3) remains the documented default;
// this script is the opt-in path for operators who want it scripted.
//
// Usage:
//   CF_API_TOKEN=<token> CF_ACCOUNT_ID=<id> CF_ZONE_ID=<id> \
//     node scripts/setup-email-routing.mjs [--worker-name postern] [--dry-run]
//
// --worker-name  the deployed Worker's script name (default: "postern", the
//                shipped wrangler.jsonc "name"; pass the value you actually
//                deployed under if you renamed it)
// --dry-run      resolve and print the rule payload without applying it
//
// Deliberately does not echo CF_ACCOUNT_ID / CF_ZONE_ID / any request path
// back to stdout/stderr: those are read once from the environment and used
// only inside fetch() calls, never interpolated into a log message.

const token = process.env.CF_API_TOKEN || "";
const accountId = process.env.CF_ACCOUNT_ID || "";
const zoneId = process.env.CF_ZONE_ID || "";
if (!token || !accountId || !zoneId) {
  console.error("set CF_API_TOKEN, CF_ACCOUNT_ID, and CF_ZONE_ID");
  process.exit(2);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const workerName = flag("--worker-name") ?? "postern";

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const API = "https://api.cloudflare.com/client/v4";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

// `step` is a fixed, human-readable label (never request path or account/zone
// ids) so a failure message can never echo the ids read from the environment.
async function cf(step, path, init) {
  const res = await fetch(`${API}${path}`, { headers, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
    throw new Error(`${step} failed: HTTP ${res.status} (${detail})`);
  }
  return body.result;
}

async function main() {
  const scripts = await cf("list Worker scripts", `/accounts/${accountId}/workers/scripts`);
  const script = scripts.find((s) => s.id === workerName);
  if (!script) {
    console.error(
      `no Worker named "${workerName}" found in this account. ` +
        `Deploy it first (npm run deploy), or pass --worker-name <name>.`,
    );
    process.exit(1);
  }

  const payload = {
    actions: [{ type: "worker" }],
    matchers: [{ type: "all" }],
    enabled: true,
    name: "postern catch-all (via setup-email-routing.mjs)",
    owner_worker_tag: script.tag,
    source: "api",
  };

  if (dryRun) {
    console.log(`dry run: would route the zone's catch-all Email Routing rule to Worker "${workerName}".`);
    console.log(JSON.stringify(payload, null, 2));
    console.log("Remove --dry-run to apply.");
    return;
  }

  await cf("set catch-all Email Routing rule", `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  console.log(`catch-all Email Routing rule now routes to Worker "${workerName}".`);
  console.log(
    "Remove any conflicting per-address 'Forward to email' rules in the Dashboard " +
      "so every address reaches the Worker (DEPLOY.md section 3).",
  );
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
