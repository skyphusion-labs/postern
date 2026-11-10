// uninstall.test.mjs -- `postern uninstall` and output redaction (#831), against the fake.
// Run: node --test deploy/test/*.test.mjs
// Each case asserts on the fake's STATE and request log, not on prose alone.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cfClient } from "../lib/cf.mjs";
import { REDACTED, Refused, install, redactText, uninstall } from "../lib/installer.mjs";
import { parseArgs } from "../postern.mjs";
import { TOKEN, fakeExec, fakeFetch, fakeHttp, makeFixtureRepo, newAccount } from "./fake-cloudflare.mjs";

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "postern-uninstall-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function setup() {
  const dir = join(scratch, `case-${++n}`);
  const repoRoot = makeFixtureRepo(REAL_ROOT, join(dir, "repo"));
  const m = newAccount();
  const out = [];
  let seq = 0;
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
    randomSecret: () => `generated-secret-${++seq}-0123456789abcdef0123456789abcdef`,
  };
  const stateDir = join(dir, "state");
  const opts = (cmd, ...extra) => parseArgs([cmd, "--domain", "acme-mail.test", "--state-dir", stateDir, ...extra]);
  return { m, deps, opts, out, stateDir };
}
async function installed() {
  const c = setup();
  await install(c.deps, c.opts("install"));
  c.m.requests.length = 0;
  c.m.wranglerCalls.length = 0;
  c.out.length = 0;
  return c;
}
const writes = (m) => m.requests.filter((r) => r.method !== "GET");
const routingDns = (m) => m.dns.filter((r) => (r.type === "MX" && r.name === m.domain) || (r.type === "TXT" && r.name === m.domain && /^v=spf1/.test(r.content)));
const text = (c) => c.out.join("\n");

