// fake-cloudflare.mjs -- an in-memory Cloudflare account for the installer tests.
//
// It models only what the installer touches, and it answers the way the real
// API does on the paths that matter for safety: a scope miss is HTTP 403 with
// error code 10000, a missing Worker is 404, a fresh D1 has no d1_migrations
// table. Every request is logged, so a test can assert "no writes happened".

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realExec } from "../postern.mjs";

export const TOKEN = "cf-test-token-DO-NOT-PRINT-7f3a";

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const ok = (result, extra = {}) => json(200, { success: true, errors: [], result, ...extra });
const fail = (status, code, message) => json(status, { success: false, errors: [{ code, message }], result: null });

export function newAccount(domain = "acme-mail.test") {
  return {
    domain,
    zone: { id: "zone-1", name: domain, account: { id: "acct-1" } },
    dns: [],
    routing: { enabled: false },
    rules: [],
    catchAll: { id: "ca", enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
    sendingSubs: [],
    sendingDns: [
      { type: "TXT", name: `cf-bounce._domainkey.${domain}`, content: "v=DKIM1; h=sha256; k=rsa; p=FAKEKEY" },
      { type: "MX", name: `cf-bounce.${domain}`, content: "route.mx.cloudflare.net", priority: 10 },
      { type: "TXT", name: `cf-bounce.${domain}`, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
      // the real API lists this too (measured 2026-11-10)
      { type: "TXT", name: `_dmarc.${domain}`, content: '"v=DMARC1; p=reject;"' },
    ],
    scripts: {},
    d1: [],
    r2: [],
    domains: [],
    migrations: {},
    admins: {},
    restores: [],
    denied: new Set(),
    faults: [],
    wranglerFaults: [],
    requests: [],
    wranglerCalls: [],
    seq: 0,
  };
}

function permOf(path) {
  if (path.startsWith("/zones?")) return "zone";
  if (path.includes("/dns_records")) return "dns";
  // Real API: the settings read and the enable/disable calls take Zone Settings; the
  // rules (and the catch-all) take Email Routing Rules (#802).
  if (/\/email\/routing(\/dns|\/disable|\/enable)?(\?|$)/.test(path)) return "settings";
  if (path.includes("/email/routing")) return "routing";
  if (path.includes("/email/sending")) return "sending";
  if (path.includes("/d1/")) return "d1";
  if (path.includes("/r2/")) return "r2";
  if (path.includes("/workers/")) return "workers";
  return "other";
}

const uuid = (m) => {
  m.seq++;
  return `00000000-0000-4000-8000-${String(m.seq).padStart(12, "0")}`;
};

export function fakeFetch(m) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/client\/v4/, "") + u.search;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    m.requests.push({ method, path, body });
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) return fail(401, 10001, "bad token");

    const fault = m.faults.find((f) => f.method === method && f.re.test(path) && f.times > 0);
    if (fault) {
      fault.times--;
      return fail(fault.status || 500, 10500, fault.message ?? "injected fault");
    }
    const perm = permOf(path);
    if (m.denied.has(perm)) return fail(403, 10000, "Authentication error");

    const p = u.pathname.replace(/^\/client\/v4/, "");
    const q = u.searchParams;
    const z = `/zones/${m.zone.id}`;
    const a = `/accounts/${m.zone.account.id}`;
    let mm;

    if (method === "GET" && p === "/zones") return ok(q.get("name") === m.zone.name ? [m.zone] : [], { result_info: { total_pages: 1 } });

    if (p === `${z}/dns_records`) {
      if (method === "GET") {
        let r = m.dns;
        if (q.get("type")) r = r.filter((x) => x.type === q.get("type"));
        return ok(r, { result_info: { total_pages: 1 } });
      }
      if (method === "POST") {
        const rec = { id: `dns-${uuid(m)}`, ...body };
        m.dns.push(rec);
        return ok(rec);
      }
    }

    if ((mm = new RegExp(`^${z}/dns_records/([^/]+)$`).exec(p))) {
      const rec = m.dns.find((x) => x.id === mm[1]);
      if (!rec) return fail(404, 81044, "Record does not exist.");
      if (method === "GET") return ok(rec);
      if (method === "DELETE") { m.dns = m.dns.filter((x) => x !== rec); return ok({ id: rec.id }); }
    }

    if (p === `${z}/email/routing` && method === "GET") return ok(m.routing);
    if (p === `${z}/email/routing/disable` && method === "POST") {
      // measured 2026-11-10: disabling Routing deletes the MX / SPF / DKIM it manages
      m.routing.enabled = false;
      m.dns = m.dns.filter((r) => !(r.type === "MX" && r.name === m.domain) && !(r.type === "TXT" && r.name === m.domain && /^v=spf1/.test(r.content)));
      return ok(m.routing);
    }
    if (p === `${z}/email/routing/dns` && method === "POST") {
      m.routing.enabled = true;
      for (const n of [1, 2, 3]) m.dns.push({ id: `mx${n}`, type: "MX", name: m.domain, content: `route${n}.mx.cloudflare.net`, priority: n });
      if (!m.dns.some((r) => r.type === "TXT" && r.name === m.domain && /^v=spf1/.test(r.content))) {
        m.dns.push({ id: "spf", type: "TXT", name: m.domain, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" });
      }
      return ok(m.routing);
    }
    // The real list includes the catch-all rule itself (measured 2026-11-10, #802).
    if (p === `${z}/email/routing/rules` && method === "GET") return ok([...m.rules, m.catchAll], { result_info: { total_pages: 1 } });
    if (p === `${z}/email/routing/rules/catch_all`) {
      if (method === "GET") return ok(m.catchAll);
      if (method === "PUT") {
        m.catchAll = { id: "ca", ...body };
        return ok(m.catchAll);
      }
    }

    if (p === `${z}/email/sending/subdomains`) {
      if (method === "GET") return ok(m.sendingSubs);
      if (method === "POST") {
        const s = { tag: `sub-${uuid(m)}`, name: body.name, enabled: true };
        m.sendingSubs.push(s);
        // The real API (measured 2026-11-10): it adds its own records, locked, and a
        // _dmarc p=reject when the domain has no DMARC yet.
        if (m.sendingAutoDns !== false) {
          for (const w of m.sendingDns) {
            const isDmarc = w.name.startsWith("_dmarc.");
            if (isDmarc && m.dns.some((r) => r.type === "TXT" && r.name === w.name)) continue;
            m.dns.push({ id: `auto-${uuid(m)}`, ...w, content: isDmarc ? "v=DMARC1; p=reject;" : w.content, meta: { read_only: !isDmarc } });
          }
        }
        return ok(s);
      }
    }
    if ((mm = new RegExp(`^${z}/email/sending/subdomains/([^/]+)$`).exec(p)) && method === "DELETE") {
      // API reference: disables sending and removes its DNS records.
      if (!m.sendingSubs.some((s) => s.tag === mm[1])) return fail(404, 1000, "no such subdomain");
      m.sendingSubs = m.sendingSubs.filter((s) => s.tag !== mm[1]);
      m.dns = m.dns.filter((r) => !String(r.id).startsWith("auto-") || r.name.startsWith("_dmarc."));
      return ok(null);
    }
    if ((mm = new RegExp(`^${z}/email/sending/subdomains/([^/]+)/dns$`).exec(p)) && method === "GET") {
      return m.sendingSubs.some((s) => s.tag === mm[1]) ? ok(m.sendingDns) : fail(404, 1000, "no such subdomain");
    }

    if (p === `${a}/workers/scripts` && method === "GET") {
      return ok(Object.keys(m.scripts).map((id) => ({ id })), { result_info: { total_pages: 1 } });
    }
    if ((mm = new RegExp(`^${a}/workers/scripts/([^/]+)/(settings|deployments|secrets)$`).exec(p)) && method === "GET") {
      const s = m.scripts[mm[1]];
      if (!s) return fail(404, 10007, "This Worker does not exist on your account.");
      if (mm[2] === "settings") return ok({ bindings: Object.entries(s.vars || {}).map(([name, text]) => ({ name, type: "plain_text", text })) });
      if (mm[2] === "secrets") return ok([...s.secrets.keys()].map((name) => ({ name, type: "secret_text" })));
      return ok({ deployments: [{ id: "dep", versions: [{ version_id: s.live, percentage: 100 }] }] });
    }
    if ((mm = new RegExp(`^${a}/workers/scripts/([^/]+)$`).exec(p)) && method === "DELETE") {
      if (!m.scripts[mm[1]]) return fail(404, 10007, "This Worker does not exist on your account.");
      delete m.scripts[mm[1]];
      return ok(null);
    }
    if ((mm = new RegExp(`^${a}/workers/domains/([^/]+)$`).exec(p)) && method === "DELETE") {
      const d = m.domains.find((x) => x.id === mm[1]);
      if (!d) return fail(404, 100116, "domain not found");
      m.domains = m.domains.filter((x) => x !== d);
      m.dns = m.dns.filter((r) => !(r.name === d.hostname && r.type === "AAAA"));
      return ok(null);
    }
    if (p === `${a}/workers/domains` && method === "GET") {
      const h = q.get("hostname");
      return ok(h ? m.domains.filter((d) => d.hostname === h) : m.domains, { result_info: { total_pages: 1 } });
    }

    if (p === `${a}/d1/database`) {
      if (method === "GET") {
        const n = q.get("name");
        return ok(n ? m.d1.filter((d) => d.name === n) : m.d1, { result_info: { total_pages: 1 } });
      }
      if (method === "POST") {
        const d = { uuid: `d1-${uuid(m)}`, name: body.name };
        m.d1.push(d);
        return ok(d);
      }
    }
    if ((mm = new RegExp(`^${a}/d1/database/([^/]+)$`).exec(p)) && method === "DELETE") {
      if (!m.d1.some((d) => d.uuid === mm[1])) return fail(404, 7404, "database not found");
      m.d1 = m.d1.filter((d) => d.uuid !== mm[1]);
      return ok(null);
    }
    if ((mm = new RegExp(`^${a}/d1/database/([^/]+)/query$`).exec(p)) && method === "POST") {
      const applied = m.migrations[mm[1]];
      // The table list, as a real migrated Postern D1 answers it (measured 2026-11-10): an FTS5
      // virtual table with its shadow tables, D1's _cf_KV, and sqlite_sequence.
      if (/sqlite_master/.test(body?.sql || "")) {
        if (!applied) return ok([{ results: [] }]);
        const t = (name, sql = `CREATE TABLE ${name} (id INTEGER)`) => ({ name, sql });
        return ok([{ results: [t("_cf_KV"), t("d1_migrations"), t("messages"),
          t("messages_fts", "CREATE VIRTUAL TABLE messages_fts USING fts5(subject, body_text, content='messages')"),
          t("messages_fts_config"), t("messages_fts_data"), t("messages_fts_docsize"), t("messages_fts_idx"),
          t("sqlite_sequence"), t("webmail_sessions")] }]);
      }
      if (!applied) return fail(400, 7500, "no such table: d1_migrations: SQLITE_ERROR");
      return ok([{ results: applied.map((name, i) => ({ id: i + 1, name })) }]);
    }
    if ((mm = new RegExp(`^${a}/d1/database/([^/]+)/time_travel/bookmark$`).exec(p)) && method === "GET") {
      return ok({ bookmark: `bookmark-${(m.migrations[mm[1]] || []).length}` });
    }

    if (p === `${a}/r2/buckets` && method === "GET") return ok({ buckets: m.r2 });
    if (p === `${a}/r2/buckets` && method === "POST") {
      m.r2.push({ name: body.name });
      return ok({ name: body.name });
    }
    if ((mm = new RegExp(`^${a}/r2/buckets/([^/]+)$`).exec(p)) && method === "DELETE") {
      if (!m.r2.some((x) => x.name === mm[1])) return fail(404, 10006, "The specified bucket does not exist.");
      if ((m.r2Objects?.[mm[1]] ?? 0) > 0) return fail(409, 10008, "The bucket you tried to delete is not empty.");
      m.r2 = m.r2.filter((x) => x.name !== mm[1]);
      return ok(null);
    }
    if ((mm = new RegExp(`^${a}/r2/buckets/([^/]+)$`).exec(p)) && method === "GET") {
      const b = m.r2.find((x) => x.name === mm[1]);
      return b ? ok(b) : fail(404, 10006, "The specified bucket does not exist.");
    }

    return fail(404, 7003, `fake has no route for ${method} ${p}`);
  };
}

