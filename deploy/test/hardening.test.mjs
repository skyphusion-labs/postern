// hardening.test.mjs -- installer input validation, the per-install lock, and the cleanup of a
// temporary secrets file an interrupted run left behind. Against the fake Cloudflare.
// Run: node --test deploy/test/*.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cfClient } from "../lib/cf.mjs";
import { Refused, install, takeLock } from "../lib/installer.mjs";
import { parseArgs, plainHostname } from "../postern.mjs";
import { TOKEN, fakeExec, fakeFetch, fakeHttp, makeFixtureRepo, newAccount } from "./fake-cloudflare.mjs";

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "postern-hardening-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function setup() {
  const dir = join(scratch, `case-${++n}`);
  const repoRoot = makeFixtureRepo(REAL_ROOT, join(dir, "repo"));
  const m = newAccount();
  const out = [];
  let seq = 0;
  const deps = {
    cf: cfClient({ token: TOKEN, fetch: fakeFetch(m) }), token: TOKEN, exec: fakeExec(m), http: fakeHttp(m),
    sleep: async () => {}, log: (s) => out.push(s), repoRoot, appVersion: "1.8.0", healthTries: 2, healthDelayMs: 0,
    randomSecret: () => `generated-secret-${++seq}-0123456789abcdef0123456789abcdef`,
  };
  const stateDir = join(dir, "state");
  const opts = (...extra) => parseArgs(["install", "--domain", "acme-mail.test", "--state-dir", stateDir, ...extra]);
  return { m, deps, opts, out, stateDir };
}
const writes = (m) => m.requests.filter((r) => r.method !== "GET" && !/\/d1\/database\/[^/]+\/query$/.test(r.path));
const args = (...a) => ["install", "--domain", "acme-mail.test", ...a];

describe("--hostname and --domain are plain hostnames", () => {
  for (const bad of ["a/.acme-mail.test", "a#.acme-mail.test", "a?.acme-mail.test", "u@a.acme-mail.test",
    "a.acme-mail.test:8443", "-a.acme-mail.test", "a-.acme-mail.test", "a..acme-mail.test", "a_b.acme-mail.test",
    "a b.acme-mail.test", "a\\.acme-mail.test", ".acme-mail.test", `${"x".repeat(64)}.acme-mail.test`]) {
    test(`refuses --hostname ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseArgs(args("--hostname", bad)), /--hostname must be a plain hostname/);
    });
  }
  for (const good of ["mail.acme-mail.test", "acme-mail.test", "a-b.c.acme-mail.test", "xn--bcher-kva.acme-mail.test"]) {
    test(`accepts --hostname ${good}`, () => {
      assert.equal(parseArgs(args("--hostname", good)).hostname, good);
    });
  }
  test("refuses a --domain with an empty or dash-edged label", () => {
    for (const d of ["acme..test", "-acme.test", "acme-.test"]) {
      assert.throws(() => parseArgs(["install", "--domain", d]), /--domain must be a plain domain name|--domain is required/);
    }
  });
  test("control: plainHostname is the gate, and a URL-shaped value never parses to another host", () => {
    assert.equal(plainHostname("other.example/.acme-mail.test"), false);
    assert.equal(new URL("https://other.example/.acme-mail.test").host, "other.example", "positive control: the shape the check exists for");
    assert.equal(plainHostname("mail.acme-mail.test"), true);
  });
});

describe("one run at a time per install", () => {
  test("a held lock refuses the second run before any write", async () => {
    const c = setup();
    const release = takeLock(c.opts());
    try {
      await assert.rejects(install(c.deps, c.opts()), (e) => e instanceof Refused && /another postern run \(PID \d+\) is working on this install/.test(e.message));
      assert.equal(writes(c.m).length, 0);
    } finally { release(); }
    await install(c.deps, c.opts());
    assert.ok(!existsSync(join(c.stateDir, "postern.acme-mail.test.lock")), "a finished run left its lock");
  });

  test("a stale lock (its process is gone) is taken over, and said so", async () => {
    const c = setup();
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(c.stateDir, "postern.acme-mail.test.lock"), "2147483646\n");
    await install(c.deps, c.opts());
    assert.match(c.out.join("\n"), /removed a stale lock from an earlier run that did not finish \(PID 2147483646\)/);
    assert.ok(!existsSync(join(c.stateDir, "postern.acme-mail.test.lock")));
  });

  test("a failed run releases its lock", async () => {
    const c = setup();
    c.m.wranglerFaults.push({ re: /^deploy/, times: 1 });
    await assert.rejects(install(c.deps, c.opts()));
    assert.ok(!existsSync(join(c.stateDir, "postern.acme-mail.test.lock")));
  });

  test("a dry run takes no lock, so status works while an install runs", async () => {
    const c = setup();
    const release = takeLock(c.opts());
    try { await install(c.deps, c.opts("--dry-run")); } finally { release(); }
  });

  test("locks are per install: another --name in the same state dir is not blocked", async () => {
    const c = setup();
    const release = takeLock(c.opts());
    try { await install(c.deps, c.opts("--name", "other")); } finally { release(); }
  });
});

describe("a temporary secrets file left by an interrupted run is removed", () => {
  test("this install's leftover is removed before the next deploy writes its own", async () => {
    const c = setup();
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    const left = ".postern.acme-mail.test.secrets-0123456789abcdef01234567.json";
    writeFileSync(join(c.stateDir, left), "{}", { mode: 0o600 });
    await install(c.deps, c.opts());
    assert.ok(!existsSync(join(c.stateDir, left)));
    assert.match(c.out.join("\n"), new RegExp(`removed \\${left}, a temporary secrets file`));
    assert.deepEqual(readdirSync(c.stateDir).filter((f) => /secrets-/.test(f)), [], "the run left a secrets file of its own");
  });

  test("another install's file is never touched; an old-format file only when over an hour old", async () => {
    const c = setup();
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    const other = ".other.acme-mail.test.secrets-0123456789abcdef01234567.json";
    const young = ".secrets-aaaaaaaaaaaaaaaaaaaaaaaa.json";
    const old = ".secrets-bbbbbbbbbbbbbbbbbbbbbbbb.json";
    for (const f of [other, young, old]) writeFileSync(join(c.stateDir, f), "{}", { mode: 0o600 });
    const t = (Date.now() - 2 * 3600e3) / 1000;
    utimesSync(join(c.stateDir, old), t, t);
    await install(c.deps, c.opts());
    assert.ok(existsSync(join(c.stateDir, other)), "removed another install's file");
    assert.ok(existsSync(join(c.stateDir, young)), "removed a recent old-format file");
    assert.ok(!existsSync(join(c.stateDir, old)), "kept an hour-old old-format file");
  });
});

describe("stale-lock takeover does not race", () => {
  test("a takeover that finds a LIVE lock swapped in puts it back and refuses", () => {
    // The interleaving: this run judged the lock stale (a dead PID), and before its rename a
    // live run replaced the file with its own lock (this process's PID stands in for it).
    const c = setup();
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    const lock = join(c.stateDir, "postern.acme-mail.test.lock");
    writeFileSync(lock, "2147483646\n");
    const realKill = process.kill;
    let swapped = false;
    process.kill = (pid, sig) => {
      if (pid === 2147483646 && !swapped) {
        swapped = true;
        writeFileSync(lock, `${process.pid}\n`);
        const e = new Error("ESRCH");
        e.code = "ESRCH";
        throw e;
      }
      return realKill.call(process, pid, sig);
    };
    try {
      assert.throws(() => takeLock(c.opts()), (e) => e instanceof Refused && /took the lock .* a moment ago/.test(e.message));
    } finally {
      process.kill = realKill;
    }
    assert.ok(swapped, "positive control: the swap happened");
    assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`, "the live lock was not put back");
    assert.deepEqual(readdirSync(c.stateDir).filter((f) => /\.stale-/.test(f)), [], "a moved lock was left behind");
  });
});