describe("uninstall", () => {
  test("default: removes the Worker, its domain, Sending and the catch-all target; KEEPS mail; never disables Routing", async () => {
    const c = await installed();
    const mxSpfBefore = JSON.stringify(routingDns(c.m));
    assert.ok(routingDns(c.m).length >= 2, "positive control: the install left MX and SPF to protect");
    await uninstall(c.deps, c.opts("uninstall"));
    assert.ok(!c.m.requests.some((r) => /\/email\/routing\/disable/.test(r.path)), "uninstall disabled Email Routing");
    assert.equal(c.m.routing.enabled, true);
    assert.equal(JSON.stringify(routingDns(c.m)), mxSpfBefore, "MX / SPF changed");
    assert.equal(c.m.catchAll.enabled, false);
    assert.deepEqual(c.m.catchAll.actions, [{ type: "drop" }]);
    assert.equal(c.m.scripts.postern, undefined);
    assert.equal(c.m.domains.length, 0);
    assert.equal(c.m.sendingSubs.length, 0);
    assert.equal(c.m.d1.length, 1, "D1 was deleted without --delete-data");
    assert.equal(c.m.r2.length, 1, "R2 was deleted without --delete-data");
    assert.equal((c.m.exports || []).length, 0);
    assert.match(text(c), /Email Routing on acme-mail\.test stays enabled/);
    assert.match(text(c), /your mail is kept/);
  });

  test("the trap, modelled: the fake deletes MX/SPF on disable, so a disable would show here", async () => {
    const c = await installed();
    // Positive control for the fake itself: disabling Routing really does delete them.
    const probe = setup();
    await install(probe.deps, probe.opts("install"));
    await probe.deps.cf.call("disable", "x", "POST", `/zones/${probe.m.zone.id}/email/routing/disable`, {});
    assert.equal(routingDns(probe.m).length, 0, "the fake does not model the deletion");
    await uninstall(c.deps, c.opts("uninstall"));
    assert.ok(routingDns(c.m).length >= 2, "uninstall lost the zone's MX / SPF");
  });

  test("a second run changes nothing", async () => {
    const c = await installed();
    await uninstall(c.deps, c.opts("uninstall"));
    c.m.requests.length = 0;
    await uninstall(c.deps, c.opts("uninstall"));
    assert.equal(writes(c.m).length, 0, `second uninstall wrote: ${JSON.stringify(writes(c.m))}`);
  });

  test("--dry-run writes nothing and lists what it would remove", async () => {
    const c = await installed();
    await uninstall(c.deps, c.opts("uninstall", "--dry-run", "--delete-data", "--confirm-delete", "acme-mail.test"));
    assert.equal(writes(c.m).length, 0);
    assert.equal(c.m.wranglerCalls.length, 0);
    assert.match(text(c), /\? would {5}delete Worker postern/);
    assert.match(text(c), /\? would {5}export D1 postern to .*\.sql, then delete it/);
  });

  test("--delete-data without the typed confirmation is refused and writes nothing", async () => {
    const c = await installed();
    for (const extra of [["--delete-data"], ["--delete-data", "--confirm-delete", "other.test"]]) {
      await assert.rejects(uninstall(c.deps, c.opts("uninstall", ...extra)), (e) => e instanceof Refused && /--confirm-delete acme-mail\.test/.test(e.message));
    }
    assert.equal(writes(c.m).length, 0);
  });

  test("--delete-data --confirm-delete: exports D1 first (mode 600, non-empty), then deletes D1 and R2", async () => {
    const c = await installed();
    await uninstall(c.deps, c.opts("uninstall", "--delete-data", "--confirm-delete", "acme-mail.test"));
    assert.equal(c.m.exports.length, 1);
    // Table by table: every ordinary table, never the FTS5 index or its shadows, never _cf_ or sqlite_.
    assert.deepEqual(c.m.exportTables, ["d1_migrations", "messages", "webmail_sessions"]);
    assert.match(text(c), /not exported: messages_fts, messages_fts_config, messages_fts_data, messages_fts_docsize, messages_fts_idx\./);
    const f = c.m.exports[0];
    assert.ok(statSync(f).size > 0);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const exportAt = c.m.wranglerCalls.findIndex((w) => w.startsWith("d1 export"));
    const deleteAt = c.m.requests.findIndex((r) => r.method === "DELETE" && /\/d1\/database\//.test(r.path));
    assert.ok(exportAt >= 0 && deleteAt >= 0);
    assert.equal(c.m.d1.length, 0);
    assert.equal(c.m.r2.length, 0);
    const state = JSON.parse(readFileSync(join(c.stateDir, "postern.acme-mail.test.json"), "utf8"));
    assert.ok(state.uninstalledAt);
    assert.deepEqual(state.owned, {});
  });

  test("a failed or empty export never deletes D1", async () => {
    const c = await installed();
    c.m.wranglerFaults.push({ re: /^d1 export/, times: 1 });
    await assert.rejects(uninstall(c.deps, c.opts("uninstall", "--delete-data", "--confirm-delete", "acme-mail.test")), /exporting D1 failed, so it was NOT deleted/);
    assert.equal(c.m.d1.length, 1);
    c.m.exportEmpty = true;
    await assert.rejects(uninstall(c.deps, c.opts("uninstall", "--delete-data", "--confirm-delete", "acme-mail.test")), /missing or empty, so D1 was NOT deleted/);
    assert.equal(c.m.d1.length, 1);
  });

  test("a bucket that still holds attachments is kept and named", async () => {
    const c = await installed();
    c.m.r2Objects = { "postern-attachments": 3 };
    await uninstall(c.deps, c.opts("uninstall", "--delete-data", "--confirm-delete", "acme-mail.test"));
    assert.equal(c.m.r2.length, 1);
    assert.match(text(c), /kept {6}R2 bucket postern-attachments: Cloudflare deletes only an empty bucket/);
  });

  test("Email Sending this installer did not enable is left alone", async () => {
    const c = setup();
    c.m.sendingSubs.push({ tag: "theirs", name: "acme-mail.test", enabled: true });
    await install(c.deps, c.opts("install"));
    c.m.requests.length = 0;
    await uninstall(c.deps, c.opts("uninstall"));
    assert.equal(c.m.sendingSubs.length, 1);
    assert.ok(!c.m.requests.some((r) => r.method === "DELETE" && /email\/sending/.test(r.path)));
  });

  test("no recorded install is refused", async () => {
    const c = setup();
    await assert.rejects(uninstall(c.deps, c.opts("uninstall")), (e) => e instanceof Refused && /nothing is recorded/.test(e.message));
    assert.equal(writes(c.m).length, 0);
  });
});

describe("redaction (#831)", () => {
  test("redactText replaces every known value and leaves short strings alone", () => {
    assert.equal(redactText("a TOKEN-12345678 b TOKEN-12345678", ["TOKEN-12345678"]), `a ${REDACTED} b ${REDACTED}`);
    assert.equal(redactText("abc", ["abc"]), "abc");
  });

  test("a wrangler failure that echoes the token and a generated secret prints neither", async () => {
    const c = setup();
    c.m.wranglerFaults.push({ re: /^deploy -c/, times: 1, stderr: `✘ [ERROR] auth ${TOKEN} secrets {"POSTERN_API_TOKEN":"generated-secret-1-0123456789abcdef0123456789abcdef"}` });
    let msg = "";
    await assert.rejects(install(c.deps, c.opts("install")), (e) => { msg = e.message; return true; });
    assert.match(msg, /deploying the Worker failed/);
    assert.ok(!msg.includes(TOKEN), "the Cloudflare token reached the error text");
    assert.ok(!msg.includes("generated-secret-1-"), "a generated secret reached the error text");
    assert.ok(msg.includes(REDACTED));
  });

  test("a log line carrying the token is redacted before it is printed", async () => {
    const c = await installed();
    // The R2 refusal is LOGGED (a "kept" line quoting the API's error text), not thrown.
    c.m.faults.push({ method: "DELETE", re: /\/r2\/buckets\//, times: 1, status: 409, message: `bucket busy, token ${TOKEN}` });
    await uninstall(c.deps, c.opts("uninstall", "--delete-data", "--confirm-delete", "acme-mail.test"));
    assert.match(text(c), /kept {6}R2 bucket postern-attachments: .*bucket busy, token \[redacted\]/, "positive control: the API text reached the log");
    assert.ok(!text(c).includes(TOKEN), "the Cloudflare token reached a printed line");
    assert.ok(existsSync(c.stateDir));
  });
});
