import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { realEnv } from "./realdb";

// #904: POSTERN_API_TOKEN_ADMIN, the ADMIN-ONLY slot. It reaches every admin route and no
// other route, and its audit rows name the svc_admin service principal, so automation is
// told apart from the operator. Real sqlite engine from schema.sql, through handleApi.

const OPERATOR = "test-token"; // realdb's static both token
const ADMIN = "admin-slot-token-0123456789abcdef";
const ADMIN_2 = "admin-slot-token-second-member-0123";
const ORIGIN = "https://postern.example";

type Json = Record<string, unknown>;

function setup(overrides: Record<string, unknown> = {}) {
  const r = realEnv({ POSTERN_API_TOKEN_ADMIN: `${ADMIN}, ${ADMIN_2}`, ...overrides });
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? (JSON.parse(text) as Json) : {}; } catch { parsed = {}; }
    return { status: res.status, body: parsed };
  };
  const actors = () => r.raw.prepare("SELECT actor_kind, actor_id, action FROM audit_log ORDER BY id").all() as Json[];
  return { ...r, call, actors };
}

// Every Bearer-gated row, made concrete: a prefix row gets a child, ANY becomes GET.
const BEARER_ROWS = ROUTE_TABLE.filter((r) => r.scope !== null && r.auth === "bearer");
const concrete = (r: (typeof BEARER_ROWS)[number]) => ({
  method: r.method === "ANY" ? "GET" : r.method,
  path: r.match === "prefix" ? `${r.path}${r.path.endsWith("/") ? "" : "/"}probe-child` : r.path,
});
const refusedAtGate = (res: { status: number; body: Json }) => res.status === 403 && res.body.error === "forbidden";

describe("#904 the admin-only slot, against every Bearer row (derived from the route table)", () => {
  it("the table has admin rows and non-admin rows (the loops below are not vacuous)", () => {
    expect(BEARER_ROWS.filter((r) => r.scope === "admin").length).toBeGreaterThan(5);
    expect(BEARER_ROWS.filter((r) => r.scope !== "admin").length).toBeGreaterThan(5);
  });

  for (const row of BEARER_ROWS) {
    const { method, path } = concrete(row);
    if (row.scope === "admin") {
      it(`${method} ${path} (admin): the admin slot clears the gate, as the operator does`, async () => {
        const s = setup();
        const res = await s.call(method, path, ADMIN, {});
        expect(refusedAtGate(res), `${res.status} ${JSON.stringify(res.body)}`).toBe(false);
        expect(res.status).not.toBe(401);
        // CONTROL: the operator clears the same gate on the same request.
        expect(refusedAtGate(await s.call(method, path, OPERATOR, {}))).toBe(false);
      });
    } else {
      it(`${method} ${path} (${row.scope}): the admin slot is refused at the gate; the operator is not`, async () => {
        const s = setup();
        const res = await s.call(method, path, ADMIN, {});
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe("forbidden");
        // CONTROL: the operator (`both`) clears the same gate.
        expect(refusedAtGate(await s.call(method, path, OPERATOR, {}))).toBe(false);
      });
    }
  }
});

describe("#904 the admin slot is audited as svc_admin", () => {
  it("a mint, a list and the backfill by the admin slot name svc_admin; the operator's name svc_both", async () => {
    const s = setup();
    expect((await s.call("POST", "/api/admin/identities", ADMIN, { from: "agent@skyphusion.org", scopes: ["read"] })).status).toBe(201);
    expect((await s.call("GET", "/api/admin/identities", ADMIN)).status).toBe(200);
    expect((await s.call("POST", "/api/admin/principals/backfill", ADMIN)).status).toBe(200);
    expect((await s.call("GET", "/api/admin/delegations", OPERATOR)).status).toBe(200);
    expect(s.actors()).toEqual([
      { actor_kind: "service", actor_id: "svc_admin", action: "identity.mint" },
      { actor_kind: "service", actor_id: "svc_admin", action: "identity.list" },
      { actor_kind: "service", actor_id: "svc_admin", action: "principals.backfill" },
      { actor_kind: "service", actor_id: "svc_both", action: "delegation.list" },
    ]);
    expect(s.raw.prepare("SELECT kind FROM principals WHERE id = 'svc_admin'").get(), "svc_admin is a real principal").toEqual({ kind: "service" });
  });

  it("a refusal by the admin slot is audited as svc_admin too", async () => {
    const s = setup();
    expect((await s.call("POST", "/api/admin/identities", ADMIN, { from: "agent@skyphusion.org", scopes: ["admin"] })).status).toBe(400);
    expect(s.actors()).toEqual([{ actor_kind: "service", actor_id: "svc_admin", action: "identity.mint" }]);
  });
});

describe("#904 the slot resolves like the other slots", () => {
  it("every member of the comma set works", async () => {
    const s = setup();
    expect((await s.call("GET", "/api/admin/identities", ADMIN)).status).toBe(200);
    expect((await s.call("GET", "/api/admin/identities", ADMIN_2)).status).toBe(200);
  });

  it("UNSET: nothing changes; an unknown token is 401 and the operator still reaches admin", async () => {
    const s = setup({ POSTERN_API_TOKEN_ADMIN: undefined });
    expect((await s.call("GET", "/api/admin/identities", ADMIN)).status).toBe(401);
    expect((await s.call("GET", "/api/admin/identities", OPERATOR)).status).toBe(200);
  });

  it("an accidental value collision with the operator token resolves to both (the primary key is never locked out)", async () => {
    const s = setup({ POSTERN_API_TOKEN_ADMIN: OPERATOR });
    // `both` reaches a read route; an `admin` resolution would be 403 there.
    expect((await s.call("GET", "/api/messages", OPERATOR)).status).toBe(200);
  });

  it("whoami is a read route, so the admin-only slot is refused there", async () => {
    const s = setup();
    expect((await s.call("GET", "/api/whoami", ADMIN)).status).toBe(403);
  });
});
