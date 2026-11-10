// routing.mjs -- the Email Routing reachability report (#802, finding F5 of #632).
//
// READ-ONLY. It lists the zone's Email Routing rules and names every address that does
// NOT land on this Worker. It never changes zone config: routing rules belong to the
// operator, and a report that "fixed" them would hide the very thing it exists to show.
//
// Why it exists: a per-address rule takes precedence over the catch-all, so one
// forwarding rule silently removes that address from the store while every other gate
// (deploy, health, smoke) stays green. The report prints the DENOMINATOR (how many rules
// it examined), so a clean result is a count, not a bare OK.

import { CfError } from "./cf.mjs";

const P_ZONE = "Zone: Zone Read";
const P_ROUTING = "Zone: Email Routing Rules Read";
// GET /zones/{z}/email/routing (is Routing enabled?) accepts Zone Settings Read or Write,
// NOT an Email Routing permission (Cloudflare API reference; measured 2026-11-10: a token
// with Email Routing Rules Read reads the rules and the catch-all, and gets 403 / 10000 here).
const P_SETTINGS = "Zone: Zone Settings Read";

const isAll = (r) => (r.matchers || []).some((m) => m.type === "all");
const landsOn = (r, worker) => (r.actions || []).some((x) => x.type === "worker" && (x.value || []).includes(worker));
const via = (r) => (r.actions || []).map((x) => `${x.type}${x.value?.length ? ` ${x.value.join(",")}` : ""}`).join("; ") || "(no action)";
const addresses = (r) => (r.matchers || []).filter((m) => m.type !== "all").map((m) => m.value).filter(Boolean);

/**
 * Pure: classify every rule. `rules` is the zone's rule list (it may itself include a
 * match-all rule); `catchAll` is the catch_all rule (or null). Returns the report.
 */
export function routingReport({ domain, worker, enabled, rules, catchAll, unmeasured = [] }) {
  const rows = [];
  for (const r of rules || []) {
    const kind = isAll(r) ? "catch-all" : "address";
    const name = r.name || r.id || "(unnamed)";
    if (!r.enabled) { rows.push({ kind, name, addresses: addresses(r), via: via(r), state: "disabled" }); continue; }
    rows.push({ kind, name, addresses: addresses(r), via: via(r), state: landsOn(r, worker) ? "worker" : "miss" });
  }
  // The real rule list INCLUDES the catch-all (same id as GET .../rules/catch_all, measured
  // 2026-11-10 on posternonline.com), so read it from the endpoint only when the list lacks it.
  const listed = new Set((rules || []).flatMap((r) => [r.id, r.tag]).filter(Boolean));
  if (catchAll && !listed.has(catchAll.id) && !listed.has(catchAll.tag)) {
    const name = catchAll.name || "catch-all";
    const state = !catchAll.enabled ? "disabled" : landsOn(catchAll, worker) ? "worker" : "miss";
    rows.push({ kind: "catch-all", name, addresses: [], via: via(catchAll), state, isCatchAllRule: true });
  }
  const live = rows.filter((r) => r.state !== "disabled");
  const missed = live.filter((r) => r.kind === "address" && r.state === "miss");
  const catchAlls = live.filter((r) => r.kind === "catch-all");
  // Unmatched addresses go to the catch-all. If no enabled catch-all lands on the Worker,
  // every address without its own rule misses it.
  const catchAllReaches = catchAlls.some((r) => r.state === "worker");
  const catchAllMisses = catchAlls.filter((r) => r.state === "miss");
  const problems = [];
  for (const u of unmeasured) problems.push(`could not measure: ${u}`);
  if (enabled === false) problems.push(`Email Routing is not enabled on ${domain}: no mail reaches any Worker`);
  for (const r of missed) problems.push(`rule "${r.name}" sends ${r.addresses.join(", ") || "(no address)"} to ${r.via}, not to Worker ${worker}`);
  for (const r of catchAllMisses) problems.push(`catch-all "${r.name}" sends every unmatched address to ${r.via}, not to Worker ${worker}`);
  if (enabled !== false && !catchAllReaches && !catchAllMisses.length) problems.push(`no enabled catch-all rule: an address without its own rule reaches nothing`);
  return {
    domain, worker, enabled: enabled === null || enabled === undefined ? null : !!enabled,
    examined: rows.length,
    disabled: rows.length - live.length,
    rows,
    missedAddresses: missed.flatMap((r) => r.addresses),
    ok: problems.length === 0,
    problems,
  };
}

/** The report as printable lines. Names and addresses only; never a token. */
export function formatRoutingReport(rep) {
  const out = [];
  const en = rep.enabled === null ? "enabled state NOT MEASURED" : rep.enabled ? "enabled" : "NOT enabled";
  out.push(`Email Routing on ${rep.domain} -> Worker ${rep.worker}: ${en}, ` +
    `${rep.examined} rule(s) examined${rep.disabled ? ` (${rep.disabled} disabled, ignored)` : ""}`);
  for (const r of rep.rows) {
    const tag = r.state === "worker" ? "ok  " : r.state === "disabled" ? "off " : "MISS";
    const what = r.kind === "catch-all" ? `catch-all "${r.name}" (every unmatched address)` : `rule "${r.name}" ${r.addresses.join(", ") || "(no address)"}`;
    out.push(`  ${tag} ${what} -> ${r.via}`);
  }
  if (rep.ok) out.push(`result: all ${rep.examined - rep.disabled} enabled rule(s) land on Worker ${rep.worker}; no address is routed around it.`);
  else {
    out.push(`result: ${rep.problems.length} problem(s) for Worker ${rep.worker}:`);
    for (const p of rep.problems) out.push(`  - ${p}`);
  }
  return out;
}

/** Read the zone's routing config through the Cloudflare API and build the report. */
export async function checkRouting(cf, { domain, name }) {
  const zones = await cf.list("look up the zone", P_ZONE, `/zones?name=${encodeURIComponent(domain)}`);
  const zone = zones.find((z) => String(z.name).toLowerCase() === domain.toLowerCase());
  if (!zone) {
    throw new CfError(`look up the zone ${domain}`, P_ZONE, 404, [{ code: 0, message: "no zone by that name is visible to this token" }]);
  }
  const z = zone.id;
  const unmeasured = [];
  let enabled = null;
  try {
    enabled = !!(await cf.call("read Email Routing settings", P_SETTINGS, "GET", `/zones/${z}/email/routing`)).result?.enabled;
  } catch (e) {
    if (!(e instanceof CfError) || !e.permissionDenied) throw e;
    unmeasured.push(`whether Email Routing is enabled (${e.message})`);
  }
  const rules = await cf.list("read Email Routing rules", P_ROUTING, `/zones/${z}/email/routing/rules`);
  const catchAll = (await cf.call("read the catch-all rule", P_ROUTING, "GET", `/zones/${z}/email/routing/rules/catch_all`, undefined, { allow404: true }))?.result ?? null;
  return routingReport({ domain, worker: name, enabled, rules, catchAll, unmeasured });
}
