// installer.test.mjs -- the installer against a stubbed Cloudflare account.
// Run: node --test deploy/test/*.test.mjs
//
// No test here talks to a real Cloudflare account. Each case asserts on the
// fake's STATE and its request log, not on the installer's prose.

import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cfClient } from "../lib/cf.mjs";
import { Refused, install, rollback } from "../lib/installer.mjs";
import { parseArgs } from "../postern.mjs";
import { TOKEN, fakeExec, fakeFetch, fakeHttp, makeFixtureRepo, newAccount } from "./fake-cloudflare.mjs";

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "postern-installer-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function setup(extra = {}) {
  const dir = join(scratch, `case-${++n}`);
  const repoRoot = makeFixtureRepo(REAL_ROOT, join(dir, "repo"));
  const m = newAccount();
  const out = [];
  let secretSeq = 0;
  const deps = {
    cf: cfClient({ token: TOKEN, fetch: fakeFetch(m) }),
    token: TOKEN,
    exec: fakeExec(m),
    http: fakeHttp(m),
    sleep: async () => {},
    log: (s) => out.push(s),
    repoRoot,
    appVersion: "1.8.0",
    healthTries: 2,
    healthDelayMs: 0,
    randomSecret: () => `generated-secret-${++secretSeq}-0123456789abcdef0123456789abcdef`,
  };
  const opts = parseArgs(["install", "--domain", "acme-mail.test", "--state-dir", join(dir, "state"), ...(extra.args || [])]);
  return { m, deps, opts, out, dir, repoRoot };
}

const writes = (m) => m.requests.filter((r) => r.method !== "GET" && !/\/d1\/database\/[^/]+\/query$/.test(r.path));
const wranglerWrites = (m) => m.wranglerCalls.filter((c) => !c.includes("--dry-run"));

function assertNoSecretPrinted(t, text) {
  assert.ok(!text.includes(TOKEN), "the Cloudflare token was printed");
  assert.ok(!/generated-secret-/.test(text), "a generated secret was printed");
}

async function expectRefusal(ctx, pattern) {
  const before = { api: writes(ctx.m).length, wr: wranglerWrites(ctx.m).length };
  await assert.rejects(install(ctx.deps, ctx.opts), (e) => {
    assert.ok(e instanceof Refused, `expected a refusal, got: ${e.message}`);
    assert.match(e.message, pattern);
    assertNoSecretPrinted(null, e.message);
    return true;
  });
  assert.equal(writes(ctx.m).length, before.api, "a refused run made an API write");
  assert.equal(wranglerWrites(ctx.m).length, before.wr, "a refused run ran a mutating wrangler command");
}

