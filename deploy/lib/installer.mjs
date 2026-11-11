// installer.mjs -- install / upgrade / status / rollback for a self-hosted Postern,
// in the operator's OWN Cloudflare account, driven only by their API token.
//
// Shape: PREFLIGHT reads everything and collects every refusal before ANY write.
// Then each APPLY step is an "ensure": it reads live state, and writes only when
// the live state differs. That one property gives both guarantees the installer
// promises: a second run changes nothing, and a run that died halfway resumes by
// re-running the same command. State is saved after every write, so a resumed run
// knows which resources it created.
//
// Secrets: the Cloudflare token is never printed. The generated mailbox token and
// the first admin's password are written to a mode-600 file whose PATH is printed,
// never its contents. "Never printed" does not rest on wrangler's behaviour either:
// every log line and every error message leaves through ctx.redact (#831), which
// replaces the token and every secret this installer generated or stored.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CfError } from "./cf.mjs";
import { renderConfig } from "./config.mjs";

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, REFUSED: 3 };

const P = {
  zone: "Zone: Zone Read",
  dns: "Zone: DNS Edit",
  routing: "Zone: Email Routing Rules Edit",
  // GET /email/routing and POST /email/routing/dns take Zone Settings, not an Email Routing
  // permission (Cloudflare API reference; measured 2026-11-10, #802).
  settings: "Zone: Zone Settings Edit",
  sending: "Account: Email Sending Edit",
  workers: "Account: Workers Scripts Edit",
  d1: "Account: D1 Edit",
  r2: "Account: Workers R2 Storage Edit",
};

const CF_MX = /(^|\.)mx\.cloudflare\.net\.?$/i;

export class Refused extends Error {
  constructor(reasons) {
    super(`refused:\n${reasons.map((r) => `  - ${r}`).join("\n")}`);
    this.reasons = reasons;
  }
}

// ---------------------------------------------------------------------------
// state + credentials files

function statePaths(opts) {
  const base = join(opts.stateDir, `${opts.name}.${opts.domain}`);
  return { state: `${base}.json`, creds: `${base}.credentials.env`, config: `${base}.wrangler.json`, build: `${base}.build` };
}

function loadState(opts) {
  const p = statePaths(opts).state;
  if (!existsSync(p)) return { version: 1, owned: {}, vars: {}, history: [] };
  return JSON.parse(readFileSync(p, "utf8"));
}

function ensureStateDir(opts) {
  mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.stateDir, 0o700);
}

