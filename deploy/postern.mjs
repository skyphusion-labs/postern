#!/usr/bin/env node
// postern.mjs -- stand Postern up in YOUR OWN Cloudflare account, and keep it current.
//
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs install --domain example.com
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs upgrade --domain example.com
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs rollback --domain example.com [--restore-db]
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs routing --domain example.com
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs uninstall --domain example.com [--delete-data --confirm-delete example.com]
//
// Add --dry-run to any command to see what it would change and change nothing.
// The full guide, the token permissions, and every refusal are in DEPLOY.md.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfError, cfClient } from "./lib/cf.mjs";
import { EXIT, Refused, install, rollback, uninstall } from "./lib/installer.mjs";
import { checkRouting, formatRoutingReport } from "./lib/routing.mjs";

const USAGE = `usage: node deploy/postern.mjs <install|upgrade|status|rollback|routing|uninstall> --domain <domain> [options]

  status is a read-only report: what exists, what install or upgrade would change. It
  starts with the routing report.
  routing is a read-only Email Routing reachability report: every rule on the zone, and
  every address that does NOT reach the Worker. Exit 0 when every address reaches it,
  1 when one does not (or a reading could not be made), 3 when the token cannot read it.
  Token: Zone Read, Email Routing Rules Read, Zone Settings Read.
  uninstall removes what this installer recorded creating. It keeps your mail (D1, R2)
  unless you pass --delete-data --confirm-delete <domain>, and it never turns Email
  Routing off (that deletes the zone's MX, SPF and DKIM records).

  --domain <d>        the domain Postern receives and sends for (required)
  --hostname <h>      where the API and webmail answer (default mail.<domain>; a re-run keeps the recorded one)
  --admin <address>   the first admin login (default admin@<domain>; a re-run keeps the recorded one)
  --name <n>          Worker name (default postern); also names D1 and R2
  --prefix <p>        put <p> in front of the Worker, D1 and R2 names (e.g. a test prefix)
  --var KEY=VALUE     set a Worker var; remembered for later upgrades (repeatable)
  --dmarc <policy>    DMARC policy if the domain has none: none|quarantine|reject (default none)
  --state-dir <dir>   where the install state lives (default ./.postern)
  --adopt             manage a same-named Worker / D1 / R2 this installer did not create
  --restore-db        (rollback) also restore D1 to the pre-upgrade bookmark
  --delete-data       (uninstall) also delete D1 and R2; D1 is exported to a file first
  --confirm-delete <d> (uninstall) required with --delete-data: the domain, typed out
  --dry-run           print the plan; change nothing

The Cloudflare API token is read from CLOUDFLARE_API_TOKEN and is never printed.`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, vars: {}, adopt: false, dryRun: false, restoreDb: false, deleteData: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--domain") o.domain = val().toLowerCase();
    else if (a === "--hostname") o.hostname = val().toLowerCase();
    else if (a === "--admin") o.admin = val().toLowerCase();
    else if (a === "--name") o.name = val();
    else if (a === "--prefix") o.prefix = val();
    else if (a === "--state-dir") o.stateDir = val();
    else if (a === "--dmarc") o.dmarcPolicy = val();
    else if (a === "--var") {
      const kv = val();
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(kv);
      if (!m) throw new Error(`--var wants KEY=VALUE, got "${kv}"`);
      o.vars[m[1]] = m[2];
    } else if (a === "--adopt") o.adopt = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--restore-db") o.restoreDb = true;
    else if (a === "--delete-data") o.deleteData = true;
    else if (a === "--confirm-delete") o.confirmDelete = val().toLowerCase();
    else throw new Error(`unknown option ${a}`);
  }
  if (!["install", "upgrade", "status", "rollback", "routing", "uninstall"].includes(cmd)) throw new Error(cmd ? `unknown command ${cmd}` : "no command");
  if (!o.domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(o.domain)) throw new Error("--domain is required (for example --domain example.com)");
  o.name = `${o.prefix ?? ""}${o.name ?? "postern"}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) throw new Error("--name must be lower-case letters, digits and dashes");
  // Which of these the operator typed. A re-run keeps the recorded value for one that was
  // not typed (#855); the default below is for a first install.
  o.given = { hostname: o.hostname !== undefined, admin: o.admin !== undefined };
  o.hostname ??= `mail.${o.domain}`;
  o.admin ??= `admin@${o.domain}`;
  if (!o.hostname.endsWith(`.${o.domain}`) && o.hostname !== o.domain) throw new Error("--hostname must be inside --domain");
  if (!o.admin.endsWith(`@${o.domain}`)) throw new Error("--admin must be an address on --domain");
  o.dmarcPolicy ??= "none";
  if (!["none", "quarantine", "reject"].includes(o.dmarcPolicy)) throw new Error("--dmarc must be none, quarantine or reject");
  if (cmd === "status" || cmd === "routing") o.dryRun = true;
  o.stateDir = resolve(o.stateDir ?? ".postern");
  o.d1Name = o.name;
  o.bucket = `${o.name}-attachments`;
  o.fromName = "Postern";
  return o;
}

export function realExec(cmd, args, { cwd, env = {}, input } = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => res({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// The reachability report (#802). Read-only; prints names and addresses, never the token.
export async function printRouting(cf, opts, log) {
  try {
    const rep = await checkRouting(cf, { domain: opts.domain, name: opts.name });
    for (const line of formatRoutingReport(rep)) log(line);
    log(`@event routing ${JSON.stringify({ ok: rep.ok, examined: rep.examined, disabled: rep.disabled, missed: rep.missedAddresses })}`);
    return rep.ok ? EXIT.OK : EXIT.FAILED;
  } catch (e) {
    if (!(e instanceof CfError)) throw e;
    log(`routing report: refused: ${e.message}`);
    return EXIT.REFUSED;
  }
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN || "";
  if (!token) {
    console.error("refused:\n  - set CLOUDFLARE_API_TOKEN to an API token for YOUR Cloudflare account (permissions: DEPLOY.md)");
    return EXIT.REFUSED;
  }
  const cf = cfClient({ token });
  if (opts.cmd === "routing" || opts.cmd === "status") {
    const code = await printRouting(cf, opts, (s) => console.log(s));
    if (opts.cmd === "routing") return code;
    console.log("");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const appVersion = /VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(join(repoRoot, "inbound", "src", "version.ts"), "utf8"))?.[1];

  if (!existsSync(join(repoRoot, "inbound", "node_modules", ".bin", "wrangler"))) {
    console.log("installing the pinned wrangler (npm ci in inbound/) ...");
    const r = await realExec("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(repoRoot, "inbound") });
    if (r.code !== 0) {
      console.error(`npm ci failed:\n${r.stderr.split("\n").slice(-10).join("\n")}`);
      return EXIT.FAILED;
    }
  }

  const deps = {
    cf,
    token,
    exec: realExec,
    http: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (s) => console.log(s),
    repoRoot,
    appVersion,
  };
  try {
    if (opts.cmd === "rollback") await rollback(deps, opts);
    else if (opts.cmd === "uninstall") await uninstall(deps, opts);
    else await install(deps, opts, opts.cmd === "status" ? "install" : opts.cmd);
    return EXIT.OK;
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`\n${e.message}\n\nNothing was changed.`);
      return EXIT.REFUSED;
    }
    console.error(`\nstopped: ${e.message}\n\nEverything above this line is done and recorded. Fix the cause and re-run the same command; it resumes.`);
    return EXIT.FAILED;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