describe("install", () => {
  test("a fresh account gets every resource, and the output names each one", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const { m } = c;
    assert.equal(m.d1.length, 1);
    assert.deepEqual(m.r2.map((b) => b.name), ["postern-attachments"]);
    assert.ok(m.scripts.postern.live, "Worker not deployed");
    assert.ok(m.scripts.postern.secrets.get("POSTERN_API_TOKEN"), "mailbox token not set");
    assert.equal(m.scripts.postern.vars.ALLOWED_FROM_DOMAIN, "acme-mail.test");
    assert.equal(m.scripts.postern.vars.DEFAULT_FROM, "noreply@acme-mail.test");
    assert.equal(m.scripts.postern.vars.WEBMAIL_AUTH_BACKEND, "native");
    const applied = m.migrations[m.d1[0].uuid];
    assert.ok(applied.includes("0000_base_schema.sql") && applied.length >= 15, "migrations not applied");
    assert.equal(m.routing.enabled, true);
    assert.deepEqual(m.catchAll.actions, [{ type: "worker", value: ["postern"] }]);
    assert.equal(m.catchAll.enabled, true);
    assert.ok(m.dns.some((r) => r.name === "cf-bounce._domainkey.acme-mail.test"), "DKIM record missing");
    assert.ok(m.dns.some((r) => r.name === "_dmarc.acme-mail.test" && r.content === "v=DMARC1; p=none"), "DMARC missing");
    assert.equal(m.dns.filter((r) => r.type === "TXT" && r.name === "acme-mail.test" && /^v=spf1/.test(r.content)).length, 1, "SPF duplicated");
    assert.ok(m.admins["admin@acme-mail.test"], "first admin not created");
    assert.deepEqual(m.domains, [{ hostname: "mail.acme-mail.test", service: "postern" }]);

    const text = c.out.join("\n");
    for (const w of ["D1 database postern", "R2 bucket postern-attachments", "Worker postern", "Email Sending for acme-mail.test", "Email Routing on acme-mail.test", "catch-all rule -> Worker postern", "DNS TXT _dmarc.acme-mail.test", "first admin admin@acme-mail.test"]) {
      assert.match(text, new RegExp(`[+~] (created|updated)   .*${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `output does not say it created ${w}`);
    }
    assertNoSecretPrinted(null, text);
    assert.match(text, /E_SENDER_DOMAIN_NOT_AVAILABLE[\s\S]*about a minute before the first send/);
    assert.match(text, /wrote v=DMARC1; p=none before enabling Sending/);
  });

  test("the credentials file is mode 600 and holds what the installer generated", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const fd = openSync(join(c.opts.stateDir, "postern.acme-mail.test.credentials.env"), "r");
    const mode = fstatSync(fd).mode & 0o777;
    const body = readFileSync(fd, "utf8");
    closeSync(fd);
    assert.equal(mode, 0o600);
    assert.match(body, /^POSTERN_API_URL=https:\/\/mail\.acme-mail\.test$/m);
    const tok = /^POSTERN_API_TOKEN=(.*)$/m.exec(body)[1];
    assert.equal(c.m.scripts.postern.secrets.get("POSTERN_API_TOKEN"), tok);
    const pw = /^POSTERN_ADMIN_PASSWORD=(.*)$/m.exec(body)[1];
    assert.equal(c.m.admins["admin@acme-mail.test"], pw);
    assert.equal(statSync(c.opts.stateDir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(c.opts.stateDir).filter((f) => f.startsWith(".secrets-")), [], "the temporary secrets file was left behind");
  });

  test("a state dir that already existed with loose permissions is tightened to 700", async () => {
    const c = setup();
    mkdirSync(c.opts.stateDir, { recursive: true, mode: 0o755 });
    await install(c.deps, c.opts);
    assert.equal(statSync(c.opts.stateDir).mode & 0o777, 0o700);
  });

  test("IDEMPOTENT: a second run makes no write of any kind", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const api = writes(c.m).length;
    const wr = wranglerWrites(c.m).length;
    const http = c.m.requests.filter((r) => r.path.startsWith("https://")).length;
    const dnsBefore = JSON.stringify(c.m.dns);
    c.out.length = 0;
    const res = await install(c.deps, c.opts);
    assert.equal(writes(c.m).length, api, `second run wrote: ${JSON.stringify(writes(c.m).slice(api))}`);
    assert.equal(wranglerWrites(c.m).length, wr, `second run ran: ${wranglerWrites(c.m).slice(wr)}`);
    assert.equal(c.m.requests.filter((r) => r.path.startsWith("https://")).length, http, "second run called the Worker");
    assert.equal(JSON.stringify(c.m.dns), dnsBefore);
    assert.equal(res.changes.length, 0);
    assert.match(c.out.join("\n"), /nothing to change/);
    assert.ok(!c.out.some((l) => l.startsWith("+") || l.startsWith("~")), "a second run reported a change");
  });

  test("a source change redeploys the Worker and nothing else", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const first = c.m.scripts.postern.live;
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { changed: true };\n");
    const res = await install(c.deps, c.opts);
    assert.notEqual(c.m.scripts.postern.live, first);
    assert.deepEqual(res.changes.map((x) => x[0]), ["updated"]);
  });

  test("RESUME: a run that dies halfway is finished by re-running it, with no duplicates", async () => {
    const c = setup();
    c.m.faults.push({ method: "POST", re: /\/email\/routing\/dns$/, times: 1 });
    await assert.rejects(install(c.deps, c.opts), /enable Email Routing failed: HTTP 500/);
    assert.equal(c.m.routing.enabled, false);
    assert.ok(c.m.scripts.postern.live, "the steps before the fault should have landed");
    const deploys = wranglerWrites(c.m).filter((x) => x.startsWith("deploy")).length;

    await install(c.deps, c.opts);
    assert.equal(c.m.routing.enabled, true);
    assert.equal(c.m.d1.length, 1, "resume created a second D1");
    assert.equal(c.m.r2.length, 1, "resume created a second bucket");
    assert.equal(wranglerWrites(c.m).filter((x) => x.startsWith("deploy")).length, deploys, "resume redeployed an unchanged Worker");
    assert.equal(c.m.sendingSubs.length, 1);
    assert.ok(c.m.admins["admin@acme-mail.test"]);
  });

  test("RESUME: a failed deploy leaves state that the re-run completes, not refuses", async () => {
    const c = setup();
    c.m.wranglerFaults.push({ re: /^deploy -c/, times: 1 });
    await assert.rejects(install(c.deps, c.opts), /deploying the Worker failed/);
    assert.equal(c.m.d1.length, 1);
    await install(c.deps, c.opts);
    assert.ok(c.m.scripts.postern.live);
    assert.equal(c.m.d1.length, 1);
  });

  test("RESUME: a slow certificate stops at the admin step, and the re-run creates the admin once", async () => {
    const c = setup();
    const realHttp = c.deps.http;
    let down = true;
    c.deps.http = async (url, init) => {
      if (down) throw new Error("tls handshake failed");
      return realHttp(url, init);
    };
    await assert.rejects(install(c.deps, c.opts), /did not answer yet/);
    down = false;
    await install(c.deps, c.opts);
    assert.ok(c.m.admins["admin@acme-mail.test"]);
    const posts = c.m.requests.filter((r) => r.path.endsWith("/api/admin/users"));
    assert.equal(posts.length, 1);
  });

  test("--dry-run changes nothing and lists what it would do", async () => {
    const c = setup({ args: ["--dry-run"] });
    const res = await install(c.deps, c.opts);
    assert.equal(writes(c.m).length, 0);
    assert.equal(wranglerWrites(c.m).length, 0);
    assert.ok(res.changes.length >= 6);
    assert.ok(res.changes.every((x) => x[0] === "would"));
  });

  test("--var persists into the deployed config and survives a later run without it", async () => {
    const c = setup({ args: ["--var", "FORWARD_TO=me@elsewhere.example"] });
    await install(c.deps, c.opts);
    assert.equal(c.m.scripts.postern.vars.FORWARD_TO, "me@elsewhere.example");
    const again = { ...c.opts, vars: {} };
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 3 };\n");
    await install(c.deps, again);
    assert.equal(c.m.scripts.postern.vars.FORWARD_TO, "me@elsewhere.example", "an upgrade dropped an operator var");
  });
});

describe("refusals: each is named, and none of them writes anything", () => {
  test("missing token permission names the permission", async () => {
    for (const [perm, label] of [["dns", "DNS Edit"], ["routing", "Email Routing Rules Edit"], ["settings", "Zone Settings Edit"], ["sending", "Email Sending Edit"], ["workers", "Workers Scripts Edit"], ["d1", "D1 Edit"], ["r2", "Workers R2 Storage Edit"]]) {
      const c = setup();
      c.m.denied.add(perm);
      await expectRefusal(c, new RegExp(`lacks the "[^"]*${label}" permission`));
    }
  });

  test("a zone the token cannot see", async () => {
    const c = setup();
    c.m.denied.add("zone");
    await expectRefusal(c, /Zone Read/);
    const d = setup();
    d.m.zone.name = "other.example";
    await expectRefusal(d, /no zone named acme-mail\.test is visible to this token/);
  });

  test("a domain whose MX points at another mail host", async () => {
    const c = setup();
    c.m.dns.push({ id: "x", type: "MX", name: "acme-mail.test", content: "aspmx.l.google.com", priority: 1 });
    await expectRefusal(c, /already receives mail elsewhere: MX aspmx\.l\.google\.com/);
  });

  test("an Email Routing rule that forwards an address away from the Worker", async () => {
    const c = setup();
    c.m.routing.enabled = true;
    c.m.rules.push({ id: "r1", name: "boss", enabled: true, matchers: [{ type: "literal", field: "to", value: "boss@acme-mail.test" }], actions: [{ type: "forward", value: ["boss@gmail.example"] }] });
    await expectRefusal(c, /rule "boss" sends boss@acme-mail\.test to forward boss@gmail\.example/);
  });

  test("a catch-all that already goes somewhere else", async () => {
    const c = setup();
    c.m.routing.enabled = true;
    c.m.catchAll = { id: "ca", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["someone-elses-worker"] }] };
    await expectRefusal(c, /catch-all Email Routing rule already sends mail to worker someone-elses-worker/);
  });

  test("an SPF record that would need a hand merge", async () => {
    const c = setup();
    c.m.dns.push({ id: "s", type: "TXT", name: "acme-mail.test", content: "v=spf1 include:_spf.google.com ~all" });
    await expectRefusal(c, /already has an SPF record that does not include Cloudflare/);
  });

  test("a web hostname already in use", async () => {
    const c = setup();
    c.m.dns.push({ id: "h", type: "A", name: "mail.acme-mail.test", content: "192.0.2.1" });
    await expectRefusal(c, /mail\.acme-mail\.test already has a DNS record \(A\)/);
  });

  test("a same-named Worker, D1 or bucket this installer did not create, unless --adopt", async () => {
    const c = setup();
    c.m.scripts.postern = { versions: ["v0"], secrets: new Map(), live: "v0", vars: {} };
    c.m.d1.push({ uuid: "d1-old", name: "postern" });
    await expectRefusal(c, /already has a Worker named "postern", a D1 database named "postern".*--adopt/s);
    c.opts.adopt = true;
    await install(c.deps, c.opts);
    assert.equal(c.m.d1.length, 1, "--adopt should reuse the existing D1");
    assert.ok(c.m.migrations["d1-old"], "--adopt should migrate the existing D1");
  });

  test("several unsafe states are reported together, not one per run", async () => {
    const c = setup();
    c.m.dns.push({ id: "x", type: "MX", name: "acme-mail.test", content: "mx.other.example", priority: 1 });
    c.m.dns.push({ id: "h", type: "CNAME", name: "mail.acme-mail.test", content: "elsewhere.example" });
    await assert.rejects(install(c.deps, c.opts), (e) => e instanceof Refused && e.reasons.length === 2);
  });

  test("a Sending DKIM record that collides is refused at that record, nothing overwritten", async () => {
    const c = setup();
    c.m.sendingAutoDns = false;
    c.m.dns.push({ id: "k", type: "TXT", name: "cf-bounce._domainkey.acme-mail.test", content: "v=DKIM1; p=SOMEONEELSE" });
    await assert.rejects(install(c.deps, c.opts), /a different DKIM key already sits at cf-bounce\._domainkey\.acme-mail\.test/);
    assert.equal(c.m.dns.filter((r) => r.name === "cf-bounce._domainkey.acme-mail.test").length, 1);
  });

  test("with Cloudflare auto-adding records on Sending enable, nothing is duplicated and --dmarc still wins", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const byName = (n) => c.m.dns.filter((r) => r.name === n);
    assert.equal(byName("cf-bounce._domainkey.acme-mail.test").length, 1);
    assert.equal(byName("cf-bounce.acme-mail.test").filter((r) => r.type === "TXT").length, 1);
    assert.deepEqual(byName("_dmarc.acme-mail.test").map((r) => r.content), ["v=DMARC1; p=none"]);
  });

  test("records the Sending API wants but did not auto-add are created by the installer", async () => {
    const c = setup();
    c.m.sendingAutoDns = false;
    await install(c.deps, c.opts);
    assert.ok(c.m.dns.some((r) => r.name === "cf-bounce._domainkey.acme-mail.test" && r.comment === "postern installer"));
  });

  test("a DKIM key stored as chunked TXT matches the same key reported as one string", async () => {
    const c = setup();
    c.m.sendingAutoDns = false;
    // The real zone shape: auto-created by Email Sending, chunked at 255 bytes.
    c.m.sendingDns[0] = { type: "TXT", name: "cf-bounce._domainkey.acme-mail.test", content: '"v=DKIM1; h=sha256; k=rsa; p=AAAABBBBCCCCDDDD"' };
    c.m.dns.push({ id: "k", type: "TXT", name: "cf-bounce._domainkey.acme-mail.test", content: '"v=DKIM1; h=sha256; k=rsa; p=AAAABBBB" "CCCCDDDD"' });
    await install(c.deps, c.opts);
    assert.equal(c.m.dns.filter((r) => r.name === "cf-bounce._domainkey.acme-mail.test").length, 1);
    assert.match(c.out.join("\n"), /= unchanged DNS TXT cf-bounce\._domainkey\.acme-mail\.test/);
  });

  test("DMARC follows --dmarc, not the Sending API's p=reject", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    assert.deepEqual(c.m.dns.filter((r) => r.name === "_dmarc.acme-mail.test").map((r) => r.content), ["v=DMARC1; p=none"]);
    assert.match(c.out.join("\n"), /recommends p=reject/);
    const d = setup({ args: ["--dmarc", "reject"] });
    await install(d.deps, d.opts);
    assert.deepEqual(d.m.dns.filter((r) => r.name === "_dmarc.acme-mail.test").map((r) => r.content), ["v=DMARC1; p=reject"]);
  });

  test("an existing DMARC policy is kept, not replaced", async () => {
    const c = setup();
    c.m.dns.push({ id: "d", type: "TXT", name: "_dmarc.acme-mail.test", content: "v=DMARC1; p=reject; rua=mailto:x@acme-mail.test" });
    await install(c.deps, c.opts);
    assert.deepEqual(c.m.dns.filter((r) => r.name === "_dmarc.acme-mail.test").map((r) => r.content), ["v=DMARC1; p=reject; rua=mailto:x@acme-mail.test"]);
    assert.match(c.out.join("\n"), /- kept      DNS TXT _dmarc\.acme-mail\.test/);
  });
});

