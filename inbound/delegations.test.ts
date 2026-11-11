import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { realEnv, putInbound } from "./realdb";

// #740 S1: the delegation-grant store and its operator routes. Real sqlite engine built
// from schema.sql, through the real handleApi. S1 changes NO behaviour, and one test
// below pins that: a grant does not yet widen what its grantee may touch.

const ADMIN = "test-token"; // realdb's static both token
const STATIC: Record<string, string> = {
  read: "static-read-token-0123456789",
  send: "static-send-token-0123456789",
  delete: "static-delete-token-0123456789",
  imap: "static-imap-token-0123456789",
  organize: "static-organize-token-0123456789",
};
const AGENT = "agent@skyphusion.org";
const HUMAN = "conrad@skyphusion.org";
const ORIGIN = "https://postern.example";

type Json = Record<string, unknown>;

function setup(extra: Record<string, unknown> = {}) {
  const r = realEnv({
    ...extra,
    POSTERN_API_TOKEN_READ: STATIC.read,
    POSTERN_API_TOKEN_SEND: STATIC.send,
    POSTERN_API_TOKEN_DELETE: STATIC.delete,
    POSTERN_API_TOKEN_IMAP: STATIC.imap,
    POSTERN_API_TOKEN_ORGANIZE: STATIC.organize,
  });
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Json };
  };
  const identity = async (scopes: string[] = ["read", "send", "organize"], from = AGENT) => {
    const res = await call("POST", "/api/admin/identities", ADMIN, { from, scopes });
    expect(res.status, res.text).toBe(201);
    return res.body as { id: string; token: string };
  };
  const grant = (granteeId: string, powers: unknown = ["organize"], address = HUMAN, extra: Json = {}) =>
    call("POST", "/api/admin/delegations", ADMIN, { granteeId, address, powers, ...extra });
  const grants = () => (s_raw().prepare("SELECT COUNT(*) AS n FROM delegation_grants").get() as { n: number }).n;
  const s_raw = () => r.raw;
  const audits = () =>
    r.raw.prepare("SELECT action, target_id, outcome, detail FROM audit_log WHERE action LIKE 'delegation.%' ORDER BY id").all() as Array<{
      action: string; target_id: string | null; outcome: string; detail: string | null;
    }>;
  return { ...r, call, identity, grant, grants, audits };
}

