import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
// node URL, not the workers-types global: a file URL fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { sha256Hex } from "./src/sendidentity";
import { backfillPrincipals, SERVICE_PRINCIPALS } from "./src/principals";
import { NATIVE_SESSION_CAPS, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { realEnv, putInbound } from "./realdb";

// #854 M1: the principal tables and their backfill. Store only: nothing authorizes from
// these tables, so every credential must resolve exactly as before. Real sqlite engine
// from schema.sql, through the real handleApi.

const ADMIN = "test-token"; // realdb's static both token
const READ = "static-read-token-0123456789";
const SEND = "static-send-token-0123456789";
const REGISTRY = "registry-token-0123456789abcdef";
const TRANSPORT = "transport-token-0123456789";
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const BOB = "bob@skyphusion.org";
const PASSWORD = "correct-horse-battery";

type Json = Record<string, unknown>;

async function setup() {
  const registry = { [await sha256Hex(REGISTRY)]: { from: "reg@skyphusion.org", scopes: ["read", "send"] } };
  const r = realEnv({
    WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_API_TOKEN_READ: READ,
    POSTERN_API_TOKEN_SEND: SEND,
    POSTERN_SEND_IDENTITIES: JSON.stringify(registry),
    POSTERN_TRANSPORT_TOKEN: TRANSPORT,
  });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    let body: Json = {};
    try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = { raw: text }; }
    return { status: res.status, body, res };
  };
  const mint = async (from: string, scopes: string[] = ["read", "send"]) => {
    const res = await call("POST", "/api/admin/identities", { token: ADMIN, body: { from, scopes, displayName: from.split("@")[0] } });
    expect(res.status).toBe(201);
    return res.body as { id: string; token: string };
  };
  const user = async (username: string, displayName?: string) => {
    const res = await call("POST", "/api/admin/users", { token: ADMIN, body: { username, password: PASSWORD, ...(displayName ? { displayName } : {}) } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const table = (name: string) => r.raw.prepare(`SELECT * FROM ${name} ORDER BY 1`).all() as Json[];
  const snapshot = () => ({ principals: table("principals"), credentials: table("credentials"), principal_addresses: table("principal_addresses") });
  // #854 M2 dual-writes the principal tables on every write, so a backfill test models a
  // deploy whose rows were written BEFORE dual-write existed: the old tables populated,
  // the principal tables holding only the migration's service seeds.
  const preM2 = () => r.raw.exec("DELETE FROM credentials; DELETE FROM principal_addresses; DELETE FROM principals WHERE kind <> 'service';");
  await putInbound(r.env, r.ctx, { id: "m1@x", from: "x@example.com", to: ALICE });
  return { ...r, call, mint, user, table, snapshot, preM2 };
}
type S = Awaited<ReturnType<typeof setup>>;

describe("#854 M1 migration 0019 matches schema.sql", () => {
  // 0019 creates the tables and six seeds; 0021 (#904) seeds the admin-only slot.
  const MIGRATION =
    readFileSync(new URL("./migrations/0019_principals.sql", import.meta.url), "utf8") +
    readFileSync(new URL("./migrations/0021_admin_slot_principal.sql", import.meta.url), "utf8") +
    readFileSync(new URL("./migrations/0022_principal_read_misses.sql", import.meta.url), "utf8");
  const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const shape = (sql: string) => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql);
    return {
      objects: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%principal%' OR name LIKE '%credentials%' ORDER BY name").all(),
      seeds: db.prepare("SELECT * FROM principals ORDER BY id").all(),
    };
  };

  it("applied to an empty database yields the same tables, indexes and seeds schema.sql declares", () => {
    const fromSchema = shape(SCHEMA);
    expect(fromSchema.objects.length, "the comparison is not vacuous").toBeGreaterThan(4);
    const migrated = shape(SCHEMA.replace(/CREATE TABLE IF NOT EXISTS principals[\s\S]*$/, "") + MIGRATION);
    expect(migrated).toEqual(fromSchema);
  });

  it("seeds exactly the service principals, and re-applies cleanly (IF NOT EXISTS, OR IGNORE)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    db.exec(MIGRATION);
    const rows = db.prepare("SELECT id, kind FROM principals ORDER BY id").all() as Json[];
    expect(rows.map((x) => x.id)).toEqual(SERVICE_PRINCIPALS.map((s) => s.id).sort());
    expect(rows.every((x) => x.kind === "service")).toBe(true);
  });
});

