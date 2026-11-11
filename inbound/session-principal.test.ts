import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
// node URL, not the workers-types global: a file URL fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { backfillPrincipals } from "./src/principals";
import { grant, revoke, type Grantor } from "./src/delegations";
import { resolveSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { realEnv } from "./realdb";

// #854 M2, only the parts #740 S5 needs: a stable principal id on every webmail session,
// and a grant / audit path that can name a HUMAN principal as grantor and actor. Real
// sqlite engine from schema.sql, through the real handleApi.

const ADMIN = "test-token"; // realdb's static both token
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const BOB = "bob@skyphusion.org";
const PASSWORD = "correct-horse-battery";

type Json = Record<string, unknown>;

async function setup() {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native" });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json, res };
  };
  const user = async (username: string) =>
    expect((await call("POST", "/api/admin/users", { token: ADMIN, body: { username, password: PASSWORD } })).status).toBe(201);
  const signIn = async (username = ALICE) => {
    const res = await call("POST", "/api/session", { body: { username, password: PASSWORD } });
    expect(res.status).toBe(200);
    const raw = res.res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + "="))!.split(";")[0].slice(SESSION_COOKIE.length + 1);
    const csrf = res.res.headers.getSetCookie().find((c) => c.startsWith(CSRF_COOKIE + "="))!.split(";")[0].slice(CSRF_COOKIE.length + 1);
    return { raw, csrf };
  };
  const sessionPrincipals = () => (r.raw.prepare("SELECT principal_id FROM webmail_sessions ORDER BY rowid").all() as Json[]).map((x) => x.principal_id);
  const principalOf = (username: string) =>
    (r.raw.prepare("SELECT principal_id FROM credentials WHERE type = 'password' AND lookup = ? AND revoked_at IS NULL").get(username) as Json | undefined)?.principal_id;
  return { ...r, call, user, signIn, sessionPrincipals, principalOf };
}

describe("#854 M2 migration 0020 matches schema.sql", () => {
  it("adds principal_id to webmail_sessions, as schema.sql declares it", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["0004_smtp_credentials.sql", "0010_webmail_sessions.sql", "0015_human_accounts.sql", "0020_session_principal.sql"]) {
      db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), "utf8"));
    }
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    const cols = (d: DatabaseSync) => (d.prepare("PRAGMA table_info(webmail_sessions)").all() as Json[]).map((c) => c.name).sort();
    expect(cols(db)).toContain("principal_id");
    expect(cols(fresh)).toEqual(cols(db));
  });
});

