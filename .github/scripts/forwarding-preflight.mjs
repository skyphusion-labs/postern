#!/usr/bin/env node
// Refuse a deploy that would SILENTLY change mail delivery behaviour (#611).
//
// THE DEFECT THIS EXISTS FOR. `vars` in a wrangler config are not merged into the
// live Worker, they REPLACE it. So a deploy whose config carries "FORWARD_TO": ""
// clears a live, working forwarding destination, with no error, nothing in the
// logs, and a perfectly green deploy run. Nobody finds out until somebody notices
// missing mail. The committed inbound/wrangler.jsonc is the PUBLIC self-host
// template and correctly ships both forwarding vars empty, which is exactly what
// makes the fallback path dangerous for an estate instance.
//
// WHAT IT GATES, in both directions, because both are silent delivery changes:
//   1. live FORWARD_TO set   -> config empty  = forwarding turned OFF for everyone.
//   2. live FORWARD_FOR set  -> config empty  = the recipient allowlist is dropped,
//      which does not stop forwarding, it WIDENS it to every recipient. That is the
//      more dangerous direction: mail that was deliberately kept local starts being
//      re-delivered elsewhere.
//
// DESIGN RULES, each of which is a thing that has bitten this estate before:
//
// * A READ IT COULD NOT PERFORM IS NEVER A PASS. If the live settings cannot be
//   read (non-200, success:false, unparseable body), this exits NON-ZERO. An absent
//   check reads exactly like a passed one, and deploying blind is the failure this
//   script exists to prevent, so it refuses rather than shrugging. The ONLY tolerated
//   not-red state is a genuine 404, meaning the Worker does not exist yet, and it
//   says so loudly instead of passing quietly.
//
// * IT NEVER PRINTS A VAR VALUE. postern is a PUBLIC repo, so Actions logs are
//   public, and FORWARD_TO is a personal address. Every line this script emits
//   reports a var as SET or EMPTY and never its contents. The regression suite
//   asserts that property directly, because it is the kind of thing a later "just
//   add the value to the error message so it is easier to debug" edit destroys.
//
// * THE COMMENT STRIPPER IS STRING-AWARE. wrangler accepts JSONC, and a naive
//   "cut everything after //" corrupts any value containing a URL. Strings, escapes
//   and both comment forms are handled, and the suite covers the URL case.
//
// USAGE
//   node forwarding-preflight.mjs <live-settings.json> <deploy-config.json(c)> <http-status>
//
// Exit 0 = safe to deploy (or Worker does not exist yet). Exit 1 = refuse.

import { readFileSync } from "node:fs";

const GATED_VARS = ["FORWARD_TO", "FORWARD_FOR"];

// Strip JSONC comments without touching string contents, then drop trailing commas.
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// Pull the plain-text vars out of a Worker settings response. A var that is absent
// and a var that is the empty string are the same thing to the forward logic in
// inbound/src/index.ts, so both normalise to "".
export function liveVars(settings) {
  const bindings = settings?.result?.bindings ?? settings?.bindings;
  if (!Array.isArray(bindings)) return null;
  const out = {};
  for (const b of bindings) {
    if (b && b.type === "plain_text" && typeof b.name === "string") {
      out[b.name] = typeof b.text === "string" ? b.text : "";
    }
  }
  return out;
}

export function configVars(config) {
  const vars = config?.vars;
  if (vars === undefined) return {};
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) return null;
  const out = {};
  for (const [k, v] of Object.entries(vars)) out[k] = typeof v === "string" ? v : String(v ?? "");
  return out;
}

// The verdict. Returns { ok, problems[], changes[] }. Values never leave this
// function: only the var name and whether each side is set.
export function verdict(live, incoming) {
  const problems = [];
  const changes = [];
  for (const name of GATED_VARS) {
    const wasSet = (live[name] ?? "") !== "";
    const willBeSet = (incoming[name] ?? "") !== "";
    if (wasSet && !willBeSet) {
      problems.push(
        name === "FORWARD_TO"
          ? `${name} is SET on the live Worker and EMPTY in the config being deployed. This deploy would turn transparent forwarding OFF for every recipient, silently.`
          : `${name} is SET on the live Worker and EMPTY in the config being deployed. This deploy would DROP the recipient allowlist, which does not stop forwarding, it widens it to every recipient.`,
      );
    } else if (wasSet && willBeSet && live[name] !== incoming[name]) {
      changes.push(`${name} changes value (both sides SET, contents differ).`);
    } else if (!wasSet && willBeSet) {
      changes.push(`${name} goes from EMPTY to SET.`);
    }
  }
  return { ok: problems.length === 0, problems, changes };
}