describe("#740 S1 an operator grants, lists and revokes delegations", () => {
  it("a grant to a live identity is 201 and is stored with read implied", async () => {
    const s = setup();
    const a = await s.identity();
    const res = await s.grant(a.id, ["organize", "quote"], HUMAN, { label: "inbox triage" });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ granteeId: a.id, address: HUMAN, powers: ["read", "organize", "quote"], label: "inbox triage", createdBy: "operator" });
    const row = s.raw.prepare("SELECT powers FROM delegation_grants").get() as { powers: string };
    expect(JSON.parse(row.powers)).toEqual(["read", "organize", "quote"]);
    expect(res.body.id).toMatch(/^dlg_[0-9a-f]{24}$/);
    expect(s.grants()).toBe(1);
  });

  it("the address is normalised, and every known power alone and together grants (control)", async () => {
    const s = setup();
    const a = await s.identity();
    const addrs = ["a@skyphusion.org", "b@skyphusion.org", "c@skyphusion.org", "D@SKYPHUSION.ORG"];
    const sets = [["read"], ["organize"], ["send_as"], ["read", "organize", "quote", "send_as"]];
    for (let i = 0; i < sets.length; i++) {
      const res = await s.grant(a.id, sets[i], addrs[i]);
      expect(res.status, res.text).toBe(201);
    }
    expect((await s.call("GET", "/api/admin/delegations?address=d@skyphusion.org", ADMIN)).body.items).toHaveLength(1);
  });

  it("revoke is 200, idempotent, keeps the row, and frees the pair for a new grant", async () => {
    const s = setup();
    const a = await s.identity();
    const g = (await s.grant(a.id)).body as { id: string };
    const rev = await s.call("DELETE", `/api/admin/delegations/${g.id}`, ADMIN);
    expect(rev.body).toMatchObject({ ok: true, revoked: 1, alreadyRevoked: false });
    const again = await s.call("DELETE", `/api/admin/delegations/${g.id}`, ADMIN);
    expect(again.body).toMatchObject({ revoked: 0, alreadyRevoked: true });
    expect((await s.call("GET", "/api/admin/delegations", ADMIN)).body.items).toEqual([]);
    const all = await s.call("GET", "/api/admin/delegations?includeRevoked=1", ADMIN);
    expect((all.body.items as Json[])[0].revokedAt).toBeTruthy();
    const regrant = await s.grant(a.id, ["quote"]);
    expect(regrant.status).toBe(201);
    expect(regrant.body.id).not.toBe(g.id);
  });

  it("an unknown or malformed delegation id is 404", async () => {
    const s = setup();
    expect((await s.call("DELETE", `/api/admin/delegations/dlg_${"f".repeat(24)}`, ADMIN)).status).toBe(404);
    expect((await s.call("DELETE", "/api/admin/delegations/idn_whatever", ADMIN)).status).toBe(404);
  });

  it("list filters by grantee and address, pages by keyset, and refuses bad filters", async () => {
    const s = setup();
    const a = await s.identity();
    const b = await s.identity(["read"], "agent2@skyphusion.org");
    await s.grant(a.id, ["organize"], "x@skyphusion.org");
    await s.grant(a.id, ["organize"], "y@skyphusion.org");
    await s.grant(b.id, ["quote"], "x@skyphusion.org");
    const byA = await s.call("GET", `/api/admin/delegations?grantee=${a.id}`, ADMIN);
    expect((byA.body.items as Json[]).map((i) => i.address).sort()).toEqual(["x@skyphusion.org", "y@skyphusion.org"]);
    const byX = await s.call("GET", "/api/admin/delegations?address=x@skyphusion.org", ADMIN);
    expect((byX.body.items as Json[]).map((i) => i.granteeId).sort()).toEqual([a.id, b.id].sort());
    const p1 = await s.call("GET", "/api/admin/delegations?limit=2", ADMIN);
    expect((p1.body.items as Json[]).length).toBe(2);
    const p2 = await s.call("GET", `/api/admin/delegations?limit=2&cursor=${p1.body.cursor as string}`, ADMIN);
    expect((p2.body.items as Json[]).length).toBe(1);
    expect(p2.body.cursor).toBeNull();
    for (const bad of ["grantee=nope", "address=nope", "cursor=zzz", "includeRevoked=maybe", "limit=0"]) {
      expect((await s.call("GET", `/api/admin/delegations?${bad}`, ADMIN)).status, bad).toBe(400);
    }
  });
});

