import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { sha256Hex } from "./src/sendidentity";
import { SERVICE_PRINCIPALS } from "./src/principals";
import { realEnv, putInbound } from "./realdb";

// #854 M3a: the operator's read-only view of the principal layer. Real sqlite engine from
// schema.sql, through the real handleApi. The tables are filled by the M2 dual-write
// (user create, agent mint), exactly as production fills them.

const ADMIN = "test-token"; // realdb's static both token
const READ = "static-read-token-0123456789";
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const PASSWORD = "correct-horse-battery";

type Json = Record<string, unknown>;

async function setup() {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native", POSTERN_API_TOKEN_READ: READ });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    let body: Json = {};
    try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = { raw: text }; }
    return { status: res.status, body, text };
  };
  await putInbound(r.env, r.ctx, { id: "m1@x", from: "x@example.com", to: ALICE });
  const user = await call("POST", "/api/admin/users", { token: ADMIN, body: { username: "alice", password: PASSWORD, displayName: "Alice" } });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  const agent = await call("POST", "/api/admin/identities", { token: ADMIN, body: { from: "bot@skyphusion.org", scopes: ["read"], displayName: "bot" } });
  expect(agent.status).toBe(201);
  const ids = r.raw.prepare("SELECT id, kind FROM principals WHERE kind <> 'service' ORDER BY kind").all() as { id: string; kind: string }[];
  const agentId = ids.find((x) => x.kind === "agent")!.id;
  const humanId = ids.find((x) => x.kind === "human")!.id;
  const audits = (action: string) =>
    (r.raw.prepare("SELECT action, outcome, target_id FROM audit_log WHERE action = ? ORDER BY id").all(action) as Json[]);
  return { ...r, call, agentId, humanId, agentToken: (agent.body as { token: string }).token, audits };
}

