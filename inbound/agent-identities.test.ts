import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { sha256Hex } from "./src/sendidentity";
import { realEnv } from "./realdb";

// #801 (#632 S1): runtime agent identities, operator-minted on the smtp-credentials
// precedent. Every property here is SQL or gate behaviour, so it runs against a REAL
// sqlite engine built from schema.sql, through the real handleApi, with no stub between
// the request and the table.

const ADMIN = "test-token"; // realEnv's POSTERN_API_TOKEN, a static `both`
const READ = "static-read-token-0123456789";
const ME = "agent@skyphusion.org";
const ORIGIN = "https://postern.example";

type Json = Record<string, unknown>;

function req(method: string, path: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function setup(overrides: Record<string, unknown> = {}) {
  const r = realEnv({ POSTERN_API_TOKEN_READ: READ, ...overrides });
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const res = await handleApi(req(method, path, token, body), r.env, r.ctx);
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Json };
  };
  const mint = async (scopes: string[], from = ME, extra: Json = {}) => {
    const res = await call("POST", "/api/admin/identities", ADMIN, { from, scopes, ...extra });
    expect(res.status, res.text).toBe(201);
    return res.body as { id: string; token: string; scopes: string[] };
  };
  const whoami = (token: string) => call("GET", "/api/whoami", token);
  const auditRows = () =>
    r.raw.prepare("SELECT actor_kind, action, target_id, outcome, detail FROM audit_log ORDER BY id").all() as Array<{
      actor_kind: string; action: string; target_id: string | null; outcome: string; detail: string | null;
    }>;
  return { ...r, call, mint, whoami, auditRows };
}

describe("#801 an identity minted at runtime authenticates on the next request, no deploy", () => {
  it("mint returns a token that is a working credential immediately", async () => {
    const s = setup();
    const minted = await s.mint(["read", "send"], ME, { displayName: "Invoice agent", label: "invoices" });
    expect(minted.token).toMatch(/^pstn_[A-Za-z0-9_-]{43}$/);
    expect(minted.id).toMatch(/^idn_[0-9a-f]{24}$/);
    const me = await s.whoami(minted.token);
    expect(me.status).toBe(200);
    expect(me.body.identity).toBe(ME);
    expect(me.body.identityId).toBe(minted.id);
    expect(me.body.capabilities).toEqual(["read", "send"]);
  });

  it("CONTROL: an unminted token of the same shape is 401, so the 200 above is the mint", async () => {
    const s = setup();
    await s.mint(["read"]);
    expect((await s.whoami("pstn_" + "A".repeat(43))).status).toBe(401);
  });

  it("a runtime identity reaches only what its caps grant (organize is not implied by read)", async () => {
    const s = setup();
    const { token } = await s.mint(["read"]);
    expect((await s.call("GET", "/api/messages", token)).status).toBe(200);
    expect((await s.call("POST", "/api/messages/move", token, { ids: [], mailbox: "archive" })).status).toBe(403);
    expect((await s.call("POST", "/api/send", token, { to: ["x@example.com"], subject: "s", text: "t" })).status).toBe(403);
  });
});

describe("#801 the token is returned exactly once and is never retrievable again", () => {
  it("only the mint response carries it: list, list with revoked, audit, whoami and revoke do not", async () => {
    const s = setup();
    const { id, token } = await s.mint(["read", "send", "organize"]);
    const later = [
      await s.call("GET", "/api/admin/identities", ADMIN),
      await s.call("GET", "/api/admin/identities?includeRevoked=1", ADMIN),
      await s.call("GET", "/api/admin/audit", ADMIN),
      await s.whoami(token),
      await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN),
      await s.call("GET", "/api/admin/identities?includeRevoked=1", ADMIN),
      await s.call("GET", "/api/admin/audit", ADMIN),
    ];
    for (const res of later) {
      expect(res.status).toBe(200);
      expect(res.text.includes(token), res.text).toBe(false);
      expect(res.text.includes(token.slice(5)), "the token body without its prefix").toBe(false);
    }
    // CONTROL: the same substring check DOES see the token where it is legitimately present.
    const second = await s.call("POST", "/api/admin/identities", ADMIN, { from: ME, scopes: ["read"] });
    const t2 = (second.body as { token: string }).token;
    expect(second.text.includes(t2)).toBe(true);
    expect(second.text.includes(token), "a later mint must not echo an earlier token").toBe(false);
  });

  it("the store holds the sha256 of the token and nothing that is the token", async () => {
    const s = setup();
    const { id, token } = await s.mint(["read"]);
    for (const table of ["agent_identities", "audit_log"]) {
      const dump = JSON.stringify(s.raw.prepare(`SELECT * FROM ${table}`).all());
      expect(dump.includes(token), `${table} holds the token`).toBe(false);
    }
    const row = s.raw.prepare("SELECT token_hash FROM agent_identities WHERE id = ?").get(id) as { token_hash: string };
    expect(row.token_hash).toBe(await sha256Hex(token));
  });
});