describe("#740 S1 the grantee must be a LIVE agent identity at mint", () => {
  it("an id that names no identity is 400 E_GRANTEE_INVALID and nothing is stored", async () => {
    const s = setup();
    const res = await s.grant(`idn_${"0".repeat(24)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("E_GRANTEE_INVALID");
    expect(s.grants()).toBe(0);
  });

  it("a malformed or missing granteeId is refused", async () => {
    const s = setup();
    expect((await s.grant("not-an-id")).body.error).toBe("E_GRANTEE_INVALID");
    expect((await s.call("POST", "/api/admin/delegations", ADMIN, { address: HUMAN, powers: ["organize"] })).body.error).toBe("E_FIELD_MISSING");
    expect(s.grants()).toBe(0);
  });

  it("a REVOKED identity is 400 E_GRANTEE_INVALID", async () => {
    const s = setup();
    const a = await s.identity();
    await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);
    const res = await s.grant(a.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("E_GRANTEE_INVALID");
    expect(s.grants()).toBe(0);
  });

  it("CONTROL: the same identity, live, is granted", async () => {
    const s = setup();
    const a = await s.identity();
    expect((await s.grant(a.id)).status).toBe(201);
  });

  it("a revoke landing between the check and the write leaves no grant and no ok audit row", async () => {
    const s = setup();
    const a = await s.identity();
    // Revoke the grantee right after the mint's reference check has read it as live.
    const db = s.env.DB as unknown as { prepare(sql: string): unknown };
    const real = db.prepare.bind(db);
    let fired = false;
    db.prepare = (sql: string) => {
      const stmt = real(sql) as Record<string, unknown> & { first(): Promise<unknown> };
      if (!fired && sql.startsWith("SELECT from_addr, revoked_at FROM agent_identities")) {
        const first = stmt.first.bind(stmt);
        stmt.first = async () => {
          const row = await first();
          fired = true;
          s.raw.prepare("UPDATE agent_identities SET revoked_at = ? WHERE id = ?").run("2026-11-10T00:00:00Z", a.id);
          return row;
        };
      }
      return stmt as never;
    };
    const res = await s.grant(a.id);
    expect(fired).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("E_GRANTEE_INVALID");
    expect(s.grants()).toBe(0);
    expect(s.audits().filter((r) => r.action === "delegation.grant" && r.outcome === "ok")).toEqual([]);
  });
});

describe("#740 S1 grants are validated, never stripped", () => {
  it("unknown or empty powers are 400 and store nothing", async () => {
    const s = setup();
    const a = await s.identity();
    for (const bad of [[], ["admin"], ["delete"], ["send"], ["READ"], ["ORGANIZE"], ["organize", "admin"], "organize", [1]]) {
      const res = await s.grant(a.id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.field).toBe("powers");
    }
    expect(s.grants()).toBe(0);
  });

  it("every power implies read: each set is stored as itself plus read, canonical and deduplicated", async () => {
    const s = setup();
    const a = await s.identity();
    const cases: Array<[string[], string[]]> = [
      [["read"], ["read"]],
      [["organize"], ["read", "organize"]],
      [["quote"], ["read", "quote"]],
      [["send_as"], ["read", "send_as"]],
      [["send_as", "organize", "read", "organize"], ["read", "organize", "send_as"]],
    ];
    for (let i = 0; i < cases.length; i++) {
      const res = await s.grant(a.id, cases[i][0], `p${i}@skyphusion.org`);
      expect(res.status, res.text).toBe(201);
      expect(res.body.powers, JSON.stringify(cases[i][0])).toEqual(cases[i][1]);
    }
    const listed = await s.call("GET", "/api/admin/delegations", ADMIN);
    for (const item of listed.body.items as Array<{ powers: string[] }>) expect(item.powers[0]).toBe("read");
  });

  it("the address must be on the deploy domain and must not be the grantee's own", async () => {
    const s = setup();
    const a = await s.identity();
    expect((await s.grant(a.id, ["organize"], "x@example.com")).status).toBe(400);
    expect((await s.grant(a.id, ["organize"], "not-an-address")).status).toBe(400);
    const own = await s.grant(a.id, ["organize"], AGENT.toUpperCase());
    expect(own.status).toBe(400);
    expect(own.body.field).toBe("address");
    expect(s.grants()).toBe(0);
  });

  it("one ACTIVE grant per (grantee, address): a second is 409 E_CONFLICT", async () => {
    const s = setup();
    const a = await s.identity();
    expect((await s.grant(a.id, ["organize"])).status).toBe(201);
    const dup = await s.grant(a.id, ["quote"]);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("E_CONFLICT");
    expect(s.grants()).toBe(1);
  });

  it("the partial unique index holds even if the pre-check is bypassed (two active rows cannot exist)", () => {
    const s = setup();
    const ins = s.raw.prepare(
      "INSERT INTO delegation_grants (id, grantee_id, address, powers, created_by, created_at) VALUES (?, ?, ?, ?, 'operator', ?)",
    );
    ins.run(`dlg_${"1".repeat(24)}`, `idn_${"1".repeat(24)}`, HUMAN, '["organize"]', "2026-11-10T00:00:00Z");
    expect(() => ins.run(`dlg_${"2".repeat(24)}`, `idn_${"1".repeat(24)}`, HUMAN, '["quote"]', "2026-11-10T00:00:00Z")).toThrow(/UNIQUE/);
    s.raw.prepare("UPDATE delegation_grants SET revoked_at = ? WHERE id = ?").run("2026-11-10T01:00:00Z", `dlg_${"1".repeat(24)}`);
    expect(() => ins.run(`dlg_${"3".repeat(24)}`, `idn_${"1".repeat(24)}`, HUMAN, '["quote"]', "2026-11-10T02:00:00Z")).not.toThrow();
  });
});

describe("#740 S1 every authority path is operator only (derived from the route table)", () => {
  const ROWS = ROUTE_TABLE.filter((r) => r.path.startsWith("/api/admin/delegations"));
  const concrete = (path: string, match: string) => (match === "prefix" ? `${path}dlg_${"a".repeat(24)}` : path);

  it("the table has the three delegation rows (the loop below is not vacuous)", () => {
    expect(ROWS.map((r) => r.id).sort()).toEqual(["admin-delegation-revoke", "admin-delegations-grant", "admin-delegations-list"]);
    expect(ROWS.every((r) => r.scope === "admin")).toBe(true);
  });

  for (const row of ROWS) {
    it(`${row.method} ${row.path} refuses every non-operator credential, and admits the operator`, async () => {
      const s = setup();
      const a = await s.identity(["read", "send", "organize"]);
      const method = row.method === "ANY" ? "GET" : row.method;
      const body = method === "POST" ? { granteeId: a.id, address: HUMAN, powers: ["organize"] } : undefined;
      const path = concrete(row.path, row.match);
      const refused: Array<[string, string]> = [
        ...Object.entries(STATIC),
        ["runtime identity (every agent cap)", a.token],
      ];
      for (const [who, token] of refused) {
        const res = await s.call(method, path, token, body);
        expect(res.status, `${who}: ${res.text}`).toBe(403);
        expect(res.body.error).toBe("forbidden");
      }
      expect((await s.call(method, path, null, body)).status, "no credential").toBe(401);
      expect(s.grants()).toBe(0);
      // CONTROL: the operator clears the same gate, on the same request.
      const op = await s.call(method, path, ADMIN, body);
      expect(op.status === 403 && op.body.error === "forbidden", op.text).toBe(false);
    });
  }

  it("a method with no route row is 404, never served past a missing scope gate", async () => {
    const s = setup();
    expect((await s.call("GET", `/api/admin/delegations/dlg_${"a".repeat(24)}`, STATIC.read)).status).toBe(404);
    expect((await s.call("PATCH", "/api/admin/delegations", STATIC.read, {})).status).toBe(404);
  });
});

describe("#740 S1 a grant widens only what it names, and only where S2 enforces it", () => {
  it("seen without `for` stays the grantee's OWN read state: the grant does not reach it (S2 needs `for`)", async () => {
    const s = setup();
    const a = await s.identity(["read", "organize"]);
    await putInbound(s.env, s.ctx, { id: "<m1@example.com>", from: "x@example.com", to: HUMAN });
    const stored = await s.call("GET", "/api/messages", ADMIN);
    const id = ((stored.body.items as Json[])[0].messageId as string);
    expect(id).toBe("<m1@example.com>");
    const before = await s.call("POST", "/api/messages/seen", a.token, { ids: [id], seen: true });
    expect(await s.grant(a.id, ["organize", "quote", "send_as"])).toMatchObject({ status: 201 });
    const after = await s.call("POST", "/api/messages/seen", a.token, { ids: [id], seen: true });
    expect([after.status, after.body.updated]).toEqual([before.status, before.body.updated]);
    expect(after.body.updated).toBe(0);
    // CONTROL: the operator CAN mark it, so the 0 above is the scope, not a missing message.
    expect((await s.call("POST", "/api/messages/seen", ADMIN, { ids: [id], seen: true })).body.updated).toBe(1);
  });

  it("a grantee with send still sends as ITSELF, never as a granted address, with or without the grant (send_as is S4)", async () => {
    const sent: Array<{ from: unknown }> = [];
    const s = setup({ EMAIL: { async send(m: { from: unknown }) { sent.push(m); return { messageId: "provider-1" }; } } });
    const a = await s.identity(["read", "send"]);
    const wire = () => {
      const f = sent.at(-1)?.from;
      return typeof f === "string" ? f : (f as { email?: string } | undefined)?.email;
    };
    const ask = { to: ["x@example.com"], from: HUMAN, subject: "s", text: "t" };
    const before = await s.call("POST", "/api/send", a.token, ask);
    expect(before.status, before.text).toBe(200);
    expect(await s.grant(a.id, ["send_as"])).toMatchObject({ status: 201 });
    const after = await s.call("POST", "/api/send", a.token, ask);
    expect(after.status, after.text).toBe(200);
    // The send really happened (2 dispatches), and both used the agent's own address.
    expect(sent.length).toBe(2);
    expect([before.body.from, after.body.from]).toEqual([AGENT, AGENT]);
    expect(wire()).toBe(AGENT);
  });
});

describe("#740 S1 every grant, list and revoke writes an audit row", () => {
  it("records each action with its target and outcome, refusals included", async () => {
    const s = setup();
    const a = await s.identity();
    const g = (await s.grant(a.id, ["organize"])).body as { id: string };
    await s.grant(a.id, ["admin"]); // refused 400
    await s.grant(`idn_${"0".repeat(24)}`); // refused, no such grantee
    await s.call("GET", "/api/admin/delegations", ADMIN);
    await s.call("DELETE", `/api/admin/delegations/${g.id}`, ADMIN);
    await s.call("DELETE", `/api/admin/delegations/dlg_${"0".repeat(24)}`, ADMIN); // refused 404
    expect(s.audits().map((r) => [r.action, r.target_id, r.outcome])).toEqual([
      ["delegation.grant", g.id, "ok"],
      ["delegation.grant", null, "refused"],
      ["delegation.grant", null, "refused"],
      ["delegation.list", null, "ok"],
      ["delegation.revoke", g.id, "ok"],
      ["delegation.revoke", `dlg_${"0".repeat(24)}`, "refused"],
    ]);
    expect(JSON.parse(s.audits()[0].detail!)).toEqual({ granteeId: a.id, address: HUMAN, powers: ["read", "organize"] });
    expect(JSON.parse(s.audits()[2].detail!)).toMatchObject({ error: "E_GRANTEE_INVALID" });
  });

  it("the audit route serves them", async () => {
    const s = setup();
    const a = await s.identity();
    await s.grant(a.id);
    const log = await s.call("GET", "/api/admin/audit?limit=1", ADMIN);
    expect((log.body.items as Array<{ action: string; target: { kind: string } }>)[0]).toMatchObject({
      action: "delegation.grant",
      target: { kind: "delegation" },
    });
  });
});

describe("#740 S1 migration 0017 matches schema.sql", () => {
  const MIGRATION = readFileSync(new URL("./migrations/0017_delegation_grants.sql", import.meta.url), "utf8");
  const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const shape = (db: DatabaseSync) => [
    db.prepare("PRAGMA table_info(delegation_grants)").all(),
    db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'delegation_grants' AND type = 'index' ORDER BY name").all(),
  ];

  it("applied to an empty database yields the table and indexes schema.sql declares", () => {
    const m = new DatabaseSync(":memory:");
    m.exec(MIGRATION);
    const sch = new DatabaseSync(":memory:");
    sch.exec(SCHEMA);
    expect(shape(m)).toEqual(shape(sch));
    expect((shape(m)[1] as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it("re-applies cleanly (IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    expect(() => db.exec(MIGRATION)).not.toThrow();
  });
});
