import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { realEnv, putInbound } from "./realdb";

// #740 S5: a human manages delegation on their OWN address, and reads their own audit
// trail, from a webmail session. Real sqlite engine from schema.sql, through handleApi.

const OPERATOR = "test-token"; // realdb's static both token
const READ = "static-read-token-0123456789";
const SEND = "static-send-token-0123456789";
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const BOB = "bob@skyphusion.org";
const PASSWORD = "correct-horse-battery";
const ALICE_MSG = "alice-1@example.com";

type Json = Record<string, unknown>;
interface Session { cookie: string; csrf: string }

async function setup() {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native", POSTERN_API_TOKEN_READ: READ, POSTERN_API_TOKEN_SEND: SEND, AGENT_READ_SCOPE: "granted", DEFAULT_FROM: "noreply@skyphusion.org",
    EMAIL: { async send() { return { messageId: "p" }; } } });
  const call = async (method: string, path: string, opts: { token?: string; session?: Session; csrf?: boolean; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.session) {
      headers.cookie = opts.session.cookie;
      if (opts.csrf !== false) headers["x-postern-csrf"] = opts.session.csrf;
    }
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined || method === "GET" ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    let body: Json = {};
    try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = { raw: text }; }
    return { status: res.status, body, res };
  };
  const user = async (username: string) =>
    expect((await call("POST", "/api/admin/users", { token: OPERATOR, body: { username, password: PASSWORD } })).status).toBe(201);
  const signIn = async (username: string): Promise<Session> => {
    const res = await call("POST", "/api/session", { body: { username, password: PASSWORD } });
    expect(res.status).toBe(200);
    const get = (n: string) => res.res.headers.getSetCookie().find((c) => c.startsWith(n + "="))!.split(";")[0];
    return { cookie: `${get(SESSION_COOKIE)}; ${get(CSRF_COOKIE)}`, csrf: get(CSRF_COOKIE).slice(CSRF_COOKIE.length + 1) };
  };
  const agent = async (from: string, scopes = ["read", "send", "organize"], displayName?: string) => {
    const res = await call("POST", "/api/admin/identities", { token: OPERATOR, body: { from, scopes, ...(displayName ? { displayName } : {}) } });
    expect(res.status).toBe(201);
    return res.body as { id: string; token: string };
  };
  const grants = () => r.raw.prepare("SELECT id, grantee_id, address, created_by, revoked_at FROM delegation_grants ORDER BY created_at, id").all() as Json[];
  const principalOf = (u: string) => (r.raw.prepare("SELECT principal_id FROM credentials WHERE type = 'password' AND lookup = ? AND revoked_at IS NULL").get(u) as Json).principal_id as string;
  await user(ALICE);
  await user(BOB);
  await putInbound(r.env, r.ctx, { id: ALICE_MSG, from: "x@example.com", to: ALICE, body: "alice body" });
  await putInbound(r.env, r.ctx, { id: "bob-1@example.com", from: "x@example.com", to: BOB, body: "bob body" });
  return { ...r, call, signIn, agent, grants, principalOf };
}
type S = Awaited<ReturnType<typeof setup>>;

// One request per self-service row, as a session would send it.
const ROWS = ROUTE_TABLE.filter((r) => r.id.startsWith("self-"));
const REQUEST: Record<string, (agentId: string) => { method: string; path: string; body?: Json }> = {
  "self-delegation-grantees": () => ({ method: "GET", path: "/api/delegations/mine/grantees" }),
  "self-delegations-list": () => ({ method: "GET", path: "/api/delegations/mine" }),
  "self-delegations-grant": (id) => ({ method: "POST", path: "/api/delegations/mine", body: { granteeId: id, powers: ["read"] } }),
  "self-delegation-revoke": () => ({ method: "DELETE", path: `/api/delegations/mine/dlg_${"a".repeat(24)}` }),
  "self-audit": () => ({ method: "GET", path: "/api/audit/mine" }),
  "self-exclusions-list": () => ({ method: "GET", path: "/api/delegations/mine/exclusions" }),
  "self-exclusion-create": () => ({ method: "POST", path: "/api/delegations/mine/exclusions", body: { threadId: "no-such-thread@x" } }),
  "self-exclusion-delete": () => ({ method: "DELETE", path: `/api/delegations/mine/exclusions/exc_${"a".repeat(24)}` }),
};