describe("#801 list and audit responses never include token_hash", () => {
  it("no response carries the hash value or a hash field", async () => {
    const s = setup();
    const { id, token } = await s.mint(["read"]);
    const hash = await sha256Hex(token);
    // CONTROL: the hash is really in the store, so its absence below is a filter, not luck.
    expect(JSON.stringify(s.raw.prepare("SELECT * FROM agent_identities").all()).includes(hash)).toBe(true);
    await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    for (const path of [
      "/api/admin/identities",
      "/api/admin/identities?includeRevoked=1",
      "/api/admin/audit",
    ]) {
      const res = await s.call("GET", path, ADMIN);
      expect(res.status).toBe(200);
      expect(res.text.includes(hash), path).toBe(false);
      expect(/token_?hash/i.test(res.text), path).toBe(false);
    }
    const listed = await s.call("GET", "/api/admin/identities?includeRevoked=1", ADMIN);
    expect(Object.keys((listed.body.items as Json[])[0]).sort()).toEqual(
      ["createdAt", "displayName", "from", "id", "label", "revokedAt", "scopes"],
    );
  });
});

describe("#801 a revoked identity is refused on the VERY NEXT request", () => {
  it("200 before, 401 on the next request with the same token", async () => {
    const s = setup();
    const { id, token } = await s.mint(["read"]);
    expect((await s.whoami(token)).status).toBe(200); // positive control, same token
    const rev = await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(1);
    expect((await s.whoami(token)).status).toBe(401);
    expect((await s.call("GET", "/api/messages", token)).status).toBe(401);
  });

  it("revoke is idempotent, the row survives with revokedAt, and the id is not reused", async () => {
    const s = setup();
    const { id } = await s.mint(["read"]);
    await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    const again = await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revoked: 0, alreadyRevoked: true });
    const active = await s.call("GET", "/api/admin/identities", ADMIN);
    expect((active.body.items as Json[]).map((i) => i.id)).not.toContain(id);
    const all = await s.call("GET", "/api/admin/identities?includeRevoked=1", ADMIN);
    expect((all.body.items as Json[]).find((i) => i.id === id)!.revokedAt).toBeTruthy();
    const fresh = await s.mint(["read"]);
    expect(fresh.id).not.toBe(id);
  });

  it("an unknown id is 404", async () => {
    const s = setup();
    expect((await s.call("DELETE", `/api/admin/identities/idn_${"f".repeat(24)}`, ADMIN)).status).toBe(404);
    expect((await s.call("DELETE", "/api/admin/identities/not-an-id", ADMIN)).status).toBe(404);
  });
});