function main(argv) {
  // --script-name <config>: print the Worker name the config will deploy as. The workflow needs
  // it to build the settings URL, and resolving it HERE keeps the JSONC stripper to one
  // implementation rather than adding a second, subtly different one in shell.
  if (argv[0] === "--script-name") {
    if (!argv[1]) {
      console.error("usage: forwarding-preflight.mjs --script-name <config>");
      return 2;
    }
    let cfg;
    try {
      cfg = JSON.parse(stripJsonc(readFileSync(argv[1], "utf8")));
    } catch (e) {
      console.error(`::error title=Forwarding preflight::Deploy config ${argv[1]} did not parse (${e.message}).`);
      return 1;
    }
    if (!cfg || typeof cfg.name !== "string" || !cfg.name) {
      console.error("::error title=Forwarding preflight::The deploy config has no `name`, so the live Worker cannot be identified. REFUSING.");
      return 1;
    }
    process.stdout.write(cfg.name);
    return 0;
  }

  const [livePath, configPath, statusRaw] = argv;
  if (!livePath || !configPath || !statusRaw) {
    console.error("usage: forwarding-preflight.mjs <live-settings.json> <deploy-config.json> <http-status>");
    return 2;
  }
  const status = Number(statusRaw);

  if (status === 404) {
    console.log("::notice title=Forwarding preflight::The Worker does not exist on the account yet (HTTP 404), so there is no live forwarding state to preserve. Nothing to gate on a first deploy.");
    return 0;
  }
  if (!Number.isFinite(status) || status !== 200) {
    console.error(`::error title=Forwarding preflight::Could not read the live Worker settings (HTTP ${statusRaw}). REFUSING to deploy: a preflight that cannot read the live state must not pass, or it becomes a check that silently cannot fail. Fix the credential or the script name and re-run.`);
    return 1;
  }

  let settings;
  let config;
  try {
    settings = JSON.parse(readFileSync(livePath, "utf8"));
  } catch (e) {
    console.error(`::error title=Forwarding preflight::Live settings response is not JSON (${e.message}). REFUSING to deploy blind.`);
    return 1;
  }
  try {
    config = JSON.parse(stripJsonc(readFileSync(configPath, "utf8")));
  } catch (e) {
    console.error(`::error title=Forwarding preflight::Deploy config ${configPath} did not parse (${e.message}). REFUSING to deploy.`);
    return 1;
  }

  if (settings?.success === false) {
    console.error("::error title=Forwarding preflight::Cloudflare reported success:false for the settings read. REFUSING to deploy blind.");
    return 1;
  }

  const live = liveVars(settings);
  if (live === null) {
    console.error("::error title=Forwarding preflight::Live settings carried no bindings array, so the current forwarding state is unknown. REFUSING to deploy blind rather than assuming it is empty.");
    return 1;
  }
  const incoming = configVars(config);
  if (incoming === null) {
    console.error("::error title=Forwarding preflight::The deploy config has a `vars` key that is not an object. REFUSING to deploy.");
    return 1;
  }

  for (const name of GATED_VARS) {
    const a = (live[name] ?? "") !== "" ? "SET" : "EMPTY";
    const b = (incoming[name] ?? "") !== "" ? "SET" : "EMPTY";
    console.log(`  ${name}: live=${a} incoming=${b}`);
  }

  const { ok, problems, changes } = verdict(live, incoming);
  for (const c of changes) console.log(`::notice title=Forwarding change::${c}`);

  if (!ok) {
    for (const p of problems) console.error(`::error title=Forwarding preflight::${p}`);
    console.error(
      "REFUSING the deploy. This is #611: wrangler `vars` REPLACE the live Worker's vars, they do not merge, so shipping an empty value here would clear a working delivery path with a green run and no log line. If turning forwarding off is genuinely intended, set the value explicitly in the operator config (POSTERN_INBOUND_WRANGLER) rather than letting the public template's empty default do it by omission.",
    );
    return 1;
  }

  console.log("Forwarding preflight OK: this deploy does not clear a live forwarding var.");
  return 0;
}

// Only run when invoked directly, so the suite can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
