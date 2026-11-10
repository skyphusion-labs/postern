// installer.test.mjs -- the installer against a stubbed Cloudflare account.
// Run: node --test deploy/test/*.test.mjs
//
// No test here talks to a real Cloudflare account. Each case asserts on the
// fake's STATE and its request log, not on the installer's prose.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const opts = parseArgs(["install", "--domain", "example.com", "--state-dir", join(dir, "state"), ...(extra.args || [])]);
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
    assert.equal(m.scripts.postern.vars.ALLOWED_FROM_DOMAIN, "example.com");
    assert.equal(m.scripts.postern.vars.DEFAULT_FROM, "noreply@example.com");
    assert.equal(m.scripts.postern.vars.WEBMAIL_AUTH_BACKEND, "native");
    const applied = m.migrations[m.d1[0].uuid];
    assert.ok(applied.includes("0000_base_schema.sql") && applied.length >= 15, "migrations not applied");
    assert.equal(m.routing.enabled, true);
    assert.deepEqual(m.catchAll.actions, [{ type: "worker", value: ["postern"] }]);
    assert.equal(m.catchAll.enabled, true);
    assert.ok(m.dns.some((r) => r.name === "cf-bounce._domainkey.example.com"), "DKIM record missing");
    assert.ok(m.dns.some((r) => r.name === "_dmarc.example.com" && r.content === "v=DMARC1; p=none"), "DMARC missing");
    assert.equal(m.dns.filter((r) => r.type === "TXT" && r.name === "example.com" && /^v=spf1/.test(r.content)).length, 1, "SPF duplicated");
    assert.ok(m.admins["admin@example.com"], "first admin not created");
    assert.deepEqual(m.domains, [{ hostname: "mail.example.com", service: "postern" }]);

    const text = c.out.join("\n");
    for (const w of ["D1 database postern", "R2 bucket postern-attachments", "Worker postern", "Email Sending for example.com", "Email Routing on example.com", "catch-all rule -> Worker postern", "DNS TXT _dmarc.example.com", "first admin admin@example.com"]) {
      assert.match(text, new RegExp(`[+~] (created|updated)   .*${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `output does not say it created ${w}`);
    }
    assertNoSecretPrinted(null, text);
  });

  test("the credentials file is mode 600 and holds what the installer generated", async () => {
    const c = setup();
    await install(c.deps, c.opts);
    const p = join(c.opts.stateDir, "postern.example.com.credentials.env");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    const body = readFileSync(p, "utf8");
    assert.match(body, /^POSTERN_API_URL=https:\/\/mail\.example\.com$/m);
    const tok = /^POSTERN_API_TOKEN=(.*)$/m.exec(body)[1];
    assert.equal(c.m.scripts.postern.secrets.get("POSTERN_API_TOKEN"), tok);
    const pw = /^POSTERN_ADMIN_PASSWORD=(.*)$/m.exec(body)[1];
    assert.equal(c.m.admins["admin@example.com"], pw);
    assert.ok(!statSync(c.opts.stateDir).isFile());
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
    assert.ok(c.m.admins["admin@example.com"]);
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
    assert.ok(c.m.admins["admin@example.com"]);
    const posts = c.m.requests.filter((r) => r.path.endsWith("/api/admin/smtp-credentials"));
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
    for (const [perm, label] of [["dns", "DNS Edit"], ["routing", "Email Routing Rules Edit"], ["sending", "Email Sending Edit"], ["workers", "Workers Scripts Edit"], ["d1", "D1 Edit"], ["r2", "Workers R2 Storage Edit"]]) {
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
    await expectRefusal(d, /no zone named example\.com is visible to this token/);
  });

  test("a domain whose MX points at another mail host", async () => {
    const c = setup();
    c.m.dns.push({ id: "x", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 });
    await expectRefusal(c, /already receives mail elsewhere: MX aspmx\.l\.google\.com/);
  });

  test("an Email Routing rule that forwards an address away from the Worker", async () => {
    const c = setup();
    c.m.routing.enabled = true;
    c.m.rules.push({ id: "r1", name: "boss", enabled: true, matchers: [{ type: "literal", field: "to", value: "boss@example.com" }], actions: [{ type: "forward", value: ["boss@gmail.example"] }] });
    await expectRefusal(c, /rule "boss" sends boss@example\.com to forward boss@gmail\.example/);
  });

  test("a catch-all that already goes somewhere else", async () => {
    const c = setup();
    c.m.routing.enabled = true;
    c.m.catchAll = { id: "ca", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["someone-elses-worker"] }] };
    await expectRefusal(c, /catch-all Email Routing rule already sends mail to worker someone-elses-worker/);
  });

  test("an SPF record that would need a hand merge", async () => {
    const c = setup();
    c.m.dns.push({ id: "s", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.google.com ~all" });
    await expectRefusal(c, /already has an SPF record that does not include Cloudflare/);
  });

  test("a web hostname already in use", async () => {
    const c = setup();
    c.m.dns.push({ id: "h", type: "A", name: "mail.example.com", content: "192.0.2.1" });
    await expectRefusal(c, /mail\.example\.com already has a DNS record \(A\)/);
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
    c.m.dns.push({ id: "x", type: "MX", name: "example.com", content: "mx.other.example", priority: 1 });
    c.m.dns.push({ id: "h", type: "CNAME", name: "mail.example.com", content: "elsewhere.example" });
    await assert.rejects(install(c.deps, c.opts), (e) => e instanceof Refused && e.reasons.length === 2);
  });

  test("a Sending DKIM record that collides is refused at that record, nothing overwritten", async () => {
    const c = setup();
    c.m.dns.push({ id: "k", type: "TXT", name: "cf-bounce._domainkey.example.com", content: "v=DKIM1; p=SOMEONEELSE" });
    await assert.rejects(install(c.deps, c.opts), /a different DKIM key already sits at cf-bounce\._domainkey\.example\.com/);
    assert.equal(c.m.dns.filter((r) => r.name === "cf-bounce._domainkey.example.com").length, 1);
  });

  test("an existing DMARC policy is kept, not replaced", async () => {
    const c = setup();
    c.m.dns.push({ id: "d", type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=reject; rua=mailto:x@example.com" });
    await install(c.deps, c.opts);
    assert.deepEqual(c.m.dns.filter((r) => r.name === "_dmarc.example.com").map((r) => r.content), ["v=DMARC1; p=reject; rua=mailto:x@example.com"]);
    assert.match(c.out.join("\n"), /- kept      DNS TXT _dmarc\.example\.com/);
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
    const st = JSON.parse(readFileSync(join(c.opts.stateDir, "postern.example.com.json"), "utf8"));
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
    const o = parseArgs(["install", "--domain", "Example.com"]);
    assert.equal(o.hostname, "mail.example.com");
    assert.equal(o.admin, "admin@example.com");
    assert.equal(o.bucket, "postern-attachments");
    assert.throws(() => parseArgs(["install"]), /--domain is required/);
    assert.throws(() => parseArgs(["frobnicate", "--domain", "example.com"]), /unknown command/);
    assert.throws(() => parseArgs(["install", "--domain", "example.com", "--hostname", "mail.other.com"]), /inside --domain/);
    assert.throws(() => parseArgs(["install", "--domain", "example.com", "--admin", "a@other.com"]), /address on --domain/);
    assert.throws(() => parseArgs(["install", "--domain", "example.com", "--var", "lower=x"]), /KEY=VALUE/);
  });
});
