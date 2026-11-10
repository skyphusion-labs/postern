import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { handleSelfIdentities, MAX_ACTIVE_CHILDREN } from "./src/agentidentities";
import { sha256Hex } from "./src/sendidentity";
import { realEnv } from "./realdb";

// #801 (#632 S1): runtime agent identities. Every property here is SQL or gate behaviour,
// so it runs against a REAL sqlite engine built from schema.sql, through the real
// handleApi, with no stub between the request and the table.

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
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  };
  const mintAsAdmin = async (scopes: string[], from = ME, extra: Json = {}) => {
    const res = await call("POST", "/api/admin/identities", ADMIN, { from, scopes, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; token: string; scopes: string[]; parentId: string | null };
  };
  const mintAs = async (token: string, scopes: string[], extra: Json = {}) =>
    call("POST", "/api/identities", token, { scopes, ...extra });
  const whoami = (token: string) => call("GET", "/api/whoami", token);
  const auditRows = () =>
    r.raw.prepare("SELECT actor_kind, actor_id, action, target_id, outcome, detail FROM audit_log ORDER BY id").all() as Array<{
      actor_kind: string; actor_id: string | null; action: string; target_id: string | null; outcome: string; detail: string | null;
    }>;
  return { ...r, call, mintAsAdmin, mintAs, whoami, auditRows };
}

describe("#801 an identity minted at runtime authenticates on the next request, no deploy", () => {
  it("mint returns the token once, and that token is a working credential immediately", async () => {
    const s = setup();
    const minted = await s.mintAsAdmin(["read", "send"], ME, { displayName: "Invoice agent", label: "invoices" });
    expect(minted.token).toMatch(/^pstn_[A-Za-z0-9_-]{43}$/);
    expect(minted.id).toMatch(/^idn_[0-9a-f]{24}$/);
    expect(minted.parentId).toBeNull();

    const me = await s.whoami(minted.token);
    expect(me.status).toBe(200);
    expect(me.body.identity).toBe(ME);
    expect(me.body.identityId).toBe(minted.id);
    expect(me.body.capabilities).toEqual(["read", "send"]);
  });

  it("CONTROL: an unminted token of the same shape is 401, so the 200 above is the mint", async () => {
    const s = setup();
    await s.mintAsAdmin(["read"]);
    const forged = "pstn_" + "A".repeat(43);
    expect((await s.whoami(forged)).status).toBe(401);
  });

  it("a runtime identity reaches only what its caps grant (organize is not implied by read)", async () => {
    const s = setup();
    const { token } = await s.mintAsAdmin(["read"]);
    expect((await s.call("GET", "/api/messages", token)).status).toBe(200);
    const move = await s.call("POST", "/api/messages/move", token, { ids: [], mailbox: "archive" });
    expect(move.status).toBe(403);
    const send = await s.call("POST", "/api/send", token, { to: ["x@example.com"], subject: "s", text: "t" });
    expect(send.status).toBe(403);
  });
});

describe("#801 the store holds hashes only, never a token value", () => {
  it("no column of agent_identities or audit_log contains the token; token_hash is its sha256", async () => {
    const s = setup();
    const { id, token } = await s.mintAsAdmin(["read", "send", "mint"]);
    const child = (await s.mintAs(token, ["read"])).body as { token: string };
    for (const table of ["agent_identities", "audit_log"]) {
      const dump = JSON.stringify(s.raw.prepare(`SELECT * FROM ${table}`).all());
      expect(dump.includes(token), `${table} holds the parent token`).toBe(false);
      expect(dump.includes(child.token), `${table} holds the child token`).toBe(false);
    }
    const row = s.raw.prepare("SELECT token_hash FROM agent_identities WHERE id = ?").get(id) as { token_hash: string };
    expect(row.token_hash).toBe(await sha256Hex(token));
  });

  it("list never carries the token or the hash", async () => {
    const s = setup();
    const { token } = await s.mintAsAdmin(["read"]);
    const hash = await sha256Hex(token);
    const listed = await s.call("GET", "/api/admin/identities", ADMIN);
    expect(listed.status).toBe(200);
    const text = JSON.stringify(listed.body);
    expect(text.includes(token)).toBe(false);
    expect(text.includes(hash)).toBe(false);
    expect((listed.body.items as Json[])[0]).not.toHaveProperty("token");
  });
});