describe("upgrade and rollback", () => {
  async function installed() {
    const c = setup();
    await install(c.deps, c.opts);
    c.out.length = 0;
    return c;
  }

  test("upgrade refuses when nothing is installed", async () => {
    const c = setup();
    await assert.rejects(install(c.deps, c.opts, "upgrade"), (e) => e instanceof Refused && /run install first/.test(e.message));
    assert.equal(writes(c.m).length, 0);
  });

  test("upgrade applies only the new migration, redeploys, and records how to go back", async () => {
    const c = await installed();
    const db = c.m.d1[0].uuid;
    const before = c.m.migrations[db].length;
    const oldVersion = c.m.scripts.postern.live;
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_new_index.sql"), "CREATE INDEX IF NOT EXISTS idx_x ON messages(id);\n");
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 2 };\n");
    await install(c.deps, c.opts, "upgrade");
    assert.equal(c.m.migrations[db].length, before + 1);
    assert.equal(c.m.migrations[db].at(-1), "0099_new_index.sql");
    assert.notEqual(c.m.scripts.postern.live, oldVersion);
    const st = JSON.parse(readFileSync(join(c.opts.stateDir, "postern.acme-mail.test.json"), "utf8"));
    assert.equal(st.history.at(-1).fromVersionId, oldVersion);
    assert.equal(st.history.at(-1).d1Bookmark, `bookmark-${before}`);
    // and a second upgrade on the same tree is a no-op
    const w = writes(c.m).length;
    await install(c.deps, c.opts, "upgrade");
    assert.equal(writes(c.m).length, w);
  });

  test("upgrade refuses a destructive migration against a store that holds mail", async () => {
    const c = await installed();
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_drop.sql"), "DROP TABLE messages;\n");
    const deploys = wranglerWrites(c.m).length;
    await assert.rejects(install(c.deps, c.opts, "upgrade"), /not additive/);
    assert.equal(wranglerWrites(c.m).length, deploys, "a destructive migration was applied or the Worker redeployed");
  });

  test("rollback puts the previous Worker version back; D1 only with --restore-db", async () => {
    const c = await installed();
    const oldVersion = c.m.scripts.postern.live;
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_new_index.sql"), "CREATE INDEX IF NOT EXISTS idx_x ON messages(id);\n");
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 2 };\n");
    await install(c.deps, c.opts, "upgrade");
    await rollback(c.deps, { ...c.opts, restoreDb: false });
    assert.equal(c.m.scripts.postern.live, oldVersion);
    assert.equal(c.m.restores.length, 0, "rollback without --restore-db touched D1");
    await assert.rejects(rollback(c.deps, c.opts), (e) => e instanceof Refused && /nothing to roll back/.test(e.message));
  });

  test("rollback never writes to Email Routing or DNS (disabling Routing deletes the zone's MX, SPF and DKIM)", async () => {
    const c = await installed();
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_new_index.sql"), "CREATE INDEX IF NOT EXISTS idx_x ON messages(id);\n");
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 2 };\n");
    await install(c.deps, c.opts, "upgrade");
    const before = c.m.requests.length;
    const dns = JSON.stringify(c.m.dns);
    await rollback(c.deps, { ...c.opts, restoreDb: true });
    const touched = c.m.requests.slice(before).filter((r) => r.method !== "GET" && /\/email\/routing|\/dns_records/.test(r.path));
    assert.deepEqual(touched, [], `rollback wrote to Routing or DNS: ${JSON.stringify(touched.map((r) => r.method + " " + r.path))}`);
    assert.equal(JSON.stringify(c.m.dns), dns);
    assert.equal(c.m.routing.enabled, true);
  });

  test("rollback --restore-db restores D1 to the bookmark taken before the upgrade", async () => {
    const c = await installed();
    const before = c.m.migrations[c.m.d1[0].uuid].length;
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_new_index.sql"), "CREATE INDEX IF NOT EXISTS idx_x ON messages(id);\n");
    await install(c.deps, c.opts, "upgrade");
    await rollback(c.deps, { ...c.opts, restoreDb: true });
    assert.deepEqual(c.m.restores, [{ db: "postern", bookmark: `bookmark-${before}` }]);
  });
});