describe("#854 M1 the backfill maps today's people models", () => {
  it("agents keep their idn_ ids; humans get prn_ principals with password credentials; addresses are claimed", async () => {
    const s = await setup();
    const a = await s.mint("agent@skyphusion.org", ["read", "organize"]);
    await s.user(ALICE, "Alice A");
    s.preM2();
    const res = await s.call("POST", "/api/admin/principals/backfill", { token: ADMIN });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ agents: { added: 1 }, humans: { added: 1 }, addressConflicts: [] });

    const agent = s.raw.prepare("SELECT * FROM principals WHERE id = ?").get(a.id) as Json;
    expect(agent).toMatchObject({ id: a.id, kind: "agent", display_name: "agent", created_by: "migration", disabled_at: null });
    const agentCred = s.raw.prepare("SELECT * FROM credentials WHERE principal_id = ?").get(a.id) as Json;
    const sourceHash = (s.raw.prepare("SELECT token_hash FROM agent_identities WHERE id = ?").get(a.id) as Json).token_hash;
    expect(agentCred).toMatchObject({ type: "api_token", lookup: sourceHash, secret: null, caps: JSON.stringify(["read", "organize"]), revoked_at: null });

    const human = s.raw.prepare("SELECT * FROM credentials WHERE type = 'password' AND lookup = ?").get(ALICE) as Json;
    const sourceSecret = (s.raw.prepare("SELECT secret_hash FROM smtp_credentials WHERE username = ?").get(ALICE) as Json).secret_hash;
    expect(human).toMatchObject({ secret: sourceSecret, caps: JSON.stringify(NATIVE_SESSION_CAPS) });
    expect(String(human.principal_id)).toMatch(/^prn_[0-9a-f]{24}$/);
    expect(s.raw.prepare("SELECT kind, display_name FROM principals WHERE id = ?").get(human.principal_id as string)).toEqual({ kind: "human", display_name: "Alice A" });

    expect(s.table("principal_addresses")).toEqual(
      [
        { address: "agent@skyphusion.org", principal_id: a.id, is_primary: 1 },
        { address: ALICE, principal_id: human.principal_id, is_primary: 1 },
      ].sort((x, y) => String(x.address).localeCompare(String(y.address))),
    );
    // Grants and audit rows keep naming the same id: no rewrite, and it now names a principal.
    expect((s.raw.prepare("SELECT COUNT(*) AS n FROM principals WHERE id = ?").get(a.id) as Json).n).toBe(1);
  });

  it("an address already owned by another principal is reported and left with its owner", async () => {
    const s = await setup();
    await s.user(ALICE);
    const second = await s.mint(ALICE, ["send"]);
    const res = await s.call("POST", "/api/admin/principals/backfill", { token: ADMIN });
    const conflicts = res.body.addressConflicts as Json[];
    expect(conflicts.length).toBe(1);
    const owner = s.raw.prepare("SELECT principal_id FROM principal_addresses WHERE address = ?").get(ALICE) as Json;
    expect(conflicts[0]).toMatchObject({ address: ALICE, ownerId: owner.principal_id });
    expect(owner.principal_id === second.id || conflicts[0].principalId === second.id).toBe(true);
  });
});