describe("#801 a revoked identity is refused on the VERY NEXT request", () => {
  it("operator revoke: 200 before, 401 on the next request with the same token", async () => {
    const s = setup();
    const { id, token } = await s.mintAsAdmin(["read"]);
    expect((await s.whoami(token)).status).toBe(200); // positive control, same token
    const rev = await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(1);
    expect((await s.whoami(token)).status).toBe(401);
    expect((await s.call("GET", "/api/messages", token)).status).toBe(401);
  });

  it("revoke is idempotent and the row survives with revokedAt (ids are never reused)", async () => {
    const s = setup();
    const { id } = await s.mintAsAdmin(["read"]);
    await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    const again = await s.call("DELETE", `/api/admin/identities/${id}`, ADMIN);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revoked: 0, alreadyRevoked: true });
    const active = await s.call("GET", "/api/admin/identities", ADMIN);
    expect((active.body.items as Json[]).map((i) => i.id)).not.toContain(id);
    const all = await s.call("GET", "/api/admin/identities?includeRevoked=1", ADMIN);
    const row = (all.body.items as Json[]).find((i) => i.id === id)!;
    expect(row.revokedAt).toBeTruthy();
    expect(row.revokedBy).toBe("operator");
  });

  it("revoking a parent revokes every identity below it, on the next request", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "send", "mint"]);
    const b = (await s.mintAs(a.token, ["read", "mint"])).body as { id: string; token: string };
    const c = (await s.mintAs(b.token, ["read"])).body as { id: string; token: string };
    for (const t of [a.token, b.token, c.token]) expect((await s.whoami(t)).status).toBe(200);

    const rev = await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);
    expect(rev.body.revoked).toBe(3);
    expect([...(rev.body.cascade as string[])].sort()).toEqual([b.id, c.id].sort());
    for (const t of [a.token, b.token, c.token]) expect((await s.whoami(t)).status).toBe(401);
  });

  it("an identity may revoke itself", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const res = await s.call("DELETE", `/api/identities/${a.id}`, a.token);
    expect(res.status).toBe(200);
    expect((await s.whoami(a.token)).status).toBe(401);
  });

  it("a delegated revoke takes the child and its subtree, and leaves the minter live", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const b = (await s.mintAs(a.token, ["read", "mint"])).body as { id: string; token: string };
    const c = (await s.mintAs(b.token, ["read"])).body as { id: string; token: string };
    const res = await s.call("DELETE", `/api/identities/${b.id}`, a.token);
    expect(res.status).toBe(200);
    expect((await s.whoami(b.token)).status).toBe(401);
    expect((await s.whoami(c.token)).status).toBe(401);
    expect((await s.whoami(a.token)).status).toBe(200);
  });
});