describe("#854 M3a GET /api/admin/principals", () => {
  it("lists every enabled principal, services included, with the projection and no secrets", async () => {
    const s = await setup();
    const res = await s.call("GET", "/api/admin/principals?limit=100", { token: ADMIN });
    expect(res.status).toBe(200);
    const items = res.body.items as Json[];
    const byKind = (k: string) => items.filter((i) => i.kind === k).map((i) => i.id).sort();
    expect(byKind("service")).toEqual(SERVICE_PRINCIPALS.map((p) => p.id).sort());
    expect(byKind("agent")).toEqual([s.agentId]);
    expect(byKind("human")).toEqual([s.humanId]);
    expect(Object.keys(items[0]).sort()).toEqual(["createdAt", "createdBy", "disabledAt", "displayName", "id", "kind", "label"]);
    expect(res.text).not.toContain(await sha256Hex(s.agentToken));
    expect(res.body.cursor).toBeNull();
    expect(s.audits("principal.list")).toHaveLength(1);
  });

  it("filters by kind, refuses an unknown kind, and pages with a cursor", async () => {
    const s = await setup();
    const humans = await s.call("GET", "/api/admin/principals?kind=human", { token: ADMIN });
    expect((humans.body.items as Json[]).map((i) => i.id)).toEqual([s.humanId]);
    const bad = await s.call("GET", "/api/admin/principals?kind=operator", { token: ADMIN });
    expect(bad.status).toBe(400);
    expect(s.audits("principal.list").map((a) => a.outcome)).toEqual(["ok", "refused"]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const q = "/api/admin/principals?limit=2" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const page = await s.call("GET", q, { token: ADMIN });
      expect(page.status).toBe(200);
      seen.push(...(page.body.items as Json[]).map((x) => x.id as string));
      cursor = page.body.cursor as string | null;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(SERVICE_PRINCIPALS.length + 2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("hides a disabled principal unless includeDisabled=1", async () => {
    const s = await setup();
    const rv = await s.call("DELETE", `/api/admin/identities/${s.agentId}`, { token: ADMIN });
    expect(rv.status).toBe(200);
    const live = await s.call("GET", "/api/admin/principals?kind=agent", { token: ADMIN });
    expect(live.body.items).toEqual([]);
    const all = await s.call("GET", "/api/admin/principals?kind=agent&includeDisabled=1", { token: ADMIN });
    expect((all.body.items as Json[]).map((i) => i.id)).toEqual([s.agentId]);
    expect((all.body.items as Json[])[0].disabledAt).not.toBeNull();
    const bad = await s.call("GET", "/api/admin/principals?includeDisabled=maybe", { token: ADMIN });
    expect(bad.status).toBe(400);
  });

  it("is admin only", async () => {
    const s = await setup();
    expect((await s.call("GET", "/api/admin/principals", { token: READ })).status).toBe(403);
    expect((await s.call("GET", `/api/admin/principals/${s.humanId}`, { token: READ })).status).toBe(403);
    expect((await s.call("GET", "/api/admin/principals", { token: s.agentToken })).status).toBe(403);
    expect((await s.call("GET", "/api/admin/principals")).status).toBe(401);
  });
});

describe("#854 M3a GET /api/admin/principals/{id}", () => {
  it("shows a human with its password credential and address, never the username or the hash", async () => {
    const s = await setup();
    const res = await s.call("GET", `/api/admin/principals/${s.humanId}`, { token: ADMIN });
    expect(res.status).toBe(200);
    expect((res.body.principal as Json).kind).toBe("human");
    const creds = res.body.credentials as Json[];
    expect(creds.map((c) => c.type)).toEqual(["password"]);
    expect(Object.keys(creds[0]).sort()).toEqual(
      ["caps", "createdAt", "expiresAt", "id", "label", "lastUsedAt", "protocols", "revokedAt", "type"],
    );
    expect(res.body.addresses).toEqual([{ address: ALICE, primary: true }]);
    const secret = (s.raw.prepare("SELECT secret, lookup FROM credentials WHERE principal_id = ?").get(s.humanId) as { secret: string; lookup: string });
    expect(secret.secret.length).toBeGreaterThan(20);
    expect(res.text).not.toContain(secret.secret);
    expect(res.text).not.toContain(`"${secret.lookup}"`);
    expect(s.audits("principal.show")).toEqual([{ action: "principal.show", outcome: "ok", target_id: s.humanId }]);
  });

  it("shows an agent without its token hash, and a service slot", async () => {
    const s = await setup();
    const res = await s.call("GET", `/api/admin/principals/${s.agentId}`, { token: ADMIN });
    expect(res.status).toBe(200);
    expect((res.body.credentials as Json[]).map((c) => [c.type, c.caps])).toEqual([["api_token", ["read"]]]);
    expect(res.text).not.toContain(await sha256Hex(s.agentToken));
    expect(res.text).not.toContain(s.agentToken);
    const svc = await s.call("GET", "/api/admin/principals/svc_both", { token: ADMIN });
    expect(svc.status).toBe(200);
    expect((svc.body.principal as Json).kind).toBe("service");
  });

  it("404s an unknown or non-id path, 400s a broken escape, and serves no other method", async () => {
    const s = await setup();
    expect((await s.call("GET", "/api/admin/principals/prn_000000000000000000000000", { token: ADMIN })).status).toBe(404);
    // A shape that is not an id is the same 404 (adminkit pathId: no id oracle); only a
    // broken percent-escape is a 400.
    expect((await s.call("GET", "/api/admin/principals/not-an-id", { token: ADMIN })).status).toBe(404);
    expect((await s.call("GET", "/api/admin/principals/%E0%A4%A", { token: ADMIN })).status).toBe(400);
    expect(s.audits("principal.show").map((a) => a.outcome)).toEqual(["refused", "refused", "refused"]);
    for (const m of ["POST", "PATCH", "DELETE", "PUT"]) {
      const res = await s.call(m, `/api/admin/principals/${s.humanId}`, { token: ADMIN, body: {} });
      expect(res.status, m).toBeGreaterThanOrEqual(400);
    }
    expect((await s.call("POST", "/api/admin/principals", { token: ADMIN, body: {} })).status).toBeGreaterThanOrEqual(400);
    // The tables are untouched by any of it.
    expect((s.raw.prepare("SELECT COUNT(*) AS n FROM principals").get() as { n: number }).n).toBe(SERVICE_PRINCIPALS.length + 2);
  });

  it("does not shadow the parity route", async () => {
    const s = await setup();
    const res = await s.call("GET", "/api/admin/principals/parity", { token: ADMIN });
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
  });
});