describe("#740 S5 every self-service route is the human's door only (derived from the route table)", () => {
  it("the table has exactly these rows, all session-cookie (the loop is not vacuous)", () => {
    expect(ROWS.map((r) => r.id).sort()).toEqual(Object.keys(REQUEST).sort());
    expect(ROWS.every((r) => r.auth === "session-cookie")).toBe(true);
  });

  for (const row of ROWS) {
    it(`${row.id}: every Bearer is refused, no credential is 401, a CSRF-less write is refused; a session is served`, async () => {
      const s = await setup();
      const a = await s.agent("agent@skyphusion.org");
      const req = REQUEST[row.id](a.id);
      for (const [who, token] of [["operator", OPERATOR], ["read", READ], ["send", SEND], ["runtime agent", a.token]] as const) {
        const res = await s.call(req.method, req.path, { token, body: req.body });
        expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
      }
      expect((await s.call(req.method, req.path, { body: req.body })).status, "no credential").toBe(401);
      const alice = await s.signIn(ALICE);
      if (req.method !== "GET") {
        const noCsrf = await s.call(req.method, req.path, { session: alice, csrf: false, body: req.body });
        expect([noCsrf.status, noCsrf.body.error]).toEqual([403, "E_CSRF"]);
      }
      expect(s.grants().filter((g) => g.created_by !== "operator"), "nothing was granted by a refused request").toEqual([]);
      // CONTROL: the session is served (the grant is 201, the revoke of a missing id 404).
      const ok = await s.call(req.method, req.path, { session: alice, body: req.body });
      expect([200, 201, 404], JSON.stringify(ok.body)).toContain(ok.status);
      if (ok.status === 404) expect(ok.body.error).toBe("E_NOT_FOUND");
    });
  }

  it("a session minted before migration 0020 is asked to sign in again (401 E_REAUTH_REQUIRED)", async () => {
    const s = await setup();
    const alice = await s.signIn(ALICE);
    s.raw.prepare("UPDATE webmail_sessions SET principal_id = NULL").run();
    const res = await s.call("GET", "/api/delegations/mine", { session: alice });
    expect([res.status, res.body.error]).toEqual([401, "E_REAUTH_REQUIRED"]);
  });
});

describe("#740 S5 grantees: the roster a human may grant to", () => {
  it("lists LIVE agents only, each with exactly id, displayName and from", async () => {
    const s = await setup();
    const live = await s.agent("agent@skyphusion.org", ["read"], "Triage");
    const gone = await s.agent("old@skyphusion.org", ["read"]);
    await s.call("DELETE", `/api/admin/identities/${gone.id}`, { token: OPERATOR });
    const res = await s.call("GET", "/api/delegations/mine/grantees", { session: await s.signIn(ALICE) });
    expect(res.body.items).toEqual([{ id: live.id, displayName: "Triage", from: "agent@skyphusion.org" }]);
  });
});