function saveState(opts, state) {
  ensureStateDir(opts);
  writeFileSync(statePaths(opts).state, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function loadCreds(opts) {
  const p = statePaths(opts).creds;
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function saveCreds(opts, creds) {
  ensureStateDir(opts);
  const p = statePaths(opts).creds;
  const body = Object.entries(creds).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(p, body, { mode: 0o600 });
  chmodSync(p, 0o600);
}

export const randomSecret = () => randomBytes(32).toString("hex");

export const REDACTED = "[redacted]";
// Replace every known secret value in `text`. Values shorter than 8 characters are
// skipped: none of ours is that short, and replacing a short common string would
// garble the output without protecting anything.
export function redactText(text, secrets) {
  let s = String(text ?? "");
  for (const v of secrets) if (typeof v === "string" && v.length >= 8) s = s.split(v).join(REDACTED);
  return s;
}

// ---------------------------------------------------------------------------
// the change log: every line says what happened to which named resource

function reporter(log) {
  const changes = [];
  return {
    changes,
    created: (what) => { changes.push(["created", what]); log(`+ created   ${what}`); },
    updated: (what) => { changes.push(["updated", what]); log(`~ updated   ${what}`); },
    unchanged: (what) => log(`= unchanged ${what}`),
    kept: (what) => log(`- kept      ${what}`),
    would: (what) => { changes.push(["would", what]); log(`? would     ${what}`); },
    removed: (what) => { changes.push(["removed", what]); log(`x removed   ${what}`); },
  };
}

// ---------------------------------------------------------------------------
// DNS helpers

const norm = (s) => String(s || "").replace(/\.$/, "").toLowerCase();
// TXT content as one string. Cloudflare stores a long TXT (a 2048-bit DKIM key) as
// several quoted 255-byte chunks, "abc" "def", while the Email Sending API reports the
// same record as one quoted string; both mean "abcdef" (measured 2026-11-10).
const unquote = (s) => {
  const t = String(s || "").trim();
  return /^".*"$/s.test(t) ? t.slice(1, -1).replace(/"\s+"/g, "") : t;
};

function spfIncludes(txt) {
  return new Set(unquote(txt).split(/\s+/).filter((t) => /^(\+)?include:/.test(t)).map((t) => t.replace(/^\+/, "")));
}

// Is `want` already satisfied by the zone's records at that name?
// SPF is special: two SPF records at one name is invalid, so an existing SPF
// satisfies the want only if it already carries every include the want needs.
function dnsSatisfied(records, want) {
  const same = records.filter((r) => r.type === want.type && norm(r.name) === norm(want.name));
  if (want.type === "TXT" && /^v=spf1/i.test(unquote(want.content))) {
    const spf = same.find((r) => /^v=spf1/i.test(unquote(r.content)));
    if (!spf) return { ok: false, conflict: null };
    const have = spfIncludes(spf.content);
    const missing = [...spfIncludes(want.content)].filter((i) => !have.has(i));
    return missing.length ? { ok: false, conflict: `SPF at ${want.name} lacks ${missing.join(", ")}` } : { ok: true };
  }
  const hit = same.find((r) => (want.type === "TXT" ? unquote(r.content) === unquote(want.content) : norm(r.content) === norm(want.content)));
  if (hit) return { ok: true };
  if (["CNAME"].includes(want.type) && same.length) return { ok: false, conflict: `${want.type} ${want.name} already points elsewhere` };
  if (want.type === "TXT" && /^v=DKIM1/i.test(unquote(want.content)) && same.some((r) => /^v=DKIM1/i.test(unquote(r.content)))) {
    return { ok: false, conflict: `a different DKIM key already sits at ${want.name}` };
  }
  return { ok: false, conflict: null };
}

// ---------------------------------------------------------------------------
// PREFLIGHT: read-only. Collect every refusal, then throw them together.

// Documentation domains (RFC 2606 / 6761). The template ships them as placeholders;
// an install on one deploys fine and then refuses or misroutes every send.
const PLACEHOLDER = /(^|\.)(example\.(com|net|org)|example|invalid|localhost)$/i;

export function configRefusals(opts) {
  const out = [];
  if (PLACEHOLDER.test(opts.domain)) out.push(`${opts.domain} is a documentation placeholder, not your domain. Pass --domain <the domain you own>.`);
  const v = opts.vars || {};
  if (v.ALLOWED_FROM_DOMAIN !== undefined && norm(v.ALLOWED_FROM_DOMAIN) !== norm(opts.domain)) {
    out.push(`--var ALLOWED_FROM_DOMAIN=${v.ALLOWED_FROM_DOMAIN} differs from --domain ${opts.domain}; every send would be refused or sent off-domain. Drop the --var.`);
  }
  if (v.DEFAULT_FROM !== undefined && !norm(v.DEFAULT_FROM).endsWith(`@${norm(opts.domain)}`)) {
    out.push(`--var DEFAULT_FROM=${v.DEFAULT_FROM} is not an address on ${opts.domain}.`);
  }
  return out;
}

async function preflight(ctx) {
  const { cf, opts, state } = ctx;
  const refusals = [];
  const cfgBad = configRefusals({ ...opts, vars: { ...(state.vars || {}), ...(opts.vars || {}) } });
  if (cfgBad.length) throw new Refused(cfgBad);

  let zones;
  try {
    zones = await cf.list("look up the zone", P.zone, `/zones?name=${encodeURIComponent(opts.domain)}`);
  } catch (e) {
    if (e instanceof CfError) throw new Refused([e.message]);
    throw e;
  }
  const zone = zones.find((z) => norm(z.name) === norm(opts.domain));
  if (!zone) {
    throw new Refused([
      `no zone named ${opts.domain} is visible to this token. Either the domain is not on this ` +
        `Cloudflare account, or the token lacks "${P.zone}" for it.`,
    ]);
  }
  const accountId = zone.account?.id;
  if (!accountId) throw new Refused([`zone ${opts.domain} reported no account; cannot continue`]);
  if (state.accountId && state.accountId !== accountId) {
    refusals.push(`the state file says this install lives in a different account than the one that owns ${opts.domain}`);
  }

  // Probe every permission the run needs with a READ, and name each miss.
  // A read probe proves read reach only; an Edit permission is proven by the
  // write itself, which fails with the permission named and is resumable.
  const z = zone.id;
  const a = accountId;
  const probe = async (label, perm, path, { allow404 = false } = {}) => {
    try {
      return await ctx.cf.call(label, perm, "GET", path, undefined, { allow404 });
    } catch (e) {
      if (e instanceof CfError) {
        refusals.push(e.message);
        return undefined;
      }
      throw e;
    }
  };
  const dnsAll = await probe("read DNS records", P.dns, `/zones/${z}/dns_records?per_page=1`);
  const routing = await probe("read Email Routing settings", P.settings, `/zones/${z}/email/routing`);
  const catchAll = await probe("read the catch-all rule", P.routing, `/zones/${z}/email/routing/rules/catch_all`, { allow404: true });
  await probe("read Email Sending domains", P.sending, `/zones/${z}/email/sending/subdomains`);
  await probe("list Worker scripts", P.workers, `/accounts/${a}/workers/scripts`);
  await probe("list D1 databases", P.d1, `/accounts/${a}/d1/database?per_page=1`);
  await probe("list R2 buckets", P.r2, `/accounts/${a}/r2/buckets?per_page=1`);
  await probe("list Worker custom domains", P.workers, `/accounts/${a}/workers/domains?per_page=1`);
  if (refusals.length) throw new Refused(refusals);

  const records = await cf.list("read DNS records", P.dns, `/zones/${z}/dns_records`);

  // 1. Already receiving mail somewhere else?
  const apexMx = records.filter((r) => r.type === "MX" && norm(r.name) === norm(opts.domain));
  for (const mx of apexMx) {
    if (!CF_MX.test(norm(mx.content))) {
      refusals.push(
        `${opts.domain} already receives mail elsewhere: MX ${mx.content}. Installing would take ` +
          `that mail away. Remove the MX record yourself if you mean to move this domain to Postern.`,
      );
    }
  }

  // 2. Email Routing rules that would bypass the Worker.
  if (routing?.result?.enabled) {
    const rules = await cf.list("read Email Routing rules", P.routing, `/zones/${z}/email/routing/rules`);
    for (const r of rules) {
      if (!r.enabled) continue;
      if ((r.matchers || []).some((m) => m.type === "all")) continue; // the catch-all, checked below
      const acts = r.actions || [];
      const toUs = acts.length > 0 && acts.every((x) => x.type === "worker" && (x.value || []).includes(opts.name));
      if (!toUs) {
        const to = (r.matchers || []).map((m) => m.value).filter(Boolean).join(", ") || "(unnamed)";
        const via = acts.map((x) => `${x.type}${x.value ? ` ${x.value.join(",")}` : ""}`).join("; ");
        refusals.push(
          `Email Routing rule "${r.name || r.id}" sends ${to} to ${via}, so that mail would never ` +
            `reach Postern. Disable or delete the rule, then re-run.`,
        );
      }
    }
  }
  const ca = catchAll?.result;
  if (ca && ca.enabled) {
    const acts = ca.actions || [];
    const toUs = acts.some((x) => x.type === "worker" && (x.value || []).includes(opts.name));
    const isDrop = acts.every((x) => x.type === "drop");
    if (!toUs && !isDrop) {
      const via = acts.map((x) => `${x.type}${x.value ? ` ${x.value.join(",")}` : ""}`).join("; ");
      refusals.push(`the catch-all Email Routing rule already sends mail to ${via}. Point it elsewhere yourself, or disable it, then re-run.`);
    }
  }

  // 3. SPF that would need a hand merge.
  const apexSpf = records.find((r) => r.type === "TXT" && norm(r.name) === norm(opts.domain) && /^v=spf1/i.test(unquote(r.content)));
  if (apexSpf && !spfIncludes(apexSpf.content).has("include:_spf.mx.cloudflare.net")) {
    refusals.push(
      `${opts.domain} already has an SPF record that does not include Cloudflare ` +
        `("${unquote(apexSpf.content)}"). Two SPF records break delivery, and merging one ` +
        `changes who may send as your domain, so do it by hand: add include:_spf.mx.cloudflare.net.`,
    );
  }

  // 4. The web hostname must be free, or already ours.
  const hostRecs = records.filter((r) => norm(r.name) === norm(opts.hostname));
  if (hostRecs.length) {
    const doms = await cf.list("list Worker custom domains", P.workers, `/accounts/${a}/workers/domains?hostname=${encodeURIComponent(opts.hostname)}`);
    const ours = doms.some((d) => norm(d.hostname) === norm(opts.hostname) && d.service === opts.name);
    if (!ours) {
      refusals.push(`${opts.hostname} already has a DNS record (${hostRecs.map((r) => r.type).join(", ")}). Pick another with --hostname, or remove it.`);
    }
  }

  // 5. Same-named resources this installer did not create.
  const adoptable = [];
  const script = await cf.call("read the Worker", P.workers, "GET", `/accounts/${a}/workers/scripts/${opts.name}/settings`, undefined, { allow404: true });
  if (script && !state.owned.worker) adoptable.push(`a Worker named "${opts.name}"`);
  const dbs = await cf.list("list D1 databases", P.d1, `/accounts/${a}/d1/database?name=${encodeURIComponent(opts.d1Name)}`);
  const db = dbs.find((d) => d.name === opts.d1Name);
  if (db && !state.owned.d1) adoptable.push(`a D1 database named "${opts.d1Name}"`);
  const bucket = await cf.call("read the R2 bucket", P.r2, "GET", `/accounts/${a}/r2/buckets/${opts.bucket}`, undefined, { allow404: true });
  if (bucket && !state.owned.bucket) adoptable.push(`an R2 bucket named "${opts.bucket}"`);
  if (adoptable.length && !opts.adopt) {
    refusals.push(
      `this account already has ${adoptable.join(", ")}, and this installer's state file does not ` +
        `record creating ${adoptable.length > 1 ? "them" : "it"}. If ${adoptable.length > 1 ? "they are" : "it is"} ` +
        `your earlier Postern install, re-run with --adopt. Otherwise choose another --name.`,
    );
  }

  if (refusals.length) throw new Refused(refusals);
  return { zone, accountId, records, routing: routing?.result, catchAll: ca, script, db, bucket, adoptable };
}

// ---------------------------------------------------------------------------
// APPLY steps

// D-AUTH-3: an unset WEBMAIL_AUTH_BACKEND means OFF. A NEW install turns native
// sign-in on explicitly (that is what the first admin is for). An existing Worker
// keeps exactly what it has: upgrade never adds the var, and --adopt carries the
// live value over (or its absence). The decision is stored once, in state.vars.
async function decideAuthBackend(ctx, pf) {
  const { state, opts } = ctx;
  if (state.authBackendDecided) return;
  if (!pf.script) {
    if (state.vars.WEBMAIL_AUTH_BACKEND === undefined) state.vars.WEBMAIL_AUTH_BACKEND = "native";
  } else if (state.vars.WEBMAIL_AUTH_BACKEND === undefined && !(opts.vars || {}).WEBMAIL_AUTH_BACKEND) {
    const live = (pf.script.result?.bindings || []).find((b) => b.name === "WEBMAIL_AUTH_BACKEND" && b.type === "plain_text");
    if (live) state.vars.WEBMAIL_AUTH_BACKEND = live.text;
  }
  state.authBackendDecided = true;
  saveState(opts, state);
}

async function ensureD1(ctx, pf) {
  const { cf, opts, state, rep } = ctx;
  if (pf.db) {
    if (!state.owned.d1) { state.owned.d1 = "adopted"; }
    state.d1Id = pf.db.uuid;
    rep.unchanged(`D1 database ${opts.d1Name}`);
    return;
  }
  if (opts.dryRun) return rep.would(`create D1 database ${opts.d1Name}`);
  const res = await cf.call("create the D1 database", P.d1, "POST", `/accounts/${pf.accountId}/d1/database`, { name: opts.d1Name });
  state.d1Id = res.result.uuid;
  state.owned.d1 = "created";
  saveState(opts, state);
  rep.created(`D1 database ${opts.d1Name}`);
}

async function ensureBucket(ctx, pf) {
  const { cf, opts, state, rep } = ctx;
  if (pf.bucket) {
    if (!state.owned.bucket) state.owned.bucket = "adopted";
    rep.unchanged(`R2 bucket ${opts.bucket}`);
    return;
  }
  if (opts.dryRun) return rep.would(`create R2 bucket ${opts.bucket}`);
  await cf.call("create the R2 bucket", P.r2, "POST", `/accounts/${pf.accountId}/r2/buckets`, { name: opts.bucket });
  state.owned.bucket = "created";
  saveState(opts, state);
  rep.created(`R2 bucket ${opts.bucket}`);
}

function migrationFiles(repoRoot) {
  const dir = join(repoRoot, "inbound", "migrations");
  return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

async function appliedMigrations(ctx, pf) {
  const { cf, state } = ctx;
  if (!state.d1Id) return [];
  try {
    const res = await cf.call("read applied migrations", P.d1, "POST", `/accounts/${pf.accountId}/d1/database/${state.d1Id}/query`, {
      sql: "SELECT name FROM d1_migrations ORDER BY id",
    });
    const rows = res.result?.[0]?.results || [];
    return rows.map((r) => r.name);
  } catch (e) {
    // A fresh store has no d1_migrations table yet; that, and only that, means "none applied".
    if (e instanceof CfError && e.errors.some((x) => /no such table: d1_migrations/i.test(x.message))) return [];
    throw e;
  }
}

async function ensureMigrations(ctx, pf) {
  const { opts, state, rep, exec, repoRoot } = ctx;
  const files = migrationFiles(repoRoot);
  const applied = opts.dryRun && !state.d1Id ? [] : await appliedMigrations(ctx, pf);
  const pending = files.filter((f) => !applied.includes(f));
  if (!pending.length) return rep.unchanged(`D1 schema (${files.length} migrations applied)`);

  // On a store that already holds mail, only additive migrations auto-apply: the
  // same gate the tag deploy runs (#112). A fresh store has nothing to lose.
  if (applied.length) {
    const gate = await exec("node", [join(repoRoot, ".github", "scripts", "d1-migration-gate.mjs"), join(repoRoot, "inbound", "migrations")], {
      cwd: repoRoot,
      input: pending.join("\n") + "\n",
    });
    if (gate.code !== 0) {
      throw new Error(
        `a pending migration is not additive, so it will not auto-apply to a store that holds mail:\n${gate.stdout}${gate.stderr}\n` +
          `Back up first and apply it by hand (docs/OPERATIONS.md), then re-run.`,
      );
    }
  }
  if (opts.dryRun) return rep.would(`apply ${pending.length} D1 migration(s): ${pending.join(", ")}`);

  if (applied.length && ctx.mode === "upgrade") {
    const bm = await ctx.cf.call("record a D1 Time Travel bookmark", P.d1, "GET", `/accounts/${pf.accountId}/d1/database/${state.d1Id}/time_travel/bookmark`);
    // Saved BEFORE the migration runs: a later failure in this run must not lose the
    // way back (measured: an upgrade that stopped at the health check lost it).
    recordUpgrade(ctx, { d1Bookmark: bm.result?.bookmark || null });
  }
  const r = await ctx.wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", ctx.paths.config]);
  if (r.code !== 0) throw new Error(`applying D1 migrations failed:\n${tail(r)}`);
  rep.created(`D1 migrations ${pending.join(", ")}`);
}

// The upgrade's rollback record lives in state.history from its first write on.
function recordUpgrade(ctx, fields) {
  const { state, opts } = ctx;
  if (!ctx.upgradeEntry) {
    ctx.upgradeEntry = { at: new Date().toISOString(), appVersion: ctx.appVersion, complete: false };
    state.history.push(ctx.upgradeEntry);
  }
  Object.assign(ctx.upgradeEntry, fields);
  saveState(opts, state);
}

function tail(r) {
  return `${r.stdout || ""}${r.stderr || ""}`.split("\n").slice(-15).join("\n");
}

// Only what ships is hashed. wrangler --dry-run also writes a README.md stamped
// with the build time and a source map that differs run to run while index.js is
// byte-identical (measured 2026-11-10), so hashing every file redeploys every run.
const NOT_SHIPPED = /(^README\.md$|\.map$)/;

function hashTree(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    // Dirents, not a stat per path: one read of each file, no check-then-use gap.
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !NOT_SHIPPED.test(e.name)) { h.update(e.name); h.update(readFileSync(p)); }
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest("hex");
}

async function liveVersionIds(ctx, pf) {
  const res = await ctx.cf.call("read the live deployment", P.workers, "GET", `/accounts/${pf.accountId}/workers/scripts/${ctx.opts.name}/deployments`, undefined, { allow404: true });
  const dep = res?.result?.deployments?.[0];
  return (dep?.versions || []).map((v) => v.version_id);
}

async function liveSecretNames(ctx, pf) {
  const res = await ctx.cf.call("list the Worker secrets", P.workers, "GET", `/accounts/${pf.accountId}/workers/scripts/${ctx.opts.name}/secrets`, undefined, { allow404: true });
  return (res?.result || []).map((s) => s.name);
}

async function ensureWorker(ctx, pf) {
  const { opts, state, rep, paths } = ctx;
  rmSync(paths.build, { recursive: true, force: true });
  const dry = await ctx.wrangler(["deploy", "--dry-run", "--outdir", paths.build, "-c", paths.config]);
  if (dry.code !== 0) throw new Error(`building the Worker failed:\n${tail(dry)}`);
  const hash = createHash("sha256").update(hashTree(paths.build)).update(readFileSync(paths.config)).digest("hex");
  rmSync(paths.build, { recursive: true, force: true });

  const live = await liveVersionIds(ctx, pf);
  const secrets = live.length ? await liveSecretNames(ctx, pf) : [];
  const needToken = !secrets.includes("POSTERN_API_TOKEN");
  const current = state.deploy && state.deploy.hash === hash && live.includes(state.deploy.versionId);
  if (current && !needToken) return rep.unchanged(`Worker ${opts.name} (version ${state.deploy.versionId})`);
  if (opts.dryRun) return rep.would(`deploy Worker ${opts.name} on https://${opts.hostname}`);

  if (ctx.mode === "upgrade" && live.length) recordUpgrade(ctx, { fromVersionId: live[0] });

  const args = ["deploy", "-c", paths.config, "--message", `postern installer ${ctx.mode}`];
  let secretsFile = null;
  if (needToken) {
    const creds = loadCreds(opts);
    if (!creds.POSTERN_API_TOKEN) {
      creds.POSTERN_API_URL = `https://${opts.hostname}`;
      creds.POSTERN_API_TOKEN = ctx.randomSecret();
      saveCreds(opts, creds);
    }
    // Unpredictable name, exclusive create: never write the token through a
    // file or symlink that was already sitting at that path.
    secretsFile = join(opts.stateDir, `.secrets-${randomBytes(12).toString("hex")}.json`);
    writeFileSync(secretsFile, JSON.stringify({ POSTERN_API_TOKEN: creds.POSTERN_API_TOKEN }), { mode: 0o600, flag: "wx" });
    args.push("--secrets-file", secretsFile);
  }
  let r;
  try {
    r = await ctx.wrangler(args);
  } finally {
    if (secretsFile) rmSync(secretsFile, { force: true });
  }
  if (r.code !== 0) throw new Error(`deploying the Worker failed:\n${tail(r)}`);
  const id = /Current Version ID:\s*([0-9a-fA-F-]{36})/.exec(String(r.stdout).replace(/\x1b\[[0-9;]*m/g, ""))?.[1];
  if (!id) throw new Error("wrangler deploy printed no version id, so the deployed artifact cannot be verified");
  // Verify the ARTIFACT, not the exit code: the live deployment must serve this version.
  const after = await liveVersionIds(ctx, pf);
  if (!after.includes(id)) throw new Error(`the live deployment serves ${after.join(", ") || "nothing"}, not the version just uploaded (${id})`);
  const wasOwned = state.owned.worker;
  state.owned.worker = wasOwned || (pf.script ? "adopted" : "created");
  state.deploy = { hash, versionId: id };
  saveState(opts, state);
  if (needToken) rep.created(`Worker secret POSTERN_API_TOKEN (value in ${paths.creds})`);
  (live.length ? rep.updated : rep.created)(`Worker ${opts.name} version ${id} on https://${opts.hostname}`);
}

async function ensureDnsRecords(ctx, pf, wants, label) {
  const { cf, opts, rep } = ctx;
  const records = await cf.list("read DNS records", P.dns, `/zones/${pf.zone.id}/dns_records`);
  for (const w of wants) {
    const s = dnsSatisfied(records, w);
    const what = `DNS ${w.type} ${w.name} (${label})`;
    if (s.ok) { rep.unchanged(what); continue; }
    if (s.conflict) throw new Error(`cannot add ${what}: ${s.conflict}. Nothing was changed for this record; fix it by hand and re-run.`);
    if (opts.dryRun) { rep.would(`create ${what}`); continue; }
    const body = { type: w.type, name: w.name, content: w.content, ttl: w.ttl || 1, comment: "postern installer" };
    if (w.priority !== undefined) body.priority = w.priority;
    await cf.call(`create ${what}`, P.dns, "POST", `/zones/${pf.zone.id}/dns_records`, body);
    records.push(body);
    rep.created(what);
  }
}

async function ensureSending(ctx, pf) {
  const { cf, opts, rep, state } = ctx;
  const z = pf.zone.id;
  const subs = (await cf.call("read Email Sending domains", P.sending, "GET", `/zones/${z}/email/sending/subdomains`)).result || [];
  let sub = subs.find((s) => norm(s.name) === norm(opts.domain));
  if (!sub) {
    if (opts.dryRun) return rep.would(`enable Email Sending for ${opts.domain} and add its DKIM / SPF / bounce records`);
    sub = (await cf.call("enable Email Sending", P.sending, "POST", `/zones/${z}/email/sending/subdomains`, { name: opts.domain })).result;
    // Recorded so that uninstall removes Sending only when THIS installer enabled it.
    state.owned.sending = sub.tag;
    saveState(opts, state);
    rep.created(`Email Sending for ${opts.domain}`);
    // Measured 2026-11-10: a send in the first seconds after enabling is refused with
    // E_SENDER_DOMAIN_NOT_AVAILABLE; it was accepted about a minute later.
    ctx.log(`  note: Cloudflare can take about a minute before it accepts the first send from ${opts.domain}.`);
    ctx.sendingNew = true;
  } else {
    rep.unchanged(`Email Sending for ${opts.domain}`);
  }
  const dns = (await cf.call("read Email Sending DNS", P.sending, "GET", `/zones/${z}/email/sending/subdomains/${sub.tag}/dns`)).result || [];
  // The Sending API also lists a _dmarc record (p=reject). DMARC is the operator's
  // policy for the WHOLE domain, so it is decided once, by --dmarc, in ensureDmarc.
  const dmarcName = `_dmarc.${opts.domain}`;
  await ensureDnsRecords(ctx, pf, dns.filter((w) => norm(w.name) !== norm(dmarcName)), "Email Sending");
}

async function ensureRouting(ctx, pf) {
  const { cf, opts, rep } = ctx;
  const z = pf.zone.id;
  const cur = (await cf.call("read Email Routing settings", P.settings, "GET", `/zones/${z}/email/routing`)).result || {};
  if (cur.enabled) {
    rep.unchanged(`Email Routing on ${opts.domain}`);
  } else if (opts.dryRun) {
    rep.would(`enable Email Routing on ${opts.domain} (adds and locks its MX and SPF records)`);
  } else {
    await cf.call("enable Email Routing", P.settings, "POST", `/zones/${z}/email/routing/dns`, {});
    rep.created(`Email Routing on ${opts.domain} (MX and SPF records added by Cloudflare)`);
  }

  const ca = (await cf.call("read the catch-all rule", P.routing, "GET", `/zones/${z}/email/routing/rules/catch_all`, undefined, { allow404: true }))?.result;
  const routed = ca && ca.enabled && (ca.actions || []).some((x) => x.type === "worker" && (x.value || []).includes(opts.name));
  if (routed) return rep.unchanged(`catch-all rule -> Worker ${opts.name}`);
  if (opts.dryRun) return rep.would(`route the catch-all rule to Worker ${opts.name}`);
  await cf.call("route the catch-all rule", P.routing, "PUT", `/zones/${z}/email/routing/rules/catch_all`, {
    actions: [{ type: "worker", value: [opts.name] }],
    matchers: [{ type: "all" }],
    enabled: true,
    name: "postern catch-all (postern installer)",
  });
  (ca ? rep.updated : rep.created)(`catch-all rule -> Worker ${opts.name}`);
}

async function ensureDmarc(ctx, pf) {
  const { cf, opts, rep } = ctx;
  const name = `_dmarc.${opts.domain}`;
  const records = await cf.list("read DNS records", P.dns, `/zones/${pf.zone.id}/dns_records?type=TXT`);
  const have = records.find((r) => r.type === "TXT" && norm(r.name) === norm(name) && /^v=DMARC1/i.test(unquote(r.content)));
  if (have) return rep.kept(`DNS TXT ${name} (your existing DMARC policy is left as it is)`);
  await ensureDnsRecords(ctx, pf, [{ type: "TXT", name, content: `v=DMARC1; p=${opts.dmarcPolicy}` }], "DMARC");
  ctx.dmarcWritten = !opts.dryRun;
  if (opts.dmarcPolicy !== "reject") {
    ctx.log(`  note: Cloudflare Email Sending recommends p=reject. If only Postern sends as ${opts.domain}, use --dmarc reject (a new install only; an existing DMARC is never changed).`);
  }
}

// FIRST ADMIN, through the AUTH lane's user API (#810, contract 1.10):
// POST /api/admin/users {username, from, password} with the estate token.
// 201 = created. 409 E_CONFLICT = the user already exists, which is "done" for a
// re-run; the route never overwrites, so a re-run cannot rotate the password.
// The password is generated here and written to the credentials file BEFORE the
// call, so a run that dies after the 201 still holds the right password.
async function waitForHealth(ctx, base) {
  let last = "";
  for (let i = 0; i < ctx.healthTries; i++) {
    try {
      const h = await ctx.http(`${base}/health`, { method: "GET" });
      if (h.ok) return;
      last = `HTTP ${h.status}`;
    } catch (e) {
      last = e?.cause?.code || e?.code || e?.message || String(e);
    }
    await ctx.sleep(ctx.healthDelayMs);
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(last)) {
    // Measured 2026-11-10: the Worker answered, but this machine's resolver had cached
    // "no such host" from a lookup made while the record was being created.
    throw new Error(
      `${base}: this machine cannot resolve ${ctx.opts.hostname} yet (${last}). The record exists in ` +
        `Cloudflare; your resolver is likely holding a cached "no such host" from a moment ago, for up ` +
        `to the zone's negative TTL (often 30 minutes). Re-run the same command later to finish.`,
    );
  }
  throw new Error(`${base}/health did not answer yet (${last || "no response"}; a new certificate can take a few minutes). Re-run the same command to finish.`);
}

async function ensureFirstAdmin(ctx, pf) {
  const { opts, state, rep } = ctx;
  if (state.admin === opts.admin) return rep.unchanged(`first admin ${opts.admin}`);
  if (opts.dryRun) return rep.would(`create the first admin ${opts.admin}`);
  const creds = loadCreds(opts);
  if (!creds.POSTERN_API_TOKEN) throw new Error(`no mailbox token in ${ctx.paths.creds}; cannot create the first admin`);
  if (!creds.POSTERN_ADMIN_PASSWORD || creds.POSTERN_ADMIN_USERNAME !== opts.admin) {
    creds.POSTERN_ADMIN_USERNAME = opts.admin;
    creds.POSTERN_ADMIN_PASSWORD = ctx.randomSecret().slice(0, 24);
    saveCreds(opts, creds);
  }
  const base = `https://${opts.hostname}`;
  await waitForHealth(ctx, base);
  const res = await ctx.http(`${base}/api/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.POSTERN_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ username: opts.admin, from: opts.admin, password: creds.POSTERN_ADMIN_PASSWORD }),
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  if (res.status === 404) {
    throw new Error(`the deployed Postern has no user API (POST /api/admin/users answered 404). Install from a release that has it (#810), then re-run.`);
  }
  if (res.status === 409 && body.error === "E_CONFLICT") {
    state.admin = opts.admin;
    saveState(opts, state);
    rep.kept(
      `first admin ${opts.admin} already exists; its password was not changed. If an earlier run of ` +
        `this installer created it, the password in ${ctx.paths.creds} is its password.`,
    );
    return;
  }
  if (res.status !== 201 || body.ok !== true) {
    throw new Error(`creating the first admin failed: HTTP ${res.status} ${body.error || ""}${body.message ? `: ${body.message}` : ""}`.trim());
  }
  state.admin = opts.admin;
  if (ctx.upgradeEntry?.d1Bookmark) ctx.upgradeEntry.adminCreatedAfterBookmark = true;
  saveState(opts, state);
  rep.created(`first admin ${opts.admin} (password in ${ctx.paths.creds})`);
}

// ---------------------------------------------------------------------------
// entry points

// #855. A re-run keeps the hostname and admin this install recorded, unless the operator
// passes --hostname / --admin. Measured 2026-11-10: a re-run without --hostname took the
// default mail.<domain>, and the deploy moved the live custom domain there. The admin is
// recorded once it exists (state.admin); before that, the credentials file holds the login
// the run is creating. Returns the note lines to print.
export function settleRecorded(opts, state, creds) {
  const recorded = { hostname: state.hostname, admin: state.admin || creds.POSTERN_ADMIN_USERNAME };
  const notes = [];
  for (const [k, flag] of [["hostname", "--hostname"], ["admin", "--admin"]]) {
    const was = recorded[k];
    if (!was) continue;
    if (!opts.given?.[k]) opts[k] = was;
    else if (opts[k] !== was) notes.push(`  note: ${flag} ${opts[k]} replaces the recorded ${was}, because it was passed.`);
  }
  return notes;
}

function makeCtx(deps, opts, mode) {
  const paths = statePaths(opts);
  const state = loadState(opts);
  const settled = settleRecorded(opts, state, loadCreds(opts));
  // Every secret this run knows: the Cloudflare token, each one it generates, and each
  // SECRET value in the credentials file (read at print time, since a run writes it
  // midway). The file also holds the API URL and the admin login, which are not secret.
  const generated = [];
  const gen = deps.randomSecret || randomSecret;
  const storedSecrets = () => Object.entries(loadCreds(opts)).filter(([k]) => /TOKEN|PASSWORD|SECRET/.test(k)).map(([, v]) => v);
  const redact = (text) => redactText(text, [deps.token, ...generated, ...storedSecrets()]);
  const log = (s) => deps.log(redact(s));
  const rep = reporter(log);
  for (const s of settled) log(s);
  const ctx = {
    ...deps,
    log,
    redact,
    opts,
    mode,
    state,
    rep,
    paths,
    repoRoot: deps.repoRoot,
    upgradeRecord: {},
    healthTries: deps.healthTries ?? 30,
    healthDelayMs: deps.healthDelayMs ?? 10000,
    randomSecret: () => { const v = gen(); generated.push(v); return v; },
  };
  ctx.wrangler = (args) =>
    deps.exec(join(deps.repoRoot, "inbound", "node_modules", ".bin", "wrangler"), args, {
      cwd: join(deps.repoRoot, "inbound"),
      env: { CLOUDFLARE_API_TOKEN: deps.token, CLOUDFLARE_ACCOUNT_ID: state.accountId || "" },
    });
  return ctx;
}

function writeConfig(ctx) {
  ensureStateDir(ctx.opts);
  const cfg = renderConfig({ repoRoot: ctx.repoRoot, state: ctx.state, opts: ctx.opts });
  writeFileSync(ctx.paths.config, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

// Every error leaves through here, redacted: a wrangler failure's tail() can carry
// whatever wrangler printed, and a refusal can quote API text.
async function guarded(ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && typeof e.message === "string") e.message = ctx.redact(e.message);
    if (e && Array.isArray(e.reasons)) e.reasons = e.reasons.map(ctx.redact);
    throw e;
  }
}

export async function install(deps, opts, mode = "install") {
  const ctx = makeCtx(deps, opts, mode);
  return guarded(ctx, () => installRun(ctx, opts, mode));
}

async function installRun(ctx, opts, mode) {
  const { log } = ctx;
  if (mode === "upgrade" && !ctx.state.deploy) {
    throw new Refused([`no install recorded in ${ctx.paths.state}; run install first (upgrade only moves an existing install forward)`]);
  }
  log(`postern ${mode}: ${opts.domain} -> Worker ${opts.name} on https://${opts.hostname}${opts.dryRun ? " (dry run: nothing will change)" : ""}`);
  const pf = await preflight(ctx);
  ctx.state.accountId = pf.accountId;
  ctx.state.zoneId = pf.zone.id;
  ctx.state.domain = opts.domain;
  ctx.state.hostname = opts.hostname;
  // --var values persist in state, so an upgrade never drops them (wrangler vars
  // REPLACE the live set; a var missing from the config is a var deleted).
  ctx.state.vars = { ...(ctx.state.vars || {}), ...(opts.vars || {}) };
  if (!opts.dryRun) saveState(opts, ctx.state);

  await ensureD1(ctx, pf);
  await ensureBucket(ctx, pf);
  if (opts.dryRun && !ctx.state.d1Id) {
    ctx.rep.would(`apply all D1 migrations`);
    ctx.rep.would(`deploy Worker ${opts.name} on https://${opts.hostname}`);
  } else {
    await decideAuthBackend(ctx, pf);
    writeConfig(ctx);
    await ensureMigrations(ctx, pf);
    await ensureWorker(ctx, pf);
  }
  // DMARC FIRST: enabling Email Sending makes Cloudflare write _dmarc p=reject
  // itself when the domain has none (measured 2026-11-10), which would pre-empt
  // the operator's --dmarc choice.
  await ensureDmarc(ctx, pf);
  await ensureSending(ctx, pf);
  await ensureRouting(ctx, pf);
  if (!opts.dryRun && ctx.state.deploy) await ensureFirstAdmin(ctx, pf);
  else if (opts.dryRun) ctx.rep.would(`create the first admin ${opts.admin}`);

  if (ctx.upgradeEntry) {
    Object.assign(ctx.upgradeEntry, { toVersionId: ctx.state.deploy.versionId, complete: true });
    saveState(opts, ctx.state);
  }

  const n = ctx.rep.changes.filter((c) => c[0] !== "would").length;
  log("");
  log(opts.dryRun ? `dry run: ${ctx.rep.changes.length} change(s) would be made.` : n ? `done: ${n} change(s) made.` : "done: nothing to change; this install is current.");
  if (!opts.dryRun) {
    log(`credentials: ${ctx.paths.creds} (mode 600; keep it, it is not shown here)`);
    if (ctx.sendingNew) {
      log(`sending:     Email Sending was just enabled. Sends are refused with E_SENDER_DOMAIN_NOT_AVAILABLE`);
      log(`             for up to about 60 s while Cloudflare propagates it. Wait about a minute before the first send.`);
    }
    if (ctx.dmarcWritten) {
      log(`dmarc:       wrote v=DMARC1; p=${opts.dmarcPolicy} before enabling Sending, so Cloudflare did not write its own p=reject.`);
    }
    log(`webmail:     https://${opts.hostname}/webmail  (sign in as ${opts.admin})`);
  }
  return { changes: ctx.rep.changes, state: ctx.state };
}

export async function rollback(deps, opts) {
  const ctx = makeCtx(deps, opts, "rollback");
  return guarded(ctx, () => rollbackRun(ctx, opts));
}

async function rollbackRun(ctx, opts) {
  const deps = ctx;
  const last = ctx.state.history[ctx.state.history.length - 1];
  if (!last) throw new Refused([`no upgrade recorded in ${ctx.paths.state}; there is nothing to roll back to`]);
  if (!last.fromVersionId && !opts.restoreDb) {
    throw new Refused([`the last upgrade changed only the D1 schema, not the Worker; pass --restore-db to restore D1 to bookmark ${last.d1Bookmark}`]);
  }
  if (opts.restoreDb && !last.d1Bookmark) {
    throw new Refused(["the last upgrade applied no migrations, so no D1 bookmark was recorded and the store needs no restore; drop --restore-db"]);
  }
  deps.log(
    `postern rollback: ${last.fromVersionId ? `Worker ${opts.name} -> version ${last.fromVersionId}` : `Worker ${opts.name} unchanged`}` +
      `${opts.restoreDb ? `; D1 ${opts.d1Name} -> bookmark ${last.d1Bookmark} (mail stored since the upgrade is LOST)` : ""}`,
  );
  if (opts.dryRun) return { changes: [["would", "rollback"]] };
  if (last.fromVersionId) {
    const r = await ctx.wrangler(["rollback", last.fromVersionId, "--name", opts.name, "--message", "postern installer rollback", "--yes"]);
    if (r.code !== 0) throw new Error(`wrangler rollback failed:\n${tail(r)}`);
    ctx.rep.updated(`Worker ${opts.name} now serves version ${last.fromVersionId}`);
    ctx.state.deploy = { hash: null, versionId: last.fromVersionId };
  }
  if (opts.restoreDb) {
    writeConfig(ctx);
    const d = await ctx.wrangler(["d1", "time-travel", "restore", opts.d1Name, "--bookmark", last.d1Bookmark, "-c", ctx.paths.config]);
    if (d.code !== 0) throw new Error(`D1 restore failed:\n${tail(d)}`);
    ctx.rep.updated(`D1 ${opts.d1Name} restored to bookmark ${last.d1Bookmark}`);
    // The store is now as it was before the upgrade, so a user created after the
    // bookmark is gone. Forget that the admin exists; the next run re-creates it
    // (create-only: 409 if it survived the restore).
    if (ctx.state.admin && last.adminCreatedAfterBookmark) delete ctx.state.admin;
  }
  ctx.state.history.pop();
  saveState(opts, ctx.state);
  return { changes: ctx.rep.changes };
}

// ---------------------------------------------------------------------------
// UNINSTALL (#831). Removes only what this installer's state file records, in reverse
// order of install, data last.
//
// Email Routing is NEVER disabled. Disabling it makes Cloudflare DELETE the zone's MX,
// SPF and DKIM records (measured in pt1110), which takes away mail the operator may
// still want to receive somewhere else. Uninstall points the catch-all away from the
// Worker (disabled, drop) and says so; turning Routing off is left to the operator.
//
// Mail is kept by default. --delete-data deletes D1 and R2 only with
// --confirm-delete <domain> typed out, and only after `wrangler d1 export` has written
// a non-empty .sql file next to the state file.
// Every ordinary table in D1, for a table-by-table export. Left out: each virtual table and
// its shadow tables (<name>_data, _idx, _content, _docsize, _config), SQLite's own sqlite_*
// tables, and D1's internal _cf_* tables.
async function exportableTables(ctx, accountId, d1Id) {
  const res = await ctx.cf.call("list the D1 tables", P.d1, "POST", `/accounts/${accountId}/d1/database/${d1Id}/query`, {
    sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  });
  const rows = res.result?.[0]?.results || [];
  const virtual = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql || "")).map((r) => r.name);
  const shadow = (n) => virtual.some((v) => n.startsWith(`${v}_`));
  const skipped = rows.map((r) => r.name).filter((n) => virtual.includes(n) || shadow(n));
  const tables = rows.map((r) => r.name).filter((n) => !skipped.includes(n) && !/^sqlite_/i.test(n) && !/^_cf_/i.test(n));
  return { tables, skipped };
}

export async function uninstall(deps, opts) {
  const ctx = makeCtx(deps, opts, "uninstall");
  return guarded(ctx, () => uninstallRun(ctx, opts));
}

async function uninstallRun(ctx, opts) {
  const { cf, state, rep, log, paths } = ctx;
  const owned = state.owned || {};
  if (!state.accountId || !state.zoneId || !Object.keys(owned).length) {
    throw new Refused([`no install recorded in ${paths.state}. Uninstall removes only what this installer recorded creating, and nothing is recorded.`]);
  }
  if (opts.deleteData && opts.confirmDelete !== opts.domain) {
    throw new Refused([`--delete-data deletes every stored message and attachment. Confirm it by also passing --confirm-delete ${opts.domain} (the domain, typed out).`]);
  }
  const zones = await cf.list("look up the zone", P.zone, `/zones?name=${encodeURIComponent(opts.domain)}`);
  const zone = zones.find((z) => norm(z.name) === norm(opts.domain));
  if (!zone || zone.id !== state.zoneId || zone.account?.id !== state.accountId) {
    throw new Refused([`the state file records zone ${state.zoneId} in account ${state.accountId}, and ${opts.domain} is not that zone for this token. Nothing was changed.`]);
  }
  const z = state.zoneId;
  const a = state.accountId;
  const dry = opts.dryRun;
  log(`postern uninstall: ${opts.domain}, Worker ${opts.name}${dry ? " (dry run: nothing will change)" : ""}`);

  // 1. Routing: the catch-all stops pointing at the Worker. Routing itself stays on.
  const ca = (await cf.call("read the catch-all rule", P.routing, "GET", `/zones/${z}/email/routing/rules/catch_all`, undefined, { allow404: true }))?.result;
  const ours = ca && (ca.actions || []).some((x) => x.type === "worker" && (x.value || []).includes(opts.name));
  if (ours) {
    if (dry) rep.would(`disable the catch-all rule (it sends every address to Worker ${opts.name})`);
    else {
      await cf.call("disable the catch-all rule", P.routing, "PUT", `/zones/${z}/email/routing/rules/catch_all`, {
        actions: [{ type: "drop" }], matchers: [{ type: "all" }], enabled: false, name: "catch-all (postern uninstalled)",
      });
      rep.updated(`catch-all rule: disabled (it sent every address to Worker ${opts.name})`);
    }
  } else rep.unchanged(`catch-all rule (it does not point at Worker ${opts.name})`);
  rep.kept(`Email Routing on ${opts.domain} stays enabled: turning it off makes Cloudflare delete the zone's MX, SPF and DKIM records. Turn it off yourself if you mean to stop receiving mail for ${opts.domain}.`);

  // 2. The Worker's custom domain, then the Worker.
  if (owned.worker) {
    const doms = await cf.list("list Worker custom domains", P.workers, `/accounts/${a}/workers/domains?hostname=${encodeURIComponent(state.hostname || opts.hostname)}`);
    for (const d of doms.filter((d) => d.service === opts.name)) {
      if (dry) { rep.would(`detach custom domain ${d.hostname} from Worker ${opts.name}`); continue; }
      await cf.call(`detach custom domain ${d.hostname}`, P.workers, "DELETE", `/accounts/${a}/workers/domains/${d.id}`);
      rep.removed(`custom domain ${d.hostname}`);
    }
    const script = await cf.call("read the Worker", P.workers, "GET", `/accounts/${a}/workers/scripts/${opts.name}/settings`, undefined, { allow404: true });
    if (!script) rep.unchanged(`Worker ${opts.name} (already gone)`);
    else if (dry) rep.would(`delete Worker ${opts.name}`);
    else {
      await cf.call("delete the Worker", P.workers, "DELETE", `/accounts/${a}/workers/scripts/${opts.name}?force=true`);
      rep.removed(`Worker ${opts.name}`);
    }
    if (!dry) { delete owned.worker; delete state.deploy; saveState(opts, state); }
  }

  // 3. Email Sending, only if this installer enabled it. Cloudflare's DELETE removes the
  //    Sending DNS records it added (measured 2026-11-10: all five cf-bounce MX / TXT / DKIM
  //    records were gone after the DELETE).
  if (owned.sending) {
    if (dry) rep.would(`disable Email Sending for ${opts.domain} (Cloudflare removes its Sending DNS records)`);
    else {
      await cf.call("disable Email Sending", P.sending, "DELETE", `/zones/${z}/email/sending/subdomains/${owned.sending}`, undefined, { allow404: true });
      delete owned.sending;
      saveState(opts, state);
      rep.removed(`Email Sending for ${opts.domain}`);
    }
  } else rep.kept(`Email Sending for ${opts.domain}: this installer did not record enabling it, so it is left as it is`);

  // 4. Data: kept unless asked, exported before it is deleted.
  if (!opts.deleteData) {
    if (owned.d1 || owned.bucket) {
      rep.kept(`D1 ${opts.d1Name} and R2 ${opts.bucket}: your mail is kept. To delete it, re-run with --delete-data --confirm-delete ${opts.domain} (D1 is exported to a file first).`);
    }
  } else {
    if (owned.d1 && state.d1Id) {
      const file = join(opts.stateDir, `${opts.name}.${opts.domain}.export-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
      if (dry) rep.would(`export D1 ${opts.d1Name} to ${file}, then delete it`);
      else {
        writeConfig(ctx);
        // Measured 2026-11-10: wrangler refuses to export a database that has a virtual table
        // ("cannot export databases with virtual tables (like FTS5)"), and Postern's schema has
        // messages_fts. So export every ordinary table by name, and leave out the virtual tables
        // and their shadow tables. They are a search index built from messages.
        const t = await exportableTables(ctx, a, state.d1Id);
        if (!t.tables.length) throw new Error(`D1 ${opts.d1Name} lists no tables to export, so it was NOT deleted`);
        const r = await ctx.wrangler(["d1", "export", opts.d1Name, "--remote", ...t.tables.flatMap((x) => ["--table", x]), "--output", file, "--skip-confirmation", "-c", paths.config]);
        if (r.code !== 0) throw new Error(`exporting D1 failed, so it was NOT deleted:\n${tail(r)}`);
        let size = 0;
        try { size = statSync(file).size; } catch { size = 0; }
        if (!size) throw new Error(`the D1 export at ${file} is missing or empty, so D1 was NOT deleted`);
        chmodSync(file, 0o600);
        log(`  exported D1 ${opts.d1Name} to ${file} (${size} bytes, ${t.tables.length} tables)`);
        if (t.skipped.length) {
          log(`  not exported: ${t.skipped.join(", ")}. wrangler cannot export a virtual table; this is the search index, built from messages, and Postern's migrations recreate it.`);
        }
        await cf.call("delete the D1 database", P.d1, "DELETE", `/accounts/${a}/d1/database/${state.d1Id}`);
        delete owned.d1;
        delete state.d1Id;
        saveState(opts, state);
        rep.removed(`D1 database ${opts.d1Name} (export kept at ${file})`);
      }
    }
    if (owned.bucket) {
      if (dry) rep.would(`delete R2 bucket ${opts.bucket} (only if it is empty)`);
      else {
        try {
          await cf.call("delete the R2 bucket", P.r2, "DELETE", `/accounts/${a}/r2/buckets/${opts.bucket}`);
          delete owned.bucket;
          saveState(opts, state);
          rep.removed(`R2 bucket ${opts.bucket}`);
        } catch (e) {
          if (!(e instanceof CfError) || e.permissionDenied) throw e;
          rep.kept(`R2 bucket ${opts.bucket}: Cloudflare deletes only an empty bucket (${e.message}). Empty it, then re-run.`);
        }
      }
    }
  }

  const left = Object.keys(owned);
  if (!dry && !left.length) { state.uninstalledAt = new Date().toISOString(); saveState(opts, state); }
  const n = rep.changes.filter((c) => c[0] !== "would").length;
  log("");
  log(dry ? `dry run: ${rep.changes.length} change(s) would be made.` : `done: ${n} change(s) made.${left.length ? ` Still recorded: ${left.join(", ")}.` : ""}`);
  if (!dry) log(`credentials: ${paths.creds} still holds the mailbox token and admin password. Delete it yourself when you no longer need it.`);
  return { changes: rep.changes, state };
}