describe("#801 an admin can mint only the known agent caps", () => {
  it("unknown or admin-level caps are refused 400 and nothing is minted", async () => {
    const s = setup();
    const count = () => (s.raw.prepare("SELECT COUNT(*) AS n FROM agent_identities").get() as { n: number }).n;
    for (const bad of [["delete"], ["admin"], ["both"], ["imap"], ["mint"], ["READ"], ["read", "admin"], ["read", 1]]) {
      const res = await s.call("POST", "/api/admin/identities", ADMIN, { from: ME, scopes: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBe("E_VALIDATION_ERROR");
      expect(res.body.field).toBe("scopes");
    }
    expect(count()).toBe(0);
  });

  it("CONTROL: every known cap, alone and together, mints", async () => {
    const s = setup();
    for (const ok of [["read"], ["send"], ["organize"], ["read", "send", "organize"]]) await s.mint(ok);
  });

  it("from must be on the domain, and scopes are required", async () => {
    const s = setup();
    const off = await s.call("POST", "/api/admin/identities", ADMIN, { from: "x@example.com", scopes: ["read"] });
    expect(off.status).toBe(400);
    expect(off.body.error).toBe("E_SENDER_NOT_ALLOWED");
    expect((await s.call("POST", "/api/admin/identities", ADMIN, { from: ME })).status).toBe(400);
    expect((await s.call("POST", "/api/admin/identities", ADMIN, { from: ME, scopes: [] })).status).toBe(400);
    expect((await s.call("POST", "/api/admin/identities", ADMIN, { scopes: ["read"] })).status).toBe(400);
  });

  it("no static scoped token can reach the identity routes", async () => {
    const s = setup();
    expect((await s.call("POST", "/api/admin/identities", READ, { from: ME, scopes: ["read"] })).status).toBe(403);
    expect((await s.call("GET", "/api/admin/identities", READ)).status).toBe(403);
    expect((await s.call("GET", "/api/admin/audit", READ)).status).toBe(403);
  });
});

describe("#801 a runtime identity token is refused on every /api/admin/* route", () => {
  // Derived from the route table, so a future admin route is covered the day it lands.
  const ADMIN_ROWS = ROUTE_TABLE.filter((r) => r.path.startsWith("/api/admin/"));
  const concrete = (path: string, match: string) => (match === "prefix" ? `${path}x1` : path);

  it("the table has admin rows to test (the loop below is not vacuous)", () => {
    expect(ADMIN_ROWS.length).toBeGreaterThanOrEqual(10);
    expect(ADMIN_ROWS.every((r) => r.scope === "admin")).toBe(true);
  });

  for (const row of ADMIN_ROWS) {
    it(`${row.method} ${row.path} (${row.id}) is 403 for a runtime identity with every agent cap`, async () => {
      const s = setup();
      const { token } = await s.mint(["read", "send", "organize"]);
      const method = row.method === "ANY" ? "GET" : row.method;
      const body = method === "GET" || method === "DELETE" ? undefined : {};
      const res = await s.call(method, concrete(row.path, row.match), token, body);
      expect(res.status, res.text).toBe(403);
      expect(res.body.error).toBe("forbidden");
      expect(res.body.message).toContain("admin");
      // CONTROL: the operator token clears the same gate on the same request.
      const op = await s.call(method, concrete(row.path, row.match), ADMIN, body);
      expect(op.status === 403 && op.body.error === "forbidden", op.text).toBe(false);
    });
  }

  it("and cannot mint another identity, even one narrower than itself", async () => {
    const s = setup();
    const { token } = await s.mint(["read", "send", "organize"]);
    const res = await s.call("POST", "/api/admin/identities", token, { from: ME, scopes: ["read"] });
    expect(res.status).toBe(403);
    expect((s.raw.prepare("SELECT COUNT(*) AS n FROM agent_identities").get() as { n: number }).n).toBe(1);
  });
});

describe("#801 every mint, list and revoke writes an audit row", () => {
  it("records each action with its target and outcome, refusals included", async () => {
    const s = setup();
    const a = await s.mint(["read"]);
    await s.call("POST", "/api/admin/identities", ADMIN, { from: ME, scopes: ["admin"] }); // refused
    await s.call("GET", "/api/admin/identities", ADMIN);
    await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);
    await s.call("DELETE", `/api/admin/identities/idn_${"0".repeat(24)}`, ADMIN); // refused, 404
    const rows = s.auditRows().map((r) => [r.actor_kind, r.action, r.target_id, r.outcome]);
    expect(rows).toEqual([
      // #854 M1: the operator is the svc_both SERVICE principal, no longer anonymous.
      ["service", "identity.mint", a.id, "ok"],
      ["service", "identity.mint", null, "refused"],
      ["service", "identity.list", null, "ok"],
      ["service", "identity.revoke", a.id, "ok"],
      ["service", "identity.revoke", `idn_${"0".repeat(24)}`, "refused"],
    ]);
    expect(JSON.parse(s.auditRows()[1].detail!)).toMatchObject({ error: "E_VALIDATION_ERROR" });
    expect(JSON.parse(s.auditRows()[0].detail!)).toEqual({ from: ME, scopes: ["read"] });
  });

  it("GET /api/admin/audit serves the log newest first with a keyset cursor", async () => {
    const s = setup();
    const a = await s.mint(["read"]);
    await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);
    const log = await s.call("GET", "/api/admin/audit?limit=1", ADMIN);
    const items = log.body.items as Array<{ action: string; target: { id: string } }>;
    expect(items.map((i) => i.action)).toEqual(["identity.revoke"]);
    expect(items[0].target.id).toBe(a.id);
    const next = await s.call("GET", `/api/admin/audit?cursor=${log.body.cursor as string}`, ADMIN);
    expect((next.body.items as Array<{ action: string }>).map((i) => i.action)).toEqual(["identity.mint"]);
    expect(next.body.cursor).toBeNull();
    expect((await s.call("GET", "/api/admin/audit?cursor=x", ADMIN)).status).toBe(400);
  });
});