describe("CLI arguments", () => {
  test("defaults and validation", () => {
    const o = parseArgs(["install", "--domain", "Acme-Mail.test"]);
    assert.equal(o.hostname, "mail.acme-mail.test");
    assert.equal(o.admin, "admin@acme-mail.test");
    assert.equal(o.bucket, "postern-attachments");
    assert.throws(() => parseArgs(["install"]), /--domain is required/);
    assert.throws(() => parseArgs(["frobnicate", "--domain", "acme-mail.test"]), /unknown command/);
    assert.throws(() => parseArgs(["install", "--domain", "acme-mail.test", "--hostname", "mail.other.com"]), /inside --domain/);
    assert.throws(() => parseArgs(["install", "--domain", "acme-mail.test", "--admin", "a@other.com"]), /address on --domain/);
    assert.throws(() => parseArgs(["install", "--domain", "acme-mail.test", "--var", "lower=x"]), /KEY=VALUE/);
  });
});

describe("lead rulings: placeholder defaults, prefix, status, AUTH seam", () => {
  test("a documentation placeholder domain is refused before any API call", async () => {
    for (const d of ["example.com", "mail.example.org", "corp.example", "x.invalid"]) {
      const c = setup();
      c.opts.domain = d;
      c.opts.hostname = `mail.${d}`;
      c.opts.admin = `admin@${d}`;
      await assert.rejects(install(c.deps, c.opts), (e) => e instanceof Refused && /documentation placeholder/.test(e.message));
      assert.equal(c.m.requests.length, 0, `${d}: a placeholder refusal still called the API`);
    }
  });

  test("a --var that moves the sending domain off --domain is refused", async () => {
    const c = setup({ args: ["--var", "ALLOWED_FROM_DOMAIN=example.com"] });
    await expectRefusal(c, /ALLOWED_FROM_DOMAIN=example\.com differs from --domain acme-mail\.test/);
    const d = setup({ args: ["--var", "DEFAULT_FROM=noreply@example.com"] });
    await expectRefusal(d, /DEFAULT_FROM=noreply@example\.com is not an address on acme-mail\.test/);
  });

  test("--prefix names every account resource, and nothing unprefixed is created", async () => {
    const c = setup({ args: ["--prefix", "pt1110-test-"] });
    await install(c.deps, c.opts);
    assert.deepEqual(Object.keys(c.m.scripts), ["pt1110-test-postern"]);
    assert.deepEqual(c.m.d1.map((d) => d.name), ["pt1110-test-postern"]);
    assert.deepEqual(c.m.r2.map((b) => b.name), ["pt1110-test-postern-attachments"]);
    assert.deepEqual(c.m.catchAll.actions, [{ type: "worker", value: ["pt1110-test-postern"] }]);
    for (const r of writes(c.m).filter((r) => r.path.startsWith("/accounts/"))) {
      const named = r.body?.name ?? "";
      assert.ok(!named || named.startsWith("pt1110-test-"), `unprefixed account write: ${r.method} ${r.path} ${named}`);
    }
  });

  test("status is read-only on a fresh account and on an installed one", async () => {
    const c = setup();
    const st = parseArgs(["status", "--domain", "acme-mail.test", "--state-dir", c.opts.stateDir]);
    await install(c.deps, st);
    assert.equal(writes(c.m).length, 0);
    await install(c.deps, c.opts);
    const w = writes(c.m).length;
    const wr = wranglerWrites(c.m).length;
    await install(c.deps, st);
    assert.equal(writes(c.m).length, w);
    assert.equal(wranglerWrites(c.m).length, wr);
  });

  test("first admin goes through POST /api/admin/users (#810): password only, no smtp-credentials", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const calls = c.m.requests.filter((r) => r.path.startsWith("https://") && r.path.includes("/api/admin/"));
    assert.deepEqual(calls.map((r) => r.path), ["https://mail.acme-mail.test/api/admin/users"]);
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(Object.keys(body).sort(), ["from", "password", "username"]);
  });

  test("409 E_CONFLICT is done: recorded, reported as kept, the password is not claimed as changed", async () => {
    const c = setup();
    c.m.admins["admin@acme-mail.test"] = "set-by-someone-else";
    await install(c.deps, c.opts);
    assert.equal(c.m.admins["admin@acme-mail.test"], "set-by-someone-else", "the installer overwrote an existing user");
    assert.match(c.out.join("\n"), /- kept      first admin admin@acme-mail\.test already exists; its password was not changed/);
    const st = JSON.parse(readFileSync(join(c.opts.stateDir, "postern.acme-mail.test.json"), "utf8"));
    assert.equal(st.admin, "admin@acme-mail.test");
  });

  test("a run that dies after the 201 resumes to 409 and the stored password is the real one", async () => {
    const c = setup();
    const real = c.deps.http;
    c.deps.http = async (url, init) => {
      const r = await real(url, init);
      if (url.endsWith("/api/admin/users")) throw new Error("socket hang up");
      return r;
    };
    await assert.rejects(install(c.deps, c.opts), /socket hang up/);
    c.deps.http = real;
    await install(c.deps, c.opts);
    const body = readFileSync(join(c.opts.stateDir, "postern.acme-mail.test.credentials.env"), "utf8");
    assert.equal(/^POSTERN_ADMIN_PASSWORD=(.*)$/m.exec(body)[1], c.m.admins["admin@acme-mail.test"]);
  });

  test("a Worker without the user API stops with a named reason", async () => {
    const c = setup();
    const real = c.deps.http;
    c.deps.http = async (url, init) => (url.endsWith("/api/admin/users") ? { ok: false, status: 404, json: async () => ({ ok: false }) } : real(url, init));
    await assert.rejects(install(c.deps, c.opts), /has no user API \(POST \/api\/admin\/users answered 404\)/);
  });

  test("a host this machine cannot resolve yet is named as a DNS cache, not a dead Worker", async () => {
    const c = setup();
    const real = c.deps.http;
    c.deps.http = async (url, init) => {
      if (url.endsWith("/health")) { const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; }
      return real(url, init);
    };
    await assert.rejects(install(c.deps, c.opts), /cannot resolve mail\.acme-mail\.test yet \(ENOTFOUND\).*negative TTL/s);
  });
});