describe("#854 M1 the backfill is idempotent and convergent", () => {
  it("run twice: the second run adds nothing, changes nothing, and the tables are byte-identical", async () => {
    const s = await setup();
    await s.mint("agent@skyphusion.org");
    await s.mint("agent2@skyphusion.org", ["send"]);
    await s.user(ALICE, "Alice A");
    await s.user(BOB);
    s.preM2();
    const first = await backfillPrincipals(s.env);
    expect(first.agents.added + first.humans.added).toBe(4);
    const after1 = s.snapshot();
    const second = await backfillPrincipals(s.env);
    expect(second).toEqual({ services: { added: 0 }, agents: { added: 0, synced: 0 }, humans: { added: 0, synced: 0, orphansRevoked: 0 }, addressConflicts: [] });
    expect(s.snapshot()).toEqual(after1);
  });

  it("a change at the source is mirrored exactly once: revoke, disable, password change, delete", async () => {
    const s = await setup();
    const a = await s.mint("agent@skyphusion.org");
    await s.user(ALICE);
    await s.user(BOB);
    s.preM2();
    await backfillPrincipals(s.env);
    const aliceCred = s.raw.prepare("SELECT principal_id FROM credentials WHERE lookup = ?").get(ALICE) as Json;
    const bobCred = s.raw.prepare("SELECT id, principal_id FROM credentials WHERE lookup = ?").get(BOB) as Json;

    // The source changes the way a pre-M2 writer made them: on the old tables only, so the
    // backfill is what has to converge them (dual-write would already have).
    s.raw.prepare("UPDATE agent_identities SET revoked_at = ? WHERE id = ?").run("2026-11-11T01:00:00.000Z", a.id);
    s.raw.prepare("UPDATE smtp_credentials SET disabled = 1, updated_at = ? WHERE username = ?").run("2026-11-11T01:00:00.000Z", ALICE);
    s.raw.prepare("UPDATE smtp_credentials SET secret_hash = ? WHERE username = ?").run("pbkdf2-sha512$1$new$hash", ALICE);
    s.raw.prepare("DELETE FROM smtp_credentials WHERE username = ?").run(BOB);

    const run = await backfillPrincipals(s.env);
    expect(run.agents.synced).toBe(1);
    expect(run.humans.synced).toBe(1);
    expect(run.humans.orphansRevoked).toBe(1);
    expect((s.raw.prepare("SELECT disabled_at FROM principals WHERE id = ?").get(a.id) as Json).disabled_at).not.toBeNull();
    expect((s.raw.prepare("SELECT revoked_at FROM credentials WHERE principal_id = ?").get(a.id) as Json).revoked_at).not.toBeNull();
    expect((s.raw.prepare("SELECT disabled_at FROM principals WHERE id = ?").get(aliceCred.principal_id as string) as Json).disabled_at).not.toBeNull();
    const newSecret = "pbkdf2-sha512$1$new$hash";
    expect((s.raw.prepare("SELECT secret FROM credentials WHERE lookup = ? AND type = 'password'").get(ALICE) as Json).secret).toBe(newSecret);
    expect((s.raw.prepare("SELECT revoked_at FROM credentials WHERE id = ?").get(bobCred.id as string) as Json).revoked_at).not.toBeNull();
    // The principal rows are never deleted.
    expect((s.raw.prepare("SELECT COUNT(*) AS n FROM principals WHERE id = ?").get(bobCred.principal_id as string) as Json).n).toBe(1);

    const settled = s.snapshot();
    const again = await backfillPrincipals(s.env);
    expect(again.agents.synced + again.humans.synced + again.humans.orphansRevoked + again.agents.added + again.humans.added).toBe(0);
    expect(s.snapshot(), "the converged state is stable").toEqual(settled);
  });

  it("a re-enabled user is re-enabled on the next run", async () => {
    const s = await setup();
    await s.user(ALICE);
    await s.call("PATCH", `/api/admin/users/${encodeURIComponent(ALICE)}`, { token: ADMIN, body: { disabled: true } });
    s.preM2();
    await backfillPrincipals(s.env);
    const pid = (s.raw.prepare("SELECT principal_id FROM credentials WHERE lookup = ?").get(ALICE) as Json).principal_id as string;
    expect((s.raw.prepare("SELECT disabled_at FROM principals WHERE id = ?").get(pid) as Json).disabled_at).not.toBeNull();
    s.raw.prepare("UPDATE smtp_credentials SET disabled = 0 WHERE username = ?").run(ALICE); // a pre-M2 writer
    expect((await backfillPrincipals(s.env)).humans.synced).toBe(1);
    expect((s.raw.prepare("SELECT disabled_at FROM principals WHERE id = ?").get(pid) as Json).disabled_at).toBeNull();
  });
});

