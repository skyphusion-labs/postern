// routing.test.mjs -- the Email Routing reachability report (#802) against the fake account.
// Run: node --test deploy/test/*.test.mjs
// Each case asserts on the report object and the request log (read-only: no writes).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cfClient } from "../lib/cf.mjs";
import { EXIT } from "../lib/installer.mjs";
import { checkRouting, formatRoutingReport } from "../lib/routing.mjs";
import { parseArgs, printRouting } from "../postern.mjs";
import { TOKEN, fakeFetch, newAccount } from "./fake-cloudflare.mjs";

const WORKER = "postern";
const toWorker = (name = WORKER) => [{ type: "worker", value: [name] }];
const literal = (addr) => [{ type: "literal", field: "to", value: addr }];

function zone() {
  const m = newAccount();
  m.routing.enabled = true;
  m.catchAll = { id: "ca", name: "catch-all", enabled: true, matchers: [{ type: "all" }], actions: toWorker() };
  return m;
}
async function run(m) {
  const cf = cfClient({ token: TOKEN, fetch: fakeFetch(m) });
  const out = [];
  const code = await printRouting(cf, parseArgs(["routing", "--domain", m.domain]), (s) => out.push(s));
  const text = out.join("\n");
  assert.ok(!text.includes(TOKEN), "the Cloudflare token was printed");
  assert.equal(m.requests.filter((r) => r.method !== "GET").length, 0, "the report made a write");
  return { code, text, rep: await checkRouting(cfClient({ token: TOKEN, fetch: fakeFetch(m) }), { domain: m.domain, name: WORKER }) };
}

describe("routing reachability report", () => {
  test("a per-address rule that bypasses the Worker is NAMED, and the run exits 1", async () => {
    const m = zone();
    m.rules.push({ id: "r1", name: "boss", enabled: true, matchers: literal("boss@acme-mail.test"), actions: [{ type: "forward", value: ["boss@gmail.example"] }] });
    const { code, text, rep } = await run(m);
    assert.equal(code, EXIT.FAILED);
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.missedAddresses, ["boss@acme-mail.test"]);
    assert.match(text, /MISS rule "boss" boss@acme-mail\.test -> forward boss@gmail\.example/);
    assert.match(text, /rule "boss" sends boss@acme-mail\.test to forward boss@gmail\.example, not to Worker postern/);
  });

  test("a clean zone prints the DENOMINATOR, not a bare OK, and exits 0", async () => {
    const m = zone();
    m.rules.push({ id: "r2", name: "agent", enabled: true, matchers: literal("agent@acme-mail.test"), actions: toWorker() });
    m.rules.push({ id: "r3", name: "old forward", enabled: false, matchers: literal("old@acme-mail.test"), actions: [{ type: "forward", value: ["x@elsewhere.example"] }] });
    const { code, text, rep } = await run(m);
    assert.equal(code, EXIT.OK);
    assert.equal(rep.examined, 3);
    assert.equal(rep.disabled, 1);
    assert.match(text, /3 rule\(s\) examined \(1 disabled, ignored\)/);
    assert.match(text, /result: all 2 enabled rule\(s\) land on Worker postern/);
    assert.match(text, /@event routing \{"ok":true,"examined":3,"disabled":1,"missed":\[\]\}/);
  });

  test("the live shape: the catch-all is in the rule list AND at its own endpoint, counted once", async () => {
    const m = zone();
    const { code, text, rep } = await run(m);
    assert.equal(code, EXIT.OK);
    assert.equal(rep.examined, 1);
    assert.equal(text.match(/catch-all "catch-all"/g).length, 1);
  });

  test("a catch-all to another Worker misses every unmatched address", async () => {
    const m = zone();
    m.catchAll.actions = toWorker("someone-elses-worker");
    const { code, rep } = await run(m);
    assert.equal(code, EXIT.FAILED);
    assert.match(rep.problems.join("\n"), /catch-all "catch-all" sends every unmatched address to worker someone-elses-worker/);
  });

  test("a catch-all that drops mail, or none at all, is reported", async () => {
    const m = zone();
    m.catchAll.actions = [{ type: "drop" }];
    assert.equal((await run(m)).code, EXIT.FAILED);
    const n = zone();
    n.catchAll.enabled = false;
    const r = await run(n);
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.rep.problems.join("\n"), /no enabled catch-all rule/);
  });

  test("Email Routing disabled on the zone is reported", async () => {
    const m = zone();
    m.routing.enabled = false;
    const { code, rep } = await run(m);
    assert.equal(code, EXIT.FAILED);
    assert.match(rep.problems.join("\n"), /Email Routing is not enabled on acme-mail\.test/);
  });

  test("a token without Zone Settings Read reports COULD NOT MEASURE, never clean", async () => {
    const m = zone();
    m.denied.add("settings");
    const { code, text, rep } = await run(m);
    assert.equal(code, EXIT.FAILED);
    assert.equal(rep.enabled, null);
    assert.match(text, /enabled state NOT MEASURED/);
    assert.match(text, /could not measure: whether Email Routing is enabled .*Zone Settings Read/);
  });

  test("a token without Email Routing Rules Read is refused with the permission named", async () => {
    const m = zone();
    m.denied.add("routing");
    const { code, text } = await run(m).catch(async () => {
      const out = [];
      const c = await printRouting(cfClient({ token: TOKEN, fetch: fakeFetch(m) }), parseArgs(["routing", "--domain", m.domain]), (s) => out.push(s));
      return { code: c, text: out.join("\n") };
    });
    assert.equal(code, EXIT.REFUSED);
    assert.match(text, /lacks the "Zone: Email Routing Rules Read" permission/);
  });

  test("formatRoutingReport names every rule it examined", () => {
    const lines = formatRoutingReport({
      domain: "d.test", worker: "w", enabled: true, examined: 2, disabled: 0, ok: true, problems: [], missedAddresses: [],
      rows: [
        { kind: "address", name: "a", addresses: ["a@d.test"], via: "worker w", state: "worker" },
        { kind: "catch-all", name: "catch-all", addresses: [], via: "worker w", state: "worker" },
      ],
    });
    assert.equal(lines.filter((l) => /^ {2}ok /.test(l)).length, 2);
  });
});