// The pinned wrangler, faked: it reads the rendered config exactly as the real one would.
export function fakeExec(m) {
  return async (cmd, args, opts = {}) => {
    if (cmd === "node") return realExec(cmd, args, opts);
    m.wranglerCalls.push(args.join(" "));
    if (opts.env?.CLOUDFLARE_API_TOKEN !== TOKEN) return { code: 1, stdout: "", stderr: "no token" };
    const fault = m.wranglerFaults.find((f) => f.re.test(args.join(" ")) && f.times > 0);
    if (fault) {
      fault.times--;
      return { code: 1, stdout: fault.stdout ?? "", stderr: fault.stderr ?? "✘ [ERROR] injected wrangler fault" };
    }
    const cfgPath = args[args.indexOf("-c") + 1];
    const cfg = args.includes("-c") ? JSON.parse(readFileSync(cfgPath, "utf8")) : null;

    if (args[0] === "deploy" && args.includes("--dry-run")) {
      const out = args[args.indexOf("--outdir") + 1];
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.js"), readFileSync(cfg.main));
      // the real wrangler's run-to-run noise: a timestamped README and a varying map
      writeFileSync(join(out, "README.md"), `generated at ${new Date().toISOString()} ${Math.random()}`);
      writeFileSync(join(out, "index.js.map"), JSON.stringify({ version: 3, sources: [`/tmp/${Math.random()}`] }));
      return { code: 0, stdout: "--dry-run: exiting now.", stderr: "" };
    }
    if (args[0] === "deploy") {
      const s = (m.scripts[cfg.name] ??= { versions: [], secrets: new Map(), live: null, vars: {} });
      const sf = args.includes("--secrets-file") ? args[args.indexOf("--secrets-file") + 1] : null;
      if (sf) for (const [k, v] of Object.entries(JSON.parse(readFileSync(sf, "utf8")))) s.secrets.set(k, v);
      const id = uuid(m);
      s.versions.push(id);
      s.live = id;
      s.vars = cfg.vars;
      for (const r of cfg.routes || []) {
        if (r.custom_domain && !m.domains.some((d) => d.hostname === r.pattern)) {
          m.domains.push({ id: `dom-${id}`, hostname: r.pattern, service: cfg.name });
          m.dns.push({ id: `cd-${id}`, type: "AAAA", name: r.pattern, content: "100::" });
        }
      }
      return { code: 0, stdout: `Uploaded ${cfg.name}\nCurrent Version ID: ${id}\n`, stderr: "" };
    }
    if (args[0] === "d1" && args[1] === "migrations" && args[2] === "apply") {
      const db = cfg.d1_databases.find((d) => d.binding === "DB");
      const applied = (m.migrations[db.database_id] ??= []);
      for (const f of readdirSync(db.migrations_dir).filter((f) => f.endsWith(".sql")).sort()) {
        if (!applied.includes(f)) applied.push(f);
      }
      return { code: 0, stdout: "Migrations applied", stderr: "" };
    }
    if (args[0] === "rollback") {
      const s = m.scripts[args[args.indexOf("--name") + 1]];
      s.live = args[1];
      return { code: 0, stdout: "rolled back", stderr: "" };
    }
    if (args[0] === "d1" && args[1] === "export") {
      const out = args[args.indexOf("--output") + 1];
      // The real wrangler refuses a whole-database export when the database has a virtual table
      // (measured 2026-11-10), and a migrated Postern D1 always has messages_fts. It refuses a
      // named virtual or shadow table the same way.
      const named = args.flatMap((x, i) => (args[i - 1] === "--table" ? [x] : []));
      if (!named.length || named.some((x) => /^messages_fts/.test(x))) {
        return { code: 1, stdout: "", stderr: "✘ [ERROR] D1 Export error: cannot export databases with virtual tables (like FTS5)" };
      }
      m.exportTables = named;
      writeFileSync(out, m.exportEmpty ? "" : "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE messages (uid INTEGER);\n");
      m.exports = [...(m.exports || []), out];
      return { code: 0, stdout: `exported to ${out}`, stderr: "" };
    }
    if (args[0] === "d1" && args[1] === "time-travel" && args[2] === "restore") {
      m.restores.push({ db: args[3], bookmark: args[args.indexOf("--bookmark") + 1] });
      return { code: 0, stdout: "restored", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `fake wrangler: unhandled ${args.join(" ")}` };
  };
}

// The deployed Worker, faked at its two installer-facing routes.
export function fakeHttp(m) {
  return async (url, init = {}) => {
    const u = new URL(url);
    m.requests.push({ method: init.method || "GET", path: `https://${u.host}${u.pathname}`, body: init.body });
    const dom = m.domains.find((d) => d.hostname === u.host);
    const s = dom && m.scripts[dom.service];
    if (!s || !s.live) throw new Error("connection refused");
    if (u.pathname === "/health") return json(200, { ok: true });
    // #901: the principals backfill. Admin-scoped: only the estate token. Convergent: the
    // first call reports what it added, later calls report nothing to do.
    if (u.pathname === "/api/admin/principals/backfill" && init.method === "POST") {
      if (init.headers?.authorization !== `Bearer ${s.secrets.get("POSTERN_API_TOKEN")}`) return json(401, { ok: false, error: "E_UNAUTHORIZED" });
      if (m.backfillStatus) return json(m.backfillStatus, { ok: false, error: m.backfillStatus === 404 ? "not_found" : "E_INTERNAL" });
      m.backfills = (m.backfills || 0) + 1;
      const first = m.backfills === 1;
      return json(200, { ok: true, services: { added: first ? 3 : 0 }, agents: { added: 0, synced: 0 },
        humans: { added: first ? 1 : 0, synced: 0, orphansRevoked: 0 }, addressConflicts: m.backfillConflicts || [] });
    }
    // #810 contract: create only, never overwrite.
    if (u.pathname === "/api/admin/users" && init.method === "POST") {
      if (init.headers?.authorization !== `Bearer ${s.secrets.get("POSTERN_API_TOKEN")}`) return json(401, { ok: false, error: "E_UNAUTHORIZED" });
      const b = JSON.parse(init.body);
      if (m.admins[b.username]) return json(409, { ok: false, error: "E_CONFLICT", message: "a user with that username already exists" });
      m.admins[b.username] = b.password;
      return json(201, { ok: true, user: { username: b.username, from: b.from } });
    }
    return json(404, { ok: false });
  };
}

// A minimal repo: the REAL template, migrations and migration gate, plus a stub source file.
export function makeFixtureRepo(realRoot, dir) {
  mkdirSync(join(dir, "inbound", "src"), { recursive: true });
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  cpSync(join(realRoot, "inbound", "wrangler.jsonc"), join(dir, "inbound", "wrangler.jsonc"));
  cpSync(join(realRoot, "inbound", "migrations"), join(dir, "inbound", "migrations"), { recursive: true });
  cpSync(join(realRoot, ".github", "scripts", "d1-migration-gate.mjs"), join(dir, ".github", "scripts", "d1-migration-gate.mjs"));
  writeFileSync(join(dir, "inbound", "src", "index.ts"), "export default {};\n");
  writeFileSync(join(dir, "inbound", "src", "version.ts"), 'export const VERSION = "1.8.0";\n');
  if (!existsSync(join(dir, "inbound", "migrations"))) throw new Error("fixture has no migrations");
  return dir;
}