describe("D-AUTH-3: unset WEBMAIL_AUTH_BACKEND means OFF", () => {
  test("a new install writes WEBMAIL_AUTH_BACKEND=native explicitly", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    assert.equal(c.m.scripts.postern.vars.WEBMAIL_AUTH_BACKEND, "native");
  });

  test("upgrade over a Worker whose config has no WEBMAIL_AUTH_BACKEND leaves it absent", async () => {
    const c = setup();
    c.m.scripts.postern = { versions: ["v0"], secrets: new Map([["POSTERN_API_TOKEN", "old"]]), live: "v0", vars: { ALLOWED_FROM_DOMAIN: "acme-mail.test" } };
    c.m.d1.push({ uuid: "d1-old", name: "postern" });
    c.m.migrations["d1-old"] = [];
    c.opts.adopt = true;
    await install(c.deps, c.opts).catch(() => {}); // the admin step may stop; vars are what this asserts
    assert.ok(!("WEBMAIL_AUTH_BACKEND" in c.m.scripts.postern.vars), "an adopted install gained native sign-in");
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 9 };\n");
    await install(c.deps, c.opts, "upgrade").catch(() => {});
    assert.ok(!("WEBMAIL_AUTH_BACKEND" in c.m.scripts.postern.vars), "upgrade added WEBMAIL_AUTH_BACKEND");
  });

  test("an operator's explicit value is kept across adopt and upgrade", async () => {
    const c = setup();
    c.m.scripts.postern = { versions: ["v0"], secrets: new Map([["POSTERN_API_TOKEN", "old"]]), live: "v0", vars: { WEBMAIL_AUTH_BACKEND: "off" } };
    c.opts.adopt = true;
    await install(c.deps, c.opts).catch(() => {});
    assert.equal(c.m.scripts.postern.vars.WEBMAIL_AUTH_BACKEND, "off");
  });

  test("upgrade of an install made by this installer keeps native, and never re-adds a removed one", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const p = join(c.opts.stateDir, "postern.acme-mail.test.json");
    const st = JSON.parse(readFileSync(p, "utf8"));
    delete st.vars.WEBMAIL_AUTH_BACKEND; // the operator turned it back to default (off)
    writeFileSync(p, JSON.stringify(st));
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 8 };\n");
    await install(c.deps, c.opts, "upgrade");
    assert.ok(!("WEBMAIL_AUTH_BACKEND" in c.m.scripts.postern.vars));
  });
});

