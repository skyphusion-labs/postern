import { describe, it, expect, vi, afterEach } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { realEnv, putInbound } from "./realdb";
import { activeDelegations } from "./src/delegations";

// #740 S2, the READ half: AGENT_READ_SCOPE and the read a grant adds. Real sqlite engine
// built from schema.sql, through the real handleApi.

const ADMIN = "test-token"; // realdb's static both token
const AGENT = "agent@skyphusion.org";
const HUMAN = "conrad@skyphusion.org";
const ORIGIN = "https://postern.example";
const HUMAN_MSG = "<human-1@example.com>";
const AGENT_MSG = "<agent-1@example.com>";
// A second own message, so the agent's own inbox count (2) differs from the human's (1)
// and the folders probe can tell the two mailboxes apart.
const AGENT_MSG2 = "<agent-2@example.com>";

type Json = Record<string, unknown>;

// The one stored attachment (on HUMAN_MSG), served by a minimal R2 stand-in, so the
// attachment sub-route has a positive case and its probe can go red.
const ATT_KEY = "att/human-1/0";
const ATTACHMENTS = {
  async get(key: string) {
    return key === ATT_KEY ? { body: new TextEncoder().encode("ATT-BYTES") } : null;
  },
};

async function setup(flag?: string) {
  const r = realEnv({ ATTACHMENTS, ...(flag === undefined ? {} : { AGENT_READ_SCOPE: flag }) });
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await handleApi(
      new Request(ORIGIN + path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    // An attachment answers with its bytes, not JSON; only a JSON body is parsed.
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    return { status: res.status, text, body: (text && isJson ? JSON.parse(text) : {}) as Json };
  };
  await putInbound(r.env, r.ctx, { id: HUMAN_MSG, from: "x@example.com", to: HUMAN, subject: "zebraquartz invoice" });
  await putInbound(r.env, r.ctx, { id: AGENT_MSG, from: "y@example.com", to: AGENT, subject: "zebraquartz agent" });
  await putInbound(r.env, r.ctx, { id: AGENT_MSG2, from: "y@example.com", to: AGENT, subject: "second", date: "2026-02-01T00:00:00.000Z" });
  r.raw
    .prepare("INSERT INTO attachments (message_id, filename, mime, size, r2_key) VALUES (?, ?, ?, ?, ?)")
    .run(HUMAN_MSG, "invoice.pdf", "application/pdf", 9, ATT_KEY);
  const minted = await call("POST", "/api/admin/identities", ADMIN, { from: AGENT, scopes: ["read", "organize"] });
  expect(minted.status, minted.text).toBe(201);
  const agent = minted.body as { id: string; token: string };
  const grant = async (powers: string[] = ["read"], address = HUMAN) => {
    const res = await call("POST", "/api/admin/delegations", ADMIN, { granteeId: agent.id, address, powers });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const revoke = async (id: string) => expect((await call("DELETE", `/api/admin/delegations/${id}`, ADMIN)).status).toBe(200);
  const listed = await call("GET", "/api/messages", ADMIN);
  const threadOf = (id: string) => ((listed.body.items as Json[]).find((m) => m.messageId === id)!.threadId as string);
  return { ...r, call, agent, grant, revoke, threadOf };
}

type S = Awaited<ReturnType<typeof setup>>;
const ids = (items: unknown) => (items as Json[]).map((m) => (m.message ? (m.message as Json).messageId : m.messageId));

// Every read-scoped route, classified. A route that reads MAIL gets a probe that answers
// "does this credential see HUMAN_MSG through this route"; the others are named with the
// reason they are not mail reads. A new read route fails the coverage test below until it
// is classified here, so the narrowing cannot silently miss one.
const MAIL_PROBES: Record<string, (s: S, token: string, id: string) => Promise<boolean>> = {
  "messages-list": async (s, t, id) => ids((await s.call("GET", `/api/messages?to=${HUMAN}`, t)).body.items).includes(id),
  search: async (s, t, id) =>
    ids((await s.call("GET", `/api/search?q=zebraquartz&mode=substr&field=subject&to=${HUMAN}`, t)).body.items ?? []).includes(id),
  folders: async (s, t) => {
    const res = await s.call("GET", `/api/folders?to=${HUMAN}`, t);
    const inbox = (res.body.folders as Json[]).find((f) => f.id === "inbox");
    // The human mailbox holds exactly 1; the agent's own holds 2.
    return inbox?.count === 1;
  },
  "message-get": async (s, t, id) => (await s.call("GET", `/api/messages/${encodeURIComponent(id)}`, t)).status === 200,
  "thread-get": async (s, t, id) =>
    ids((await s.call("GET", `/api/threads/${encodeURIComponent(s.threadOf(id))}`, t)).body.messages ?? []).includes(id),
};
// Sub-routes a route row covers (match: prefix) that read mail by a different handler.
// Probed with the same arms; they are not separate ROUTE_TABLE rows.
const SUBROUTE_PROBES: Record<string, (s: S, token: string, id: string) => Promise<boolean>> = {
  "message-get /attachments/{i}": async (s, t, id) =>
    (await s.call("GET", `/api/messages/${encodeURIComponent(id)}/attachments/0`, t)).status === 200,
};
const NOT_MAIL: Record<string, string> = {
  whoami: "reports the scope; asserted on its own below",
  "recipients-recent": "the bound identity's OWN outbound recipients; no grant widens it",
  mobileconfig: "a setup profile for the bound identity; carries no mail",
};

describe("#740 S2 every read route is classified (derived from the route table)", () => {
  it("each read-scoped row is either a mail probe or named as not a mail read", () => {
    const readRows = ROUTE_TABLE.filter((r) => r.scope === "read").map((r) => r.id).sort();
    expect(readRows).toEqual([...Object.keys(MAIL_PROBES), ...Object.keys(NOT_MAIL)].sort());
    expect(Object.keys(MAIL_PROBES).length, "the probe loop below is not vacuous").toBe(5);
  });
});

describe("#740 S2 AGENT_READ_SCOPE=granted narrows each mail read route to own plus granted", () => {
  const ALL_PROBES = { ...MAIL_PROBES, ...SUBROUTE_PROBES };
  for (const id of Object.keys(ALL_PROBES)) {
    it(`${id}: hidden without a grant, visible with read, hidden after revoke; operator and own-mail controls`, async () => {
      const s = await setup("granted");
      const probe = ALL_PROBES[id];
      // CONTROL (operator): the message is there and this probe can see it.
      expect(await probe(s, ADMIN, HUMAN_MSG), "operator sees the human message").toBe(true);
      expect(await probe(s, s.agent.token, HUMAN_MSG), "no grant: hidden").toBe(false);
      const g = await s.grant(["read"]);
      expect(await probe(s, s.agent.token, HUMAN_MSG), "read grant: visible").toBe(true);
      await s.revoke(g);
      expect(await probe(s, s.agent.token, HUMAN_MSG), "revoked: hidden on the next request").toBe(false);
    });
  }

  it("every power implies read: an organize grant also opens the human message", async () => {
    const s = await setup("granted");
    await s.grant(["organize"]);
    expect((await s.call("GET", `/api/messages/${encodeURIComponent(HUMAN_MSG)}`, s.agent.token)).status).toBe(200);
  });

  it("a grant on ANOTHER address opens nothing here", async () => {
    const s = await setup("granted");
    await s.grant(["read"], "someone@skyphusion.org");
    expect((await s.call("GET", `/api/messages/${encodeURIComponent(HUMAN_MSG)}`, s.agent.token)).status).toBe(404);
  });

  it("the agent still reads its OWN mail with no grant at all (bare list and get)", async () => {
    const s = await setup("granted");
    const list = await s.call("GET", "/api/messages", s.agent.token);
    expect(ids(list.body.items)).toEqual([AGENT_MSG, AGENT_MSG2]);
    expect(list.body.identityScope).toEqual({ kind: "member", addresses: [AGENT] });
    expect((await s.call("GET", `/api/messages/${encodeURIComponent(AGENT_MSG)}`, s.agent.token)).status).toBe(200);
  });

  it("a granted to= view reports the granted address as its scope, and a bare list stays own", async () => {
    const s = await setup("granted");
    await s.grant(["read"]);
    const view = await s.call("GET", `/api/messages?to=${HUMAN}`, s.agent.token);
    expect(ids(view.body.items)).toEqual([HUMAN_MSG]);
    expect(view.body.identityScope).toEqual({ kind: "member", addresses: [HUMAN] });
    const bare = await s.call("GET", "/api/messages", s.agent.token);
    expect(ids(bare.body.items)).toEqual([AGENT_MSG, AGENT_MSG2]);
  });
});

describe("#740 S2 the flag's values", () => {
  afterEach(() => vi.restoreAllMocks());

  for (const flag of [undefined, "estate"]) {
    it(`${flag === undefined ? "UNSET" : flag}: the agent reads the estate with no grant (upgrade keeps #718)`, async () => {
      const s = await setup(flag);
      expect((await s.call("GET", `/api/messages/${encodeURIComponent(HUMAN_MSG)}`, s.agent.token)).status).toBe(200);
      const list = await s.call("GET", "/api/messages", s.agent.token);
      expect(ids(list.body.items).sort()).toEqual([AGENT_MSG, AGENT_MSG2, HUMAN_MSG].sort());
      expect(list.body.identityScope).toEqual({ kind: "estate" });
    });
  }

  for (const flag of ["Granted", "", "bogus"]) {
    it(`an unknown value (${JSON.stringify(flag)}) fails closed to granted and logs a config error`, async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const s = await setup(flag);
      expect((await s.call("GET", `/api/messages/${encodeURIComponent(HUMAN_MSG)}`, s.agent.token)).status).toBe(404);
      expect(err.mock.calls.some((c) => String(c[0]).includes("AGENT_READ_SCOPE"))).toBe(true);
    });
  }

  it("granted changes nothing for the static operator read token (control)", async () => {
    const s = await setup("granted");
    expect((await s.call("GET", `/api/messages/${encodeURIComponent(HUMAN_MSG)}`, ADMIN)).status).toBe(200);
  });
});

describe("#740 S2 whoami reports the grants and the narrowed scope", () => {
  it("lists active grants with their powers, and drops a revoked one", async () => {
    const s = await setup("granted");
    const before = await s.call("GET", "/api/whoami", s.agent.token);
    expect(before.body.delegations).toEqual([]);
    expect(before.body.identityScope).toEqual({ kind: "member", addresses: [AGENT] });
    const g = await s.grant(["organize"]);
    const after = await s.call("GET", "/api/whoami", s.agent.token);
    expect(after.body.delegations).toEqual([{ id: g, address: HUMAN, powers: ["read", "organize"] }]);
    await s.revoke(g);
    expect((await s.call("GET", "/api/whoami", s.agent.token)).body.delegations).toEqual([]);
  });

  it("under estate the scope says estate, and the grants are still listed", async () => {
    const s = await setup();
    const g = await s.grant(["read"]);
    const me = await s.call("GET", "/api/whoami", s.agent.token);
    expect(me.body.identityScope).toEqual({ kind: "estate" });
    expect(me.body.delegations).toEqual([{ id: g, address: HUMAN, powers: ["read"] }]);
  });

  it("a static token holds no grants (an empty list, never absent)", async () => {
    const s = await setup("granted");
    expect((await s.call("GET", "/api/whoami", ADMIN)).body.delegations).toEqual([]);
  });
});

describe("#740 S2 a grant counts only while its grantee identity is live", () => {
  it("revoking the IDENTITY cuts its delegated read and organize on the next request; a live grantee keeps them (control)", async () => {
    const s = await setup("granted");
    const g = await s.grant(["organize"]);
    // A second identity with the same kind of grant: the control that stays live.
    const other = await s.call("POST", "/api/admin/identities", ADMIN, { from: "agent2@skyphusion.org", scopes: ["read", "organize"] });
    const otherId = other.body.id as string;
    const otherToken = other.body.token as string;
    expect((await s.call("POST", "/api/admin/delegations", ADMIN, { granteeId: otherId, address: HUMAN, powers: ["organize"] })).status).toBe(201);
    const get = (t: string) => s.call("GET", `/api/messages/${encodeURIComponent(HUMAN_MSG)}`, t);
    const flag = (t: string) => s.call("POST", "/api/messages/flags", t, { ids: [HUMAN_MSG], set: { flagged: true } });
    expect((await get(s.agent.token)).status, "before: delegated read works").toBe(200);

    expect((await s.call("DELETE", `/api/admin/identities/${s.agent.id}`, ADMIN)).status).toBe(200);
    expect((await get(s.agent.token)).status, "revoked identity: read refused").toBe(401);
    expect((await flag(s.agent.token)).status, "revoked identity: organize refused").toBe(401);
    expect((s.raw.prepare("SELECT flagged FROM messages WHERE message_id = ?").get(HUMAN_MSG) as Json).flagged).toBe(0);
    // The grant ROW is not rewritten by the identity revoke; it simply stops counting.
    expect((s.raw.prepare("SELECT revoked_at FROM delegation_grants WHERE id = ?").get(g) as Json).revoked_at).toBe(null);

    // CONTROL: the live grantee keeps both powers on the same address.
    expect((await get(otherToken)).status).toBe(200);
    expect((await flag(otherToken)).body.updated).toBe(1);
  });

  it("the grant lookup itself returns nothing for a revoked grantee whose grant row is still active", async () => {
    // The API test above is refused at authentication already, since a revoked token no
    // longer resolves. This pins the lookup on its own, so a grant can never authorize
    // through any path that names a revoked grantee id.
    const s = await setup("granted");
    await s.grant(["organize"]);
    expect((await activeDelegations(s.env, s.agent.id)).grants.length, "live: counts").toBe(1);
    expect((await s.call("DELETE", `/api/admin/identities/${s.agent.id}`, ADMIN)).status).toBe(200);
    expect(await activeDelegations(s.env, s.agent.id)).toEqual({ read: [], organize: [], quote: [], grants: [] });
  });
});