describe("#801 a token cannot mint an identity broader than its own scope", () => {
  it("a scope the minter does not hold is 403 E_SCOPE_EXCEEDS, and nothing is minted", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const before = (s.raw.prepare("SELECT COUNT(*) AS n FROM agent_identities").get() as { n: number }).n;
    for (const wider of [["send"], ["read", "send"], ["organize"], ["read", "organize"]]) {
      const res = await s.mintAs(a.token, wider);
      expect(res.status, JSON.stringify(wider)).toBe(403);
      expect(res.body.error).toBe("E_SCOPE_EXCEEDS");
    }
    const after = (s.raw.prepare("SELECT COUNT(*) AS n FROM agent_identities").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("CONTROL: the same minter CAN mint a subset, so the 403s above are the scope rule", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const ok = await s.mintAs(a.token, ["read"]);
    expect(ok.status).toBe(201);
    expect(ok.body.parentId).toBe(a.id);
    const ok2 = await s.mintAs(a.token, ["read", "mint"]);
    expect(ok2.status).toBe(201);
  });

  it("a scope no agent identity may hold (delete, admin, both, imap) is 400 for anyone", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "send", "organize", "mint"]);
    for (const bad of ["delete", "admin", "both", "imap", "READ"]) {
      const self = await s.mintAs(a.token, [bad]);
      expect(self.status, bad).toBe(400);
      const admin = await s.call("POST", "/api/admin/identities", ADMIN, { from: ME, scopes: [bad] });
      expect(admin.status, bad).toBe(400);
      expect(admin.body.error).toBe("E_VALIDATION_ERROR");
    }
  });

  it("a delegated identity always acts as its minter: a different from is 403", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "send", "mint"]);
    const other = await s.mintAs(a.token, ["send"], { from: "boss@skyphusion.org" });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe("E_FORBIDDEN");
    const same = await s.mintAs(a.token, ["send"], { from: ME.toUpperCase() });
    expect(same.status).toBe(201);
    expect(same.body.from).toBe(ME);
  });

  it("a child without mint cannot mint at all (refused by the scope gate)", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const b = (await s.mintAs(a.token, ["read"])).body as { token: string };
    const res = await s.mintAs(b.token, ["read"]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("an env-registry entry can never hold mint, even if the var lists it", async () => {
    const envToken = "env-registry-token-0123456789abcdef";
    const s = setup({
      POSTERN_SEND_IDENTITIES: JSON.stringify({
        [await sha256Hex(envToken)]: { from: ME, scopes: ["read", "mint"] },
      }),
    });
    expect((await s.whoami(envToken)).body.capabilities).toEqual(["read"]);
    const res = await s.mintAs(envToken, ["read"]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("no static scoped token can mint, and a both token is pointed at the admin route", async () => {
    const s = setup();
    expect((await s.mintAs(READ, ["read"])).status).toBe(403);
    expect((await s.call("POST", "/api/admin/identities", READ, { from: ME, scopes: ["read"] })).status).toBe(403);
    const both = await s.mintAs(ADMIN, ["read"]);
    expect(both.status).toBe(403);
    expect(both.body.error).toBe("E_IDENTITY_REQUIRED");
  });

  it("a minter is capped at MAX_ACTIVE_CHILDREN active children", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const ins = s.raw.prepare(
      "INSERT INTO agent_identities (id, token_hash, from_addr, scopes, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < MAX_ACTIVE_CHILDREN; i++) {
      ins.run(`idn_${i.toString(16).padStart(24, "0")}`, `h${i}`, ME, '["read"]', a.id, "2026-01-01T00:00:00.000Z");
    }
    const res = await s.mintAs(a.token, ["read"]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("E_LIMIT");
  });

  it("a mint racing its minter's revoke creates no child and records no ok row", async () => {
    // The gate saw an active minter; the revoke lands before the insert. Driven through the
    // handler with the resolution the gate would have produced a moment earlier.
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);
    const res = await handleSelfIdentities(
      req("POST", "/api/identities", a.token, { scopes: ["read"] }),
      s.env,
      new URL(ORIGIN + "/api/identities"),
      { identityId: a.id, identity: { from: ME }, caps: ["read", "mint"] },
    );
    expect(res!.status).toBe(401);
    const children = s.raw.prepare("SELECT COUNT(*) AS n FROM agent_identities WHERE parent_id = ?").get(a.id) as { n: number };
    expect(children.n).toBe(0);
    const okMints = s.auditRows().filter((r) => r.action === "identity.mint" && r.outcome === "ok" && r.actor_id === a.id);
    expect(okMints).toEqual([]);
  });
});

describe("#801 a delegated caller sees and touches only its own subtree", () => {
  it("a sibling's identity is 404 on revoke, the same answer as an id that does not exist", async () => {
    const s = setup();
    const a1 = await s.mintAsAdmin(["read", "mint"]);
    const a2 = await s.mintAsAdmin(["read", "mint"]);
    const kid = (await s.mintAs(a2.token, ["read"])).body as { id: string; token: string };
    const foreign = await s.call("DELETE", `/api/identities/${kid.id}`, a1.token);
    const missing = await s.call("DELETE", `/api/identities/idn_${"f".repeat(24)}`, a1.token);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect((await s.whoami(kid.token)).status).toBe(200);
    const parent = await s.call("DELETE", `/api/identities/${a2.id}`, a1.token);
    expect(parent.status).toBe(404);
  });

  it("list returns the caller's subtree only, never a sibling's", async () => {
    const s = setup();
    const a1 = await s.mintAsAdmin(["read", "mint"]);
    const a2 = await s.mintAsAdmin(["read", "mint"]);
    const mine = (await s.mintAs(a1.token, ["read", "mint"])).body as { id: string; token: string };
    const grandkid = (await s.mintAs(mine.token, ["read"])).body as { id: string };
    await s.mintAs(a2.token, ["read"]);
    const listed = await s.call("GET", "/api/identities", a1.token);
    expect(listed.status).toBe(200);
    expect((listed.body.items as Json[]).map((i) => i.id).sort()).toEqual([mine.id, grandkid.id].sort());
  });
});

describe("#801 every mint, list and revoke writes an audit row", () => {
  it("records each action with its actor, target and outcome, refusals included", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    const b = (await s.mintAs(a.token, ["read"])).body as { id: string };
    await s.mintAs(a.token, ["send"]); // refused: wider than the minter
    await s.call("GET", "/api/identities", a.token);
    await s.call("GET", "/api/admin/identities", ADMIN);
    await s.call("DELETE", `/api/identities/${b.id}`, a.token);
    await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);

    const rows = s.auditRows().map((r) => [r.actor_kind, r.actor_id, r.action, r.target_id, r.outcome]);
    expect(rows).toEqual([
      ["operator", null, "identity.mint", a.id, "ok"],
      ["identity", a.id, "identity.mint", b.id, "ok"],
      ["identity", a.id, "identity.mint", null, "refused"],
      ["identity", a.id, "identity.list", null, "ok"],
      ["operator", null, "identity.list", null, "ok"],
      ["identity", a.id, "identity.revoke", b.id, "ok"],
      ["operator", null, "identity.revoke", a.id, "ok"],
    ]);
    const refused = s.auditRows()[2];
    expect(JSON.parse(refused.detail!)).toMatchObject({ error: "E_SCOPE_EXCEEDS" });
  });

  it("GET /api/admin/audit serves the log newest first, and only to an operator", async () => {
    const s = setup();
    const a = await s.mintAsAdmin(["read", "mint"]);
    await s.call("DELETE", `/api/admin/identities/${a.id}`, ADMIN);
    const log = await s.call("GET", "/api/admin/audit?limit=1", ADMIN);
    expect(log.status).toBe(200);
    const items = log.body.items as Array<{ action: string; target: { id: string } }>;
    expect(items.map((i) => i.action)).toEqual(["identity.revoke"]);
    expect(items[0].target.id).toBe(a.id);
    expect(log.body.cursor).toBeTruthy();
    const next = await s.call("GET", `/api/admin/audit?cursor=${log.body.cursor as string}`, ADMIN);
    expect((next.body.items as Array<{ action: string }>).map((i) => i.action)).toEqual(["identity.mint"]);
    expect((await s.call("GET", "/api/admin/audit", READ)).status).toBe(403);
  });
});