describe("POSTERN_TEST_PBKDF2_ITERATIONS cannot ship (#909)", () => {
  const VAR = "POSTERN_TEST_PBKDF2_ITERATIONS";
  const PLANTED = "WEAK-ITER-77";

  test("control: a clean install deploys without the test-only override", async () => {
    const c = setup();
    await install(c.deps, c.opts());
    assert.ok(c.m.scripts.postern.live, "clean install did not deploy");
    assert.ok(!(VAR in (c.m.scripts.postern.vars || {})), "clean install shipped the var");
    assert.ok(!c.m.scripts.postern.secrets.has(VAR), "clean install shipped the secret");
  });

  test("a planted --var is refused before any write, naming the variable, not the value", async () => {
    const c = setup();
    const opts = c.opts("--var", `${VAR}=${PLANTED}`);
    await assert.rejects(install(c.deps, opts), (e) => {
      assert.ok(e instanceof Refused, `expected a refusal, got: ${e.message}`);
      assert.match(e.message, /POSTERN_TEST_PBKDF2_ITERATIONS is set in the wrangler config vars/);
      assert.equal(e.message.includes(PLANTED), false, "the planted value reached the refusal");
      return true;
    });
    assert.equal(writes(c.m).length, 0, "a planted var still wrote");
    assert.equal(c.m.wranglerCalls.filter((x) => !x.includes("--dry-run")).length, 0);
  });

  test("a planted template var is refused (the rendered config, not just --var)", async () => {
    const c = setup();
    const wrangler = join(c.deps.repoRoot, "inbound", "wrangler.jsonc");
    const text = readFileSync(wrangler, "utf8");
    writeFileSync(wrangler, text.replace('"vars": {', `"vars": {\n    "${VAR}": "${PLANTED}",`));
    await assert.rejects(install(c.deps, c.opts()), (e) => {
      assert.ok(e instanceof Refused);
      assert.match(e.message, /POSTERN_TEST_PBKDF2_ITERATIONS is set in the wrangler config vars/);
      assert.equal(e.message.includes(PLANTED), false, "the planted value reached the refusal");
      return true;
    });
    assert.equal(writes(c.m).length, 0, "a planted template var still wrote");
  });

  test("a planted Worker secret is refused on the next run, with no further write", async () => {
    const c = setup();
    await install(c.deps, c.opts());
    const before = {
      api: writes(c.m).length,
      wr: c.m.wranglerCalls.filter((x) => !x.includes("--dry-run")).length,
    };
    c.m.scripts.postern.secrets.set(VAR, PLANTED);
    await assert.rejects(install(c.deps, c.opts()), (e) => {
      assert.ok(e instanceof Refused);
      assert.match(e.message, /POSTERN_TEST_PBKDF2_ITERATIONS is set in the Worker secret list/);
      assert.equal(e.message.includes(PLANTED), false, "the planted value reached the refusal");
      return true;
    });
    assert.equal(writes(c.m).length, before.api, "a planted secret still wrote");
    assert.equal(c.m.wranglerCalls.filter((x) => !x.includes("--dry-run")).length, before.wr);
  });
});