describe("#801 the env registry is untouched", () => {
  it("an entry in POSTERN_SEND_IDENTITIES still resolves alongside runtime identities", async () => {
    const envToken = "env-registry-token-abcdef0123456789";
    const s = setup({
      POSTERN_SEND_IDENTITIES: JSON.stringify({ [await sha256Hex(envToken)]: { from: ME, scopes: ["read"] } }),
    });
    const runtime = await s.mint(["read"]);
    const env = await s.whoami(envToken);
    expect(env.status).toBe(200);
    expect(env.body.identity).toBe(ME);
    expect(env.body.identityId).toBeNull();
    expect((await s.whoami(runtime.token)).body.identityId).toBe(runtime.id);
  });
});

describe("#801 the resolver fails closed and honestly", () => {
  it("a row whose From left ALLOWED_FROM_DOMAIN is 401", async () => {
    const s = setup();
    const { token } = await s.mint(["read"]);
    (s.env as unknown as { ALLOWED_FROM_DOMAIN: string }).ALLOWED_FROM_DOMAIN = "example.org";
    expect((await s.whoami(token)).status).toBe(401);
  });

  it("an unreadable identity store is 503 E_AUTH_UNAVAILABLE, never a 401 that reads as revoked", async () => {
    const s = setup();
    const { token } = await s.mint(["read"]);
    const db = s.env.DB as unknown as { prepare(sql: string): unknown };
    const real = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes("FROM agent_identities WHERE token_hash")) throw new Error("D1 down");
      return real(sql);
    };
    const res = await s.whoami(token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("E_AUTH_UNAVAILABLE");
    // CONTROL: a static token never reaches the table, so it is unaffected.
    expect((await s.whoami(READ)).status).toBe(200);
  });

  it("a method or path with no route row is 404, never served past a missing scope gate", async () => {
    const s = setup();
    const { id } = await s.mint(["read"]);
    expect((await s.call("GET", `/api/admin/identities/${id}`, READ)).status).toBe(404);
    expect((await s.call("PATCH", "/api/admin/identities", READ, {})).status).toBe(404);
    expect((await s.call("POST", "/api/identities", READ, {})).status).toBe(404);
  });

  it("list pages by keyset and refuses a malformed cursor or flag", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.mint(["read"]);
    const p1 = await s.call("GET", "/api/admin/identities?limit=2", ADMIN);
    expect((p1.body.items as Json[]).length).toBe(2);
    const p2 = await s.call("GET", `/api/admin/identities?limit=2&cursor=${p1.body.cursor as string}`, ADMIN);
    expect((p2.body.items as Json[]).length).toBe(1);
    expect(p2.body.cursor).toBeNull();
    const ids = [...(p1.body.items as Json[]), ...(p2.body.items as Json[])].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect((await s.call("GET", "/api/admin/identities?cursor=zzz", ADMIN)).status).toBe(400);
    expect((await s.call("GET", "/api/admin/identities?includeRevoked=maybe", ADMIN)).status).toBe(400);
    expect((await s.call("GET", "/api/admin/identities?limit=0", ADMIN)).status).toBe(400);
  });
});

describe("#801 migration 0016 matches schema.sql", () => {
  const MIGRATION = readFileSync(new URL("./migrations/0016_agent_identities.sql", import.meta.url), "utf8");
  const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const shape = (db: DatabaseSync) =>
    ["agent_identities", "audit_log"].map((t) => db.prepare(`PRAGMA table_info(${t})`).all());

  it("applied to an empty database yields the same tables schema.sql declares", () => {
    const fromMigration = new DatabaseSync(":memory:");
    fromMigration.exec(MIGRATION);
    const fromSchema = new DatabaseSync(":memory:");
    fromSchema.exec(SCHEMA);
    expect(shape(fromMigration)).toEqual(shape(fromSchema));
    expect(shape(fromMigration)[0].length).toBeGreaterThan(5);
  });

  it("re-applies cleanly over a database that already has them (IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    expect(() => db.exec(MIGRATION)).not.toThrow();
  });
});