describe("#801 the env registry is untouched", () => {
  it("an entry in POSTERN_SEND_IDENTITIES still resolves alongside runtime identities", async () => {
    const envToken = "env-registry-token-abcdef0123456789";
    const s = setup({
      POSTERN_SEND_IDENTITIES: JSON.stringify({ [await sha256Hex(envToken)]: { from: ME, scopes: ["read"] } }),
    });
    const runtime = await s.mintAsAdmin(["read"]);
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
    const { token } = await s.mintAsAdmin(["read"]);
    (s.env as unknown as { ALLOWED_FROM_DOMAIN: string }).ALLOWED_FROM_DOMAIN = "example.org";
    expect((await s.whoami(token)).status).toBe(401);
  });

  it("an unreadable identity store is 503 E_AUTH_UNAVAILABLE, never a 401 that reads as revoked", async () => {
    const s = setup();
    const { token } = await s.mintAsAdmin(["read"]);
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

  it("a method with no route row is 404, not served past a missing scope gate", async () => {
    const s = setup();
    const { id } = await s.mintAsAdmin(["read"]);
    expect((await s.call("GET", `/api/admin/identities/${id}`, READ)).status).toBe(404);
    expect((await s.call("PUT", "/api/identities", READ, {})).status).toBe(404);
    expect((await s.call("PATCH", "/api/admin/identities", READ, {})).status).toBe(404);
  });

  it("validates the operator mint: from on the domain, scopes required", async () => {
    const s = setup();
    const off = await s.call("POST", "/api/admin/identities", ADMIN, { from: "x@example.com", scopes: ["read"] });
    expect(off.status).toBe(400);
    expect(off.body.error).toBe("E_SENDER_NOT_ALLOWED");
    const none = await s.call("POST", "/api/admin/identities", ADMIN, { from: ME });
    expect(none.status).toBe(400);
    const empty = await s.call("POST", "/api/admin/identities", ADMIN, { from: ME, scopes: [] });
    expect(empty.status).toBe(400);
  });

  it("list pages by keyset and refuses a malformed cursor", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.mintAsAdmin(["read"]);
    const p1 = await s.call("GET", "/api/admin/identities?limit=2", ADMIN);
    expect((p1.body.items as Json[]).length).toBe(2);
    const p2 = await s.call("GET", `/api/admin/identities?limit=2&cursor=${p1.body.cursor as string}`, ADMIN);
    expect((p2.body.items as Json[]).length).toBe(1);
    expect(p2.body.cursor).toBeNull();
    const ids = [...(p1.body.items as Json[]), ...(p2.body.items as Json[])].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect((await s.call("GET", "/api/admin/identities?cursor=zzz", ADMIN)).status).toBe(400);
    expect((await s.call("GET", "/api/admin/identities?includeRevoked=maybe", ADMIN)).status).toBe(400);
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