describe("#854 M1 changes no resolution: every credential resolves identically before and after", () => {
  async function observe(s: S, credentials: Record<string, { token?: string; headers?: Record<string, string> }>) {
    const out: Record<string, unknown> = {};
    for (const [who, c] of Object.entries(credentials)) {
      const me = await s.call("GET", "/api/whoami", c);
      const list = await s.call("GET", "/api/messages", c);
      const get = await s.call("GET", "/api/messages/m1%40x", c);
      out[who] = { whoami: [me.status, me.body], list: [list.status, list.body.identityScope ?? list.body.error], get: get.status };
    }
    const good = await s.call("POST", "/api/smtp-auth", { token: TRANSPORT, body: { username: ALICE, secret: PASSWORD } });
    const bad = await s.call("POST", "/api/smtp-auth", { token: TRANSPORT, body: { username: ALICE, secret: "wrong-password-x" } });
    out.smtpAuth = [good.body, bad.body];
    return out;
  }

  it("static both/read/send, an env registry token, a runtime identity and a webmail session", async () => {
    const s = await setup();
    const a = await s.mint("agent@skyphusion.org", ["read", "send", "organize"]);
    await s.user(ALICE, "Alice A");
    const signin = await s.call("POST", "/api/session", { body: { username: ALICE, password: PASSWORD } });
    expect(signin.status).toBe(200);
    const cookie = (name: string) => signin.res.headers.getSetCookie().find((c) => c.startsWith(name + "="))!.split(";")[0];
    const credentials = {
      both: { token: ADMIN },
      read: { token: READ },
      send: { token: SEND },
      registry: { token: REGISTRY },
      runtime: { token: a.token },
      session: { headers: { cookie: `${cookie(SESSION_COOKIE)}; ${cookie(CSRF_COOKIE)}` } },
    };
    const before = await observe(s, credentials);
    // CONTROL: the observations differ between credentials, so equality below is not vacuous.
    expect(JSON.stringify(before.read)).not.toBe(JSON.stringify(before.session));
    const res = await s.call("POST", "/api/admin/principals/backfill", { token: ADMIN });
    expect(res.status).toBe(200);
    expect((s.table("credentials") as Json[]).length, "the backfill did write").toBeGreaterThan(0);
    const after = await observe(s, credentials);
    expect(after).toEqual(before);
  });
});

describe("#854 M1 the operator is audited as the svc_both service principal", () => {
  it("an admin action and the backfill itself are audited with actor service / svc_both, a real principal", async () => {
    const s = await setup();
    await s.mint("agent@skyphusion.org");
    await s.call("POST", "/api/admin/principals/backfill", { token: ADMIN });
    const rows = s.raw.prepare("SELECT actor_kind, actor_id, action FROM audit_log ORDER BY id").all() as Json[];
    expect(rows.map((r) => r.action)).toEqual(["identity.mint", "principals.backfill"]);
    expect(rows.every((r) => r.actor_kind === "service" && r.actor_id === "svc_both")).toBe(true);
    expect(s.raw.prepare("SELECT kind FROM principals WHERE id = 'svc_both'").get()).toEqual({ kind: "service" });
  });
});

describe("#854 M1 the backfill route is operator only (derived from the route table)", () => {
  const ROW = ROUTE_TABLE.find((r) => r.id === "admin-principals-backfill")!;
  it("the row exists, is admin-scoped and POST", () => {
    expect(ROW).toMatchObject({ method: "POST", path: "/api/admin/principals/backfill", scope: "admin" });
  });
  it("refuses every non-operator credential and an anonymous caller; admits the operator", async () => {
    const s = await setup();
    const a = await s.mint("agent@skyphusion.org", ["read", "send", "organize"]);
    s.preM2();
    for (const [who, token] of [["read", READ], ["send", SEND], ["registry", REGISTRY], ["runtime", a.token]] as const) {
      expect((await s.call("POST", ROW.path, { token })).status, who).toBe(403);
    }
    expect((await s.call("POST", ROW.path)).status).toBe(401);
    expect(s.table("credentials"), "nothing ran").toEqual([]);
    expect((await s.call("POST", ROW.path, { token: ADMIN })).status, "CONTROL: operator").toBe(200);
    expect(s.table("credentials").length).toBe(1);
  });
});
