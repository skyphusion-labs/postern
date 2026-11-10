#!/usr/bin/env node
// postern.mjs -- stand Postern up in YOUR OWN Cloudflare account, and keep it current.
//
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs install --domain example.com
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs upgrade --domain example.com
//   CLOUDFLARE_API_TOKEN=... node deploy/postern.mjs rollback --domain example.com [--restore-db]
//
// Add --dry-run to any command to see what it would change and change nothing.
// The full guide, the token permissions, and every refusal are in DEPLOY.md.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cfClient } from "./lib/cf.mjs";
import { EXIT, Refused, install, rollback } from "./lib/installer.mjs";

const USAGE = `usage: node deploy/postern.mjs <install|upgrade|status|rollback> --domain <domain> [options]

  status is a read-only report: what exists, what install or upgrade would change.

  --domain <d>        the domain Postern receives and sends for (required)
  --hostname <h>      where the API and webmail answer (default mail.<domain>)
  --admin <address>   the first admin login (default admin@<domain>)
  --name <n>          Worker name (default postern); also names D1 and R2
  --prefix <p>        put <p> in front of the Worker, D1 and R2 names (e.g. a test prefix)
  --var KEY=VALUE     set a Worker var; remembered for later upgrades (repeatable)
  --dmarc <policy>    DMARC policy if the domain has none: none|quarantine|reject (default none)
  --state-dir <dir>   where the install state lives (default ./.postern)
  --adopt             manage a same-named Worker / D1 / R2 this installer did not create
  --restore-db        (rollback) also restore D1 to the pre-upgrade bookmark
  --dry-run           print the plan; change nothing

The Cloudflare API token is read from CLOUDFLARE_API_TOKEN and is never printed.`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, vars: {}, adopt: false, dryRun: false, restoreDb: false };
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
    else throw new Error(`unknown option ${a}`);
  }
  if (!["install", "upgrade", "status", "rollback"].includes(cmd)) throw new Error(cmd ? `unknown command ${cmd}` : "no command");
  if (!o.domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(o.domain)) throw new Error("--domain is required (for example --domain example.com)");
  o.name = `${o.prefix ?? ""}${o.name ?? "postern"}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) throw new Error("--name must be lower-case letters, digits and dashes");
  o.hostname ??= `mail.${o.domain}`;
  o.admin ??= `admin@${o.domain}`;
  if (!o.hostname.endsWith(`.${o.domain}`) && o.hostname !== o.domain) throw new Error("--hostname must be inside --domain");
  if (!o.admin.endsWith(`@${o.domain}`)) throw new Error("--admin must be an address on --domain");
  o.dmarcPolicy ??= "none";
  if (!["none", "quarantine", "reject"].includes(o.dmarcPolicy)) throw new Error("--dmarc must be none, quarantine or reject");
  if (cmd === "status") o.dryRun = true;
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
    cf: cfClient({ token }),
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