describe("#740 S2: unset AGENT_READ_SCOPE means estate; a new install writes granted", () => {
  test("a new install writes AGENT_READ_SCOPE=granted explicitly", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    assert.equal(c.m.scripts.postern.vars.AGENT_READ_SCOPE, "granted");
  });

  test("adopt and upgrade over a Worker with no AGENT_READ_SCOPE leave it absent (estate)", async () => {
    const c = setup();
    c.m.scripts.postern = { versions: ["v0"], secrets: new Map([["POSTERN_API_TOKEN", "old"]]), live: "v0", vars: { ALLOWED_FROM_DOMAIN: "acme-mail.test" } };
    c.m.d1.push({ uuid: "d1-old", name: "postern" });
    c.m.migrations["d1-old"] = [];
    c.opts.adopt = true;
    await install(c.deps, c.opts).catch(() => {}); // the admin step may stop; vars are what this asserts
    assert.ok(!("AGENT_READ_SCOPE" in c.m.scripts.postern.vars), "an adopted install narrowed agent reads");
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 9 };\n");
    await install(c.deps, c.opts, "upgrade").catch(() => {});
    assert.ok(!("AGENT_READ_SCOPE" in c.m.scripts.postern.vars), "upgrade added AGENT_READ_SCOPE");
  });

  test("an operator's explicit estate is kept across adopt", async () => {
    const c = setup();
    c.m.scripts.postern = { versions: ["v0"], secrets: new Map([["POSTERN_API_TOKEN", "old"]]), live: "v0", vars: { AGENT_READ_SCOPE: "estate" } };
    c.opts.adopt = true;
    await install(c.deps, c.opts).catch(() => {});
    assert.equal(c.m.scripts.postern.vars.AGENT_READ_SCOPE, "estate");
  });
});

