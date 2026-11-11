import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { parityGate } from "./src/principalmirror";
import { realEnv } from "./realdb";

// #854: a parity that compared nothing must read "unmeasured", never a pass. Production read
// checked=0 for both kinds on 2026-11-11 while it had agents: they come from the env registry
// (D-ID-8: no principal ids), so the old tables were empty and the check could not go red.

const ADMIN = "test-token"; // realdb's static both token
const ORIGIN = "https://postern.example";
type Json = Record<string, unknown>;

async function setup(overrides: Record<string, unknown> = {}) {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native", ...overrides });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleApi(
      new Request(ORIGIN + path, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  };
  const parity = () => call("GET", "/api/admin/principals/parity");
  const lastAuditGate = () =>
    JSON.parse((r.raw.prepare("SELECT detail FROM audit_log WHERE action = 'principals.parity' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail).gate;
  return { ...r, call, parity, lastAuditGate };
}

describe("#854 parity gate on the route", () => {
  it("PRODUCTION SHAPE: registry agents only, empty old tables -> unmeasured, and says why", async () => {
    const registry = { [await sha256Hex("registry-token-0123456789abcdef")]: { from: "bot@skyphusion.org", scopes: ["read"] } };
    const s = await setup({ POSTERN_SEND_IDENTITIES: JSON.stringify(registry) });
    const res = await s.parity();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agents: { checked: 0, diffs: 0 },
      humans: { checked: 0, diffs: 0 },
      gate: "unmeasured",
      measured: { agents: false, humans: false },
      outOfScope: { registryAgents: 1, webmailAuthBackend: "native" },
    });
    expect(String(res.body.reason)).toContain("nothing was compared");
    expect(s.lastAuditGate()).toBe("unmeasured");
  });

  it("an unset webmail backend is reported as off", async () => {
    const s = await setup({ WEBMAIL_AUTH_BACKEND: undefined });
    expect((await s.parity()).body.outOfScope).toEqual({ registryAgents: 0, webmailAuthBackend: "off" });
  });

  it("one runtime agent, no humans -> pass with only agents measured", async () => {
    const s = await setup();
    expect((await s.call("POST", "/api/admin/identities", { from: "a@skyphusion.org", scopes: ["read"] })).status).toBe(201);
    const res = await s.parity();
    expect(res.body).toMatchObject({ gate: "pass", measured: { agents: true, humans: false }, agents: { checked: 1, diffs: 0 } });
    expect(String(res.body.reason)).toContain("humans had no rows");
  });

  it("both kinds present and in step -> pass with both measured", async () => {
    const s = await setup();
    await s.call("POST", "/api/admin/identities", { from: "a@skyphusion.org", scopes: ["read"] });
    expect((await s.call("POST", "/api/admin/users", { username: "alice@skyphusion.org", password: "correct-horse-battery" })).status).toBe(201);
    const res = await s.parity();
    expect(res.body).toMatchObject({ gate: "pass", measured: { agents: true, humans: true } });
    expect(s.lastAuditGate()).toBe("pass");
  });

  it("a planted diff -> fail", async () => {
    const s = await setup();
    const a = await s.call("POST", "/api/admin/identities", { from: "a@skyphusion.org", scopes: ["read"] });
    s.raw.prepare("UPDATE credentials SET caps = '[\"send\"]' WHERE principal_id = ?").run(a.body.id as string);
    expect((await s.parity()).body).toMatchObject({ gate: "fail", agents: { diffs: 1 } });
  });

  it("a read-path miss alone -> fail, even with nothing else to compare", async () => {
    const s = await setup();
    s.raw.prepare("INSERT INTO principal_read_misses (day, kind, misses) VALUES (?, 'agent', 1)").run(new Date().toISOString().slice(0, 10));
    expect((await s.parity()).body).toMatchObject({ gate: "fail", measured: { agents: false, humans: false } });
  });
});

describe("#854 parityGate (pure)", () => {
  const report = (agents: number, humans: number, diffs = 0) => ({
    agents: { checked: agents, diffs, sample: [] },
    humans: { checked: humans, diffs: 0, withoutPrincipal: 0, sample: [] },
    orphans: { diffs: 0, sample: [] },
  });
  it("zero checked is never a pass", () => {
    expect(parityGate(report(0, 0), { agent: 0, human: 0 }).gate).toBe("unmeasured");
  });
  it("CONTROL: the same function does pass when something was compared", () => {
    expect(parityGate(report(3, 0), { agent: 0, human: 0 }).gate).toBe("pass");
    expect(parityGate(report(3, 2), { agent: 0, human: 0 }).gate).toBe("pass");
  });
  it("a diff wins over unmeasured", () => {
    expect(parityGate(report(0, 0), { agent: 0, human: 1 }).gate).toBe("fail");
    expect(parityGate(report(2, 2, 1), { agent: 0, human: 0 }).gate).toBe("fail");
  });
});