describe("#740 S5 grant and revoke on my own address", () => {
  it("grants on MY address with my principal as grantor, every power allowed, audited as actor human", async () => {
    const s = await setup();
    const a = await s.agent("agent@skyphusion.org");
    const alice = await s.signIn(ALICE);
    const res = await s.call("POST", "/api/delegations/mine", { session: alice, body: { granteeId: a.id, powers: ["send_as", "quote", "organize"], label: "my assistant" } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const pid = s.principalOf(ALICE);
    expect(res.body).toMatchObject({ granteeId: a.id, address: ALICE, powers: ["read", "organize", "quote", "send_as"], createdBy: pid, label: "my assistant" });
    expect(s.raw.prepare("SELECT actor_kind, actor_id FROM audit_log WHERE action = 'delegation.grant' AND outcome = 'ok'").get()).toEqual({ actor_kind: "human", actor_id: pid });
  });

  it("refuses an address field, an unknown or revoked grantee, a duplicate and the agent's own address; nothing extra is stored", async () => {
    const s = await setup();
    const a = await s.agent("agent@skyphusion.org");
    const gone = await s.agent("old@skyphusion.org");
    await s.call("DELETE", `/api/admin/identities/${gone.id}`, { token: OPERATOR });
    const mirror = await s.agent(ALICE, ["read"]); // an identity whose From is alice herself
    const alice = await s.signIn(ALICE);
    const post = (body: Json) => s.call("POST", "/api/delegations/mine", { session: alice, body });
    expect((await post({ granteeId: a.id, powers: ["read"], address: BOB })).status, "an address field").toBe(400);
    expect((await post({ granteeId: `idn_${"0".repeat(24)}`, powers: ["read"] })).body.error).toBe("E_GRANTEE_INVALID");
    expect((await post({ granteeId: gone.id, powers: ["read"] })).body.error).toBe("E_GRANTEE_INVALID");
    expect((await post({ granteeId: mirror.id, powers: ["read"] })).status, "its own address").toBe(400);
    expect((await post({ granteeId: a.id, powers: ["admin"] })).status, "an unknown power").toBe(400);
    expect(s.grants(), "nothing stored by a refusal").toEqual([]);
    expect((await post({ granteeId: a.id, powers: ["read"] })).status).toBe(201);
    expect((await post({ granteeId: a.id, powers: ["organize"] })).status, "duplicate").toBe(409);
    expect(s.grants().length).toBe(1);
  });

  it("my list shows the grants on MY address only, the operator's included, live grantees only", async () => {
    const s = await setup();
    const a = await s.agent("agent@skyphusion.org", ["read"], "Triage");
    const b = await s.agent("agent2@skyphusion.org", ["read"]);
    const opOnAlice = await s.call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: a.id, address: ALICE, powers: ["read"] } });
    await s.call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: a.id, address: BOB, powers: ["read"] } });
    await s.call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: b.id, address: ALICE, powers: ["read"] } });
    await s.call("DELETE", `/api/admin/identities/${b.id}`, { token: OPERATOR }); // b's grant stops counting
    const res = await s.call("GET", "/api/delegations/mine", { session: await s.signIn(ALICE) });
    expect(res.body.items).toEqual([
      { id: opOnAlice.body.id, granteeId: a.id, granteeName: "Triage", granteeFrom: "agent@skyphusion.org", powers: ["read"], label: null, createdBy: "operator", createdAt: opOnAlice.body.createdAt },
    ]);
  });

  it("revokes a grant on MY address (idempotent); another address's grant is the same 404 as a missing one and stays", async () => {
    const s = await setup();
    const a = await s.agent("agent@skyphusion.org");
    const onBob = await s.call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: a.id, address: BOB, powers: ["read"] } });
    const alice = await s.signIn(ALICE);
    const mine = await s.call("POST", "/api/delegations/mine", { session: alice, body: { granteeId: a.id, powers: ["read"] } });
    const other = await s.call("DELETE", `/api/delegations/mine/${onBob.body.id}`, { session: alice });
    const missing = await s.call("DELETE", `/api/delegations/mine/dlg_${"b".repeat(24)}`, { session: alice });
    expect([other.status, other.body]).toEqual([missing.status, missing.body]);
    expect(other.status).toBe(404);
    expect((s.raw.prepare("SELECT revoked_at FROM delegation_grants WHERE id = ?").get(onBob.body.id as string) as Json).revoked_at).toBeNull();
    const first = await s.call("DELETE", `/api/delegations/mine/${mine.body.id}`, { session: alice });
    expect(first.body).toMatchObject({ ok: true, revoked: 1, alreadyRevoked: false });
    expect((await s.call("DELETE", `/api/delegations/mine/${mine.body.id}`, { session: alice })).body).toMatchObject({ revoked: 0, alreadyRevoked: true });
    const actors = s.raw.prepare("SELECT DISTINCT actor_kind FROM audit_log WHERE action = 'delegation.revoke'").all() as Json[];
    expect(actors).toEqual([{ actor_kind: "human" }]);
  });
});