describe("rollback --restore-db and the first admin", () => {
  test("an admin created after the bookmark is re-created by the next run after a restore", async () => {
    const c = setup();
    c.m.dns.length = 0;
    // Install with the admin step failing, so the admin is created during the upgrade.
    const real = c.deps.http;
    c.deps.http = async (url, init) => (url.endsWith("/api/admin/users") ? { ok: false, status: 503, json: async () => ({ ok: false, error: "E_UNAVAILABLE" }) } : real(url, init));
    await assert.rejects(install(c.deps, c.opts));
    c.deps.http = real;
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_new_index.sql"), "CREATE INDEX IF NOT EXISTS idx_x ON messages(id);\n");
    writeFileSync(join(c.repoRoot, "inbound", "src", "index.ts"), "export default { v: 5 };\n");
    await install(c.deps, c.opts, "upgrade");
    assert.ok(c.m.admins["admin@acme-mail.test"]);
    await rollback(c.deps, { ...c.opts, restoreDb: true });
    delete c.m.admins["admin@acme-mail.test"]; // what the D1 restore does to the users table
    const st = JSON.parse(readFileSync(join(c.opts.stateDir, "postern.acme-mail.test.json"), "utf8"));
    assert.equal(st.admin, undefined, "state still claims an admin the restore removed");
    await install(c.deps, c.opts);
    assert.ok(c.m.admins["admin@acme-mail.test"], "the next run did not re-create the admin");
  });
});

describe("upgrade record survives a failed upgrade", () => {
  test("the D1 bookmark is saved before the migration, even when the run stops later", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    writeFileSync(join(c.repoRoot, "inbound", "migrations", "0099_new_index.sql"), "CREATE INDEX IF NOT EXISTS idx_x ON messages(id);\n");
    c.m.faults.push({ method: "POST", re: /\/email\/sending\/subdomains$/, times: 1 });
    c.m.sendingSubs.length = 0; // force the Sending step to write, so the fault fires after the migration
    await assert.rejects(install(c.deps, c.opts, "upgrade"));
    const st = JSON.parse(readFileSync(join(c.opts.stateDir, "postern.acme-mail.test.json"), "utf8"));
    assert.ok(st.history.at(-1)?.d1Bookmark, "a failed upgrade lost its D1 bookmark");
    assert.equal(st.history.at(-1).complete, false);
  });
});