describe("#854 M2 every webmail session names its human principal", () => {
  it("is the backfill's principal for that login, and the same across sign-ins", async () => {
    const s = await setup();
    await s.user(ALICE);
    await backfillPrincipals(s.env);
    const expected = s.principalOf(ALICE);
    expect(String(expected)).toMatch(/^prn_[0-9a-f]{24}$/);
    const one = await s.signIn();
    const two = await s.signIn();
    expect(s.sessionPrincipals()).toEqual([expected, expected]);
    expect((await resolveSession(s.env, one.raw))?.principalId).toBe(expected);
    expect((await resolveSession(s.env, two.raw))?.principalId).toBe(expected);
  });

  it("a login whose principal does not exist yet (written before dual-write) gets one at sign-in, and the next backfill agrees", async () => {
    const s = await setup();
    await s.user(ALICE);
    // Model a user row written before dual-write (#854 M2): no principal yet.
    s.raw.exec("DELETE FROM credentials; DELETE FROM principal_addresses; DELETE FROM principals WHERE kind <> 'service';");
    expect(s.principalOf(ALICE), "no principal yet").toBeUndefined();
    await s.signIn();
    const minted = s.principalOf(ALICE);
    expect(String(minted)).toMatch(/^prn_/);
    expect(s.sessionPrincipals()).toEqual([minted]);
    const report = await backfillPrincipals(s.env);
    expect(report.humans.added, "the backfill does not make a second principal").toBe(0);
    expect(s.principalOf(ALICE)).toBe(minted);
    expect((s.raw.prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'human'").get() as Json).n).toBe(1);
  });

  it("two people get two principals (CONTROL: the id is per person, not per deploy)", async () => {
    const s = await setup();
    await s.user(ALICE);
    await s.user(BOB);
    await s.signIn(ALICE);
    await s.signIn(BOB);
    const [a, b] = s.sessionPrincipals();
    expect(a).not.toBe(b);
  });

  it("a session minted before migration 0020 still resolves, with principalId null (upgrade-safe)", async () => {
    const s = await setup();
    await s.user(ALICE);
    const { raw } = await s.signIn();
    s.raw.prepare("UPDATE webmail_sessions SET principal_id = NULL").run();
    const res = await resolveSession(s.env, raw);
    expect(res?.identity.from).toBe(ALICE);
    expect(res?.principalId).toBeNull();
  });

  it("the session behaves exactly as before: whoami is unchanged by the new column", async () => {
    const s = await setup();
    await s.user(ALICE);
    const { raw, csrf } = await s.signIn();
    const headers = { cookie: `${SESSION_COOKIE}=${raw}; ${CSRF_COOKIE}=${csrf}` };
    const before = await s.call("GET", "/api/session", { headers });
    s.raw.prepare("UPDATE webmail_sessions SET principal_id = NULL").run();
    const nulled = await s.call("GET", "/api/session", { headers });
    expect(before.status).toBe(200);
    expect(nulled.body).toEqual(before.body);
  });
});

describe("#854 M2 a grant and its audit row can name a HUMAN principal", () => {
  async function withAgent(s: Awaited<ReturnType<typeof setup>>) {
    const res = await s.call("POST", "/api/admin/identities", { token: ADMIN, body: { from: "agent@skyphusion.org", scopes: ["read"] } });
    return res.body.id as string;
  }
  const req = (body: Json) => new Request(ORIGIN + "/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("a human grantor's grant is created_by its prn_ id, pinned to its own address, audited as actor human", async () => {
    const s = await setup();
    await s.user(ALICE);
    await s.signIn();
    const pid = String(s.principalOf(ALICE));
    const agent = await withAgent(s);
    const human: Grantor = { actor: { kind: "human", id: pid }, createdBy: pid, ownAddress: ALICE };
    const res = await grant(req({ granteeId: agent, powers: ["organize"] }), s.env, human);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ address: ALICE, createdBy: pid, powers: ["read", "organize"] });
    expect(s.raw.prepare("SELECT created_by, address FROM delegation_grants WHERE id = ?").get(body.id as string)).toEqual({ created_by: pid, address: ALICE });
    const audit = s.raw.prepare("SELECT actor_kind, actor_id, action FROM audit_log WHERE action = 'delegation.grant'").get() as Json;
    expect(audit).toEqual({ actor_kind: "human", actor_id: pid, action: "delegation.grant" });
  });

  it("a human grantor cannot name an address, and cannot revoke another address's grant (404, as a missing id)", async () => {
    const s = await setup();
    await s.user(ALICE);
    const agent = await withAgent(s);
    const human: Grantor = { actor: { kind: "human", id: "prn_" + "a".repeat(24) }, createdBy: "prn_" + "a".repeat(24), ownAddress: ALICE };
    await expect(grant(req({ granteeId: agent, powers: ["read"], address: BOB }), s.env, human)).rejects.toMatchObject({ status: 400 });
    // An operator grant on BOB's address.
    const op = await s.call("POST", "/api/admin/delegations", { token: ADMIN, body: { granteeId: agent, address: BOB, powers: ["read"] } });
    expect(op.status).toBe(201);
    await expect(revoke(s.env, op.body.id as string, human)).rejects.toMatchObject({ status: 404 });
    expect((s.raw.prepare("SELECT revoked_at FROM delegation_grants WHERE id = ?").get(op.body.id as string) as Json).revoked_at).toBeNull();
    // CONTROL: the operator default still revokes it.
    expect((await revoke(s.env, op.body.id as string)).status).toBe(200);
  });

  it("CONTROL: the operator default is unchanged (created_by operator, actor service / svc_both)", async () => {
    const s = await setup();
    const agent = await withAgent(s);
    const op = await s.call("POST", "/api/admin/delegations", { token: ADMIN, body: { granteeId: agent, address: ALICE, powers: ["read"] } });
    expect(op.body.createdBy).toBe("operator");
    expect(s.raw.prepare("SELECT actor_kind, actor_id FROM audit_log WHERE action = 'delegation.grant'").get()).toEqual({ actor_kind: "service", actor_id: "svc_both" });
  });
});