describe("#740 S5 my audit trail", () => {
  async function activity(s: S) {
    const a = await s.agent("agent@skyphusion.org");
    const alice = await s.signIn(ALICE);
    const bob = await s.signIn(BOB);
    // Alice grants organize + quote; the agent then acts on her mail (S2, S3).
    const g = await s.call("POST", "/api/delegations/mine", { session: alice, body: { granteeId: a.id, powers: ["organize", "quote"] } });
    expect(g.status).toBe(201);
    expect((await s.call("POST", "/api/messages/flags", { token: a.token, body: { ids: [ALICE_MSG], set: { flagged: true } } })).body.updated).toBe(1);
    expect((await s.call("POST", "/api/send", { token: a.token, body: { to: "friend@example.net", text: "fyi", forwardMessageId: ALICE_MSG } })).status).toBe(200);
    // Bob's address gets activity too, which Alice must never see.
    const gb = await s.call("POST", "/api/delegations/mine", { session: bob, body: { granteeId: a.id, powers: ["organize"] } });
    expect((await s.call("POST", "/api/messages/flags", { token: a.token, body: { ids: ["bob-1@example.com"], set: { flagged: true } } })).body.updated).toBe(1);
    await s.call("DELETE", `/api/delegations/mine/${g.body.id}`, { session: alice });
    return { a, alice, bob, aliceGrant: g.body.id as string, bobGrant: gb.body.id as string };
  }

  it("shows the rows about MY address, newest first, and none about anyone else's", async () => {
    const s = await setup();
    const { a, alice, bob, aliceGrant, bobGrant } = await activity(s);
    const mine = await s.call("GET", "/api/audit/mine", { session: alice });
    const items = mine.body.items as Json[];
    expect(items.map((i) => i.action)).toEqual(["delegation.revoke", "delegation.quote", "delegation.organize", "delegation.grant"]);
    expect(items.map((i) => (i.actor as Json).kind)).toEqual(["human", "agent", "agent", "human"]);
    expect((items[1].actor as Json).id).toBe(a.id);
    expect(JSON.stringify(items), "nothing about bob").not.toContain(BOB);
    expect(JSON.stringify(items)).not.toContain(bobGrant);
    const theirs = await s.call("GET", "/api/audit/mine", { session: bob });
    const bobItems = theirs.body.items as Json[];
    expect(bobItems.map((i) => i.action)).toEqual(["delegation.organize", "delegation.grant"]);
    expect(JSON.stringify(bobItems), "nothing about alice").not.toContain(aliceGrant);
    expect(JSON.stringify(bobItems)).not.toContain(ALICE);
  });

  it("pages by keyset: limit=1 walks the same rows, and the last page's cursor is null", async () => {
    const s = await setup();
    const { alice } = await activity(s);
    const all = ((await s.call("GET", "/api/audit/mine", { session: alice })).body.items as Json[]).map((i) => i.id);
    const walked: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await s.call("GET", `/api/audit/mine?limit=1${cursor ? `&cursor=${cursor}` : ""}`, { session: alice });
      walked.push(...(page.body.items as Json[]).map((i) => i.id));
      cursor = page.body.cursor as string | null;
    } while (cursor);
    expect(walked).toEqual(all);
    expect((await s.call("GET", "/api/audit/mine?cursor=nope", { session: alice })).status).toBe(400);
  });

  it("an empty trail is an answer, not an error", async () => {
    const s = await setup();
    const res = await s.call("GET", "/api/audit/mine", { session: await s.signIn(ALICE) });
    expect(res.body).toEqual({ ok: true, items: [], cursor: null });
  });
});

describe("#740 S5 a human-made grant is enforced exactly like an operator's", () => {
  it("self-grant organize: the agent may flag my mail; after I revoke, it may not", async () => {
    const s = await setup();
    const a = await s.agent("agent@skyphusion.org");
    const alice = await s.signIn(ALICE);
    const flag = () => s.call("POST", "/api/messages/flags", { token: a.token, body: { ids: [ALICE_MSG], set: { flagged: true } } });
    expect((await flag()).body.updated, "no grant yet").toBe(0);
    const g = await s.call("POST", "/api/delegations/mine", { session: alice, body: { granteeId: a.id, powers: ["organize"] } });
    expect((await flag()).body.updated).toBe(1);
    await s.call("DELETE", `/api/delegations/mine/${g.body.id}`, { session: alice });
    s.raw.prepare("UPDATE messages SET flagged = 0").run();
    expect((await flag()).body.updated, "revoked").toBe(0);
  });
});
