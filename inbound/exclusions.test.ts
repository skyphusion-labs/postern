import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import * as store from "./src/store";
import { realEnv, putInbound, AUTH } from "./realdb";

// #853: a human owner marks a thread human-only. From then on no AGENT reads, quotes,
// organizes or replies into the owner's mail in it, under either AGENT_READ_SCOPE value.
// The agent's own mail, human sessions and static tokens are untouched. Real sqlite engine
// from schema.sql, through the real handleApi.

const OPERATOR = "test-token"; // realdb's static both token
const ORIGIN = "https://postern.example";
const HUMAN = "conrad@skyphusion.org";
const BOB = "bob@skyphusion.org";
const AGENT = "agent@skyphusion.org";
const PASSWORD = "correct-horse-battery";
const HUMAN_MSG = "human-1@example.com"; // the marked thread's root, delivered to HUMAN only
const SHARED_MSG = "shared-1@example.com"; // same thread, delivered to HUMAN AND the agent
const OTHER_MSG = "human-2@example.com"; // HUMAN's mail in an UNMARKED thread
const BOB_MSG = "bob-1@example.com"; // a thread with none of HUMAN's mail
const ATT_KEY = "att/human-1/0";
const QUEUE = "support@skyphusion.org"; // a role queue HUMAN and BOB are both members of

type Json = Record<string, unknown>;
interface Session { cookie: string; csrf: string }

const ATTACHMENTS = {
  async get(key: string) {
    return key === ATT_KEY ? { body: new TextEncoder().encode("ATT-BYTES") } : null;
  },
};
// Semantic search stand-ins: every stored message is a candidate, so the only thing that
// can drop HUMAN_MSG from a semantic or hybrid page is a filter.
const AI = { async run() { return { data: [[0.1, 0.2, 0.3]] }; } };

async function setup(flag: "granted" | "estate", roles = `${QUEUE}=${HUMAN}+${BOB}`) {
  const ids = [HUMAN_MSG, SHARED_MSG, OTHER_MSG, BOB_MSG];
  const VECTORIZE = {
    async query() {
      return { matches: ids.map((id, i) => ({ id: `${id}#0`, score: 0.9 - i * 0.01, metadata: { message_id: id } })) };
    },
    async upsert() { return {}; },
    async deleteByIds() { return {}; },
  };
  const r = realEnv({
    ATTACHMENTS, AI, VECTORIZE, AGENT_READ_SCOPE: flag, POSTERN_VIEWER_ROLES: roles, WEBMAIL_AUTH_BACKEND: "native", DEFAULT_FROM: "noreply@skyphusion.org",
    EMAIL: { async send() { return { messageId: "p" }; } },
  });
  const call = async (method: string, path: string, opts: { token?: string; session?: Session; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.session) {
      headers.cookie = opts.session.cookie;
      headers["x-postern-csrf"] = opts.session.csrf;
    }
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined || method === "GET" ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    return { status: res.status, text, body: (text && isJson ? JSON.parse(text) : {}) as Json };
  };
  for (const username of [HUMAN, BOB]) {
    expect((await call("POST", "/api/admin/users", { token: OPERATOR, body: { username, password: PASSWORD } })).status).toBe(201);
  }
  const signIn = async (username: string): Promise<Session> => {
    const res = await handleApi(
      new Request(ORIGIN + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) }),
      r.env,
      r.ctx,
    );
    expect(res.status).toBe(200);
    const get = (n: string) => res.headers.getSetCookie().find((c) => c.startsWith(n + "="))!.split(";")[0];
    return { cookie: `${get(SESSION_COOKIE)}; ${get(CSRF_COOKIE)}`, csrf: get(CSRF_COOKIE).slice(CSRF_COOKIE.length + 1) };
  };
  await putInbound(r.env, r.ctx, { id: HUMAN_MSG, from: "x@example.com", to: HUMAN, subject: "zebraquartz invoice", date: "2026-02-01T00:00:00.000Z" });
  await store.put(r.env, {
    messageId: SHARED_MSG, direction: "inbound", from: "x@example.com", to: `${HUMAN}, ${AGENT}`, subject: "Re: zebraquartz invoice",
    date: "2026-02-02T00:00:00.000Z", inReplyTo: HUMAN_MSG, references: [HUMAN_MSG], bodyText: "shared body", auth: AUTH, trusted: false,
    deliveredTo: [HUMAN, AGENT],
  }, r.ctx);
  await putInbound(r.env, r.ctx, { id: OTHER_MSG, from: "x@example.com", to: HUMAN, subject: "zebraquartz other", date: "2026-02-03T00:00:00.000Z" });
  await putInbound(r.env, r.ctx, { id: BOB_MSG, from: "x@example.com", to: BOB, subject: "zebraquartz bob", date: "2026-02-04T00:00:00.000Z" });
  r.raw.prepare("INSERT INTO attachments (message_id, filename, mime, size, r2_key) VALUES (?, ?, ?, ?, ?)")
    .run(HUMAN_MSG, "invoice.pdf", "application/pdf", 9, ATT_KEY);
  const minted = await call("POST", "/api/admin/identities", { token: OPERATOR, body: { from: AGENT, scopes: ["read", "send", "organize"] } });
  expect(minted.status, minted.text).toBe(201);
  const agent = (minted.body as { token: string; id: string });
  const granted = await call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: agent.id, address: HUMAN, powers: ["read", "organize", "quote", "send_as"] } });
  expect(granted.status, granted.text).toBe(201);
  const threadOf = (id: string) => (r.raw.prepare("SELECT COALESCE(thread_id, message_id) AS t FROM messages WHERE message_id = ?").get(id) as Json).t as string;
  const owner = await signIn(HUMAN);
  const mark = async (threadId = threadOf(HUMAN_MSG), session = owner) =>
    call("POST", "/api/delegations/mine/exclusions", { session, body: { threadId } });
  const unmark = async (id: string, session = owner) => call("DELETE", `/api/delegations/mine/exclusions/${id}`, { session });
  // Another agent identity holding exactly these grants.
  const agentWith = async (from: string, grants: Array<{ address: string; powers: string[] }>) => {
    const res = await call("POST", "/api/admin/identities", { token: OPERATOR, body: { from, scopes: ["read", "send", "organize"] } });
    expect(res.status, res.text).toBe(201);
    const a = res.body as { token: string; id: string };
    for (const g of grants) {
      const gr = await call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: a.id, ...g } });
      expect(gr.status, gr.text).toBe(201);
    }
    return a;
  };
  // Every SQL text the store prepares from now on, to see which plan a request ran.
  const recordSql = () => {
    const log: string[] = [];
    const db = r.env.DB as unknown as { prepare(sql: string): unknown };
    const orig = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      log.push(sql);
      return orig(sql);
    };
    return log;
  };
  const audit = () => r.raw.prepare("SELECT actor_kind, actor_id, action, target_kind, target_id, outcome, detail FROM audit_log ORDER BY id").all() as Json[];
  return { ...r, call, signIn, agent, agentWith, recordSql, threadOf, owner, mark, unmark, audit, vectorIds: ids };
}
type S = Awaited<ReturnType<typeof setup>>;
const surfaces = (items: unknown, id: string) =>
  ((items ?? []) as Json[]).some((h) => (h.message as Json)?.messageId === id || (((h.similar as Json | undefined)?.ids as string[] | undefined) ?? []).includes(id));
const idsOf = (items: unknown) => ((items ?? []) as Json[]).map((m) => (m.message ? (m.message as Json).messageId : m.messageId));

// Every path an agent reaches the owner's mail by, as "does this credential reach `id`".
// Writes are probed on a FRESH setup each time (see the loop), so one probe never changes
// what another one sees.
type Probe = (s: S, token: string, id: string) => Promise<boolean>;
const PROBES: Record<string, Probe> = {
  "messages-list": async (s, t, id) => idsOf((await s.call("GET", `/api/messages?to=${HUMAN}`, { token: t })).body.items).includes(id),
  "messages-list countOnly": async (s, t, id) => {
    // The thread holds `id` plus SHARED_MSG (the agent's own), so 2 means `id` is counted.
    const res = await s.call("GET", `/api/messages?to=${HUMAN}&thread=${encodeURIComponent(s.threadOf(id))}&countOnly=1`, { token: t });
    return res.body.total === 2;
  },
  "search fts": async (s, t, id) => idsOf((await s.call("GET", `/api/search?q=zebraquartz&mode=fts&to=${HUMAN}`, { token: t })).body.items).includes(id),
  "search substr": async (s, t, id) =>
    idsOf((await s.call("GET", `/api/search?q=zebraquartz&mode=substr&field=subject&to=${HUMAN}`, { token: t })).body.items).includes(id),
  // #813: semantic folds template families by default, so "reached" counts the id as a hit
  // OR inside a hit's `similar` ids: a hidden message must not surface in either place.
  "search semantic": async (s, t, id) => surfaces((await s.call("GET", `/api/search?q=zebraquartz&mode=semantic&to=${HUMAN}`, { token: t })).body.items, id),
  "search hybrid": async (s, t, id) => idsOf((await s.call("GET", `/api/search?q=zebraquartz&mode=hybrid&to=${HUMAN}`, { token: t })).body.items).includes(id),
  folders: async (s, t) => {
    // HUMAN's inbox holds HUMAN_MSG, SHARED_MSG and OTHER_MSG: 3 means HUMAN_MSG is counted.
    const res = await s.call("GET", `/api/folders?to=${HUMAN}`, { token: t });
    return ((res.body.folders as Json[]).find((f) => f.id === "inbox") as Json).count === 3;
  },
  "message-get": async (s, t, id) => (await s.call("GET", `/api/messages/${encodeURIComponent(id)}`, { token: t })).status === 200,
  "message-get /attachments/{i}": async (s, t, id) =>
    (await s.call("GET", `/api/messages/${encodeURIComponent(id)}/attachments/0`, { token: t })).status === 200,
  "thread-get": async (s, t, id) =>
    idsOf((await s.call("GET", `/api/threads/${encodeURIComponent(s.threadOf(id))}`, { token: t })).body.messages).includes(id),
  "messages-seen": async (s, t, id) =>
    (await s.call("POST", "/api/messages/seen", { token: t, body: { ids: [id], seen: true, for: HUMAN } })).body.updated === 1,
  "messages-flags": async (s, t, id) =>
    (await s.call("POST", "/api/messages/flags", { token: t, body: { ids: [id], set: { flagged: true } } })).body.updated === 1,
  "messages-move": async (s, t, id) =>
    (await s.call("POST", "/api/messages/move", { token: t, body: { ids: [id], mailbox: "archive" } })).body.updated === 1,
  reply: async (s, t, id) => (await s.call("POST", "/api/reply", { token: t, body: { messageId: id, text: "ok" } })).status === 200,
  "reply send_as": async (s, t, id) => {
    // The CF transport refuses send_as AFTER the lookup (422, #897), so 422 proves the
    // target was found, and 404 that it was not.
    const res = await s.call("POST", "/api/reply", { token: t, body: { messageId: id, text: "ok", from: HUMAN } });
    return res.status === 422;
  },
  "send forward": async (s, t, id) =>
    (await s.call("POST", "/api/send", { token: t, body: { to: "z@example.com", text: "fyi", forwardMessageId: id } })).status === 200,
  "send In-Reply-To": async (s, t, id) => {
    const res = await s.call("POST", "/api/send", { token: t, body: { to: "z@example.com", subject: "re", text: "x", headers: { "In-Reply-To": `<${id}>` } } });
    expect(res.status, res.text).toBe(200);
    return res.body.threadId === s.threadOf(id);
  },
  "drafts send (reply)": async (s, t, id) => {
    const d = await s.call("POST", "/api/drafts", { token: t, body: { composeMode: "reply", sourceMessageId: id, bodyText: "draft" } });
    expect(d.status, d.text).toBe(201);
    return (await s.call("POST", `/api/drafts/${d.body.id}/send`, { token: t })).status === 200;
  },
  "drafts send (forward)": async (s, t, id) => {
    const d = await s.call("POST", "/api/drafts", { token: t, body: { composeMode: "forward", sourceMessageId: id, to: "z@example.com", subject: "f", bodyText: "draft" } });
    expect(d.status, d.text).toBe(201);
    return (await s.call("POST", `/api/drafts/${d.body.id}/send`, { token: t })).status === 200;
  },
};
// Route rows an agent can reach that touch no stored mail of another address, and why.
const NOT_OWNER_MAIL: Record<string, string> = {
  whoami: "reports the caller's own scope and grants; no mail",
  "recipients-recent": "the bound identity's OWN outbound recipients; never another address's mail",
  mobileconfig: "a setup profile for the bound identity; carries no mail",
  "message-delete": "no agent holds delete (RUNTIME_CAPS is read, send, organize); the route is guarded anyway",
  "send-alias": "the same handler as send, by the same if-arm",
};
// Which probes cover which route row.
const COVERS: Record<string, string[]> = {
  "messages-list": ["messages-list", "messages-list countOnly"],
  search: ["search fts", "search substr", "search semantic", "search hybrid"],
  folders: ["folders"],
  "message-get": ["message-get", "message-get /attachments/{i}"],
  "thread-get": ["thread-get"],
  "messages-seen": ["messages-seen"],
  "messages-flags": ["messages-flags"],
  "messages-move": ["messages-move"],
  reply: ["reply", "reply send_as"],
  send: ["send forward", "send In-Reply-To"],
  drafts: ["drafts send (reply)", "drafts send (forward)"],
};

describe("#853 every agent path is covered (derived from the route table)", () => {
  it("each Bearer-reachable mail row is probed or named, and every probe exists", () => {
    const rows = ROUTE_TABLE.filter((r) => r.auth === "bearer" && ["read", "send", "organize", "delete"].includes(r.scope as string)).map((r) => r.id);
    const unclassified = rows.filter((id) => !(id in COVERS) && !(id in NOT_OWNER_MAIL));
    expect(unclassified, "a new agent route must be probed here or named with a reason").toEqual([]);
    expect(Object.values(COVERS).flat().filter((p) => !(p in PROBES))).toEqual([]);
    expect(Object.keys(PROBES).filter((p) => !Object.values(COVERS).flat().includes(p))).toEqual([]);
    expect(rows.length).toBeGreaterThan(10);
  });
});

for (const flag of ["granted", "estate"] as const) {
  describe(`#853 AGENT_READ_SCOPE=${flag}: a human-only thread is gone for the agent, and only for the agent`, () => {
    for (const [name, probe] of Object.entries(PROBES)) {
      it(`${name}: reached before the mark, not after it, and again after the unmark; own mail stays`, async () => {
        const before = await setup(flag);
        expect(await probe(before, before.agent.token, HUMAN_MSG), "CONTROL: the agent reaches it before any mark").toBe(true);

        const s = await setup(flag);
        const marked = await s.mark();
        expect(marked.status, marked.text).toBe(201);
        expect(await probe(s, s.agent.token, HUMAN_MSG), "hidden after the mark").toBe(false);
        // A refused agent path writes no delegation audit row (only the mark's own row).
        expect(s.audit().filter((a) => String(a.action).startsWith("delegation.") && a.action !== "delegation.grant").map((a) => a.action)).toEqual(["delegation.exclude"]);

        const after = await setup(flag);
        const m = await after.mark();
        expect((await after.unmark((m.body.item as Json).id as string)).status).toBe(200);
        expect(await probe(after, after.agent.token, HUMAN_MSG), "reached again after the unmark").toBe(true);
      });
    }

    it("the agent's OWN mail in the marked thread stays; an unmarked thread stays", async () => {
      const s = await setup(flag);
      await s.mark();
      const t = s.agent.token;
      expect((await s.call("GET", `/api/messages/${SHARED_MSG}`, { token: t })).status).toBe(200);
      expect(idsOf((await s.call("GET", `/api/threads/${encodeURIComponent(s.threadOf(HUMAN_MSG))}`, { token: t })).body.messages)).toEqual([SHARED_MSG]);
      expect((await s.call("GET", `/api/messages/${OTHER_MSG}`, { token: t })).status).toBe(200);
      expect((await s.call("POST", "/api/reply", { token: t, body: { messageId: SHARED_MSG, text: "ok" } })).status).toBe(200);
      // A to= view is that mailbox as its owner sees it: the agent's own copy shows in its OWN
      // view, and not in the marking owner's view.
      expect(idsOf((await s.call("GET", `/api/messages?to=${AGENT}`, { token: t })).body.items)).toContain(SHARED_MSG);
      expect(idsOf((await s.call("GET", `/api/messages?to=${HUMAN}`, { token: t })).body.items)).not.toContain(SHARED_MSG);
    });

    it("the owner's OWN sent reply in the marked thread is hidden too", async () => {
      const s = await setup(flag);
      const sent = await s.call("POST", "/api/reply", { session: s.owner, body: { messageId: HUMAN_MSG, text: "my answer" } });
      expect(sent.status, sent.text).toBe(200);
      const mine = sent.body.messageId as string;
      expect(sent.body.threadId).toBe(s.threadOf(HUMAN_MSG));
      const t = s.agent.token;
      expect((await s.call("GET", `/api/messages/${encodeURIComponent(mine)}`, { token: t })).status, "CONTROL: reachable before").toBe(200);
      await s.mark();
      expect((await s.call("GET", `/api/messages/${encodeURIComponent(mine)}`, { token: t })).status).toBe(404);
      expect(idsOf((await s.call("GET", `/api/messages?lens=sent&to=${HUMAN}`, { token: t })).body.items)).not.toContain(mine);
    });

    it("a legacy row (no delivered set, mixed-case To, no thread_id) is hidden by its own id", async () => {
      const s = await setup(flag);
      s.raw.prepare("UPDATE messages SET delivered_to = NULL, to_addr = 'Conrad@Skyphusion.ORG', thread_id = NULL WHERE message_id = ?").run(OTHER_MSG);
      const t = s.agent.token;
      expect((await s.call("GET", `/api/messages/${OTHER_MSG}`, { token: t })).status, "CONTROL: reachable before").toBe(200);
      const m = await s.mark(OTHER_MSG);
      expect(m.status, m.text).toBe(201);
      expect((await s.call("GET", `/api/messages/${OTHER_MSG}`, { token: t })).status).toBe(404);
      expect(idsOf((await s.call("GET", `/api/messages?to=${HUMAN}`, { token: t })).body.items)).not.toContain(OTHER_MSG);
    });

    it("the owner's session and the operator token still read the marked thread", async () => {
      const s = await setup(flag);
      await s.mark();
      expect((await s.call("GET", `/api/messages/${HUMAN_MSG}`, { session: s.owner })).status).toBe(200);
      expect((await s.call("GET", `/api/messages/${HUMAN_MSG}`, { token: OPERATOR })).status).toBe(200);
      const thread = await s.call("GET", `/api/threads/${encodeURIComponent(s.threadOf(HUMAN_MSG))}`, { token: OPERATOR });
      expect(idsOf(thread.body.messages).sort()).toEqual([HUMAN_MSG, SHARED_MSG].sort());
      expect(idsOf((await s.call("GET", "/api/messages", { session: s.owner })).body.items)).toContain(HUMAN_MSG);
    });

    it("another human reaching the owner's marked mail through a role queue still reads it", async () => {
      const s = await setup(flag);
      const id = "queue-1@example.com";
      await store.put(s.env, {
        messageId: id, direction: "inbound", from: "x@example.com", to: `${QUEUE}, ${HUMAN}`, subject: "queue", date: "2026-02-05T00:00:00.000Z",
        bodyText: "q", auth: AUTH, trusted: false, deliveredTo: [QUEUE, HUMAN],
      }, s.ctx);
      const bob = await s.signIn(BOB);
      expect((await s.call("GET", `/api/messages/${id}`, { session: bob })).status, "CONTROL: BOB reads it as a queue member").toBe(200);
      expect((await s.mark(s.threadOf(id))).status).toBe(201);
      expect((await s.call("GET", `/api/messages/${id}`, { session: bob })).status).toBe(200);
      expect((await s.call("GET", `/api/messages/${id}`, { token: s.agent.token })).status).toBe(404);
    });

    it("a hidden message is the SAME bytes as one that does not exist", async () => {
      const s = await setup(flag);
      await s.mark();
      const t = s.agent.token;
      const get = await s.call("GET", `/api/messages/${HUMAN_MSG}`, { token: t });
      const absent = await s.call("GET", "/api/messages/never-1@example.com", { token: t });
      expect([get.status, get.text]).toEqual([404, absent.text]);
      const att = await s.call("GET", `/api/messages/${HUMAN_MSG}/attachments/0`, { token: t });
      const attAbsent = await s.call("GET", "/api/messages/never-1@example.com/attachments/0", { token: t });
      expect([att.status, att.text]).toEqual([404, attAbsent.text]);
      // The reply refusal names the caller's own id, so the absent case uses the same id.
      const reply = await s.call("POST", "/api/reply", { token: t, body: { messageId: HUMAN_MSG, text: "ok" } });
      s.raw.prepare("DELETE FROM messages WHERE message_id = ?").run(HUMAN_MSG);
      const replyAbsent = await s.call("POST", "/api/reply", { token: t, body: { messageId: HUMAN_MSG, text: "ok" } });
      expect([reply.status, reply.text]).toEqual([404, replyAbsent.text]);
    });
  });
}

const BOTH_MSG = "both-1@example.com"; // ONE row delivered to HUMAN and BOB, its own thread
async function withBoth(flag: "granted" | "estate") {
  const s = await setup(flag);
  await store.put(s.env, {
    messageId: BOTH_MSG, direction: "inbound", from: "x@example.com", to: `${HUMAN}, ${BOB}`, subject: "to both", date: "2026-02-06T00:00:00.000Z",
    bodyText: "both", auth: AUTH, trusted: false, deliveredTo: [HUMAN, BOB],
  }, s.ctx);
  s.vectorIds.push(BOTH_MSG); // a semantic candidate too, so only a filter can drop it
  return s;
}
const sees = async (s: S, token: string, via: string) => ({
  get: (await s.call("GET", `/api/messages/${BOTH_MSG}`, { token })).status,
  list: idsOf((await s.call("GET", `/api/messages?to=${via}`, { token })).body.items).includes(BOTH_MSG),
  thread: idsOf((await s.call("GET", `/api/threads/${encodeURIComponent(s.threadOf(BOTH_MSG))}`, { token })).body.messages).includes(BOTH_MSG),
});

for (const flag of ["granted", "estate"] as const) {
  describe(`#853 AGENT_READ_SCOPE=${flag}: a mark hides the row only from reach THROUGH the owner's address`, () => {
    it("Alice's agent loses the shared row; Bob's agent and the agent holding both grants keep it", async () => {
      const s = await withBoth(flag);
      const alices = s.agent.token; // holds HUMAN's grant only
      const bobs = (await s.agentWith("bobagent@skyphusion.org", [{ address: BOB, powers: ["read"] }])).token;
      const both = (await s.agentWith("bothagent@skyphusion.org", [{ address: HUMAN, powers: ["read"] }, { address: BOB, powers: ["read"] }])).token;
      const reached = { get: 200, list: true, thread: true };
      // CONTROL: before the mark every one of them reaches it, through either view.
      expect((await s.call("GET", `/api/messages?to=${HUMAN}`, { token: both })).body.items as Json[]).toEqual(
        expect.arrayContaining([expect.objectContaining({ messageId: BOTH_MSG })]),
      );
      expect(idsOf((await s.call("GET", `/api/search?q=both&mode=substr&field=body&to=${HUMAN}`, { token: both })).body.items)).toContain(BOTH_MSG);
      expect((((await s.call("GET", `/api/folders?to=${HUMAN}`, { token: both })).body.folders as Json[]).find((f) => f.id === "inbox") as Json).count).toBe(4);
      expect((await s.call("GET", `/api/messages?to=${HUMAN}&countOnly=1`, { token: both })).body.total).toBe(4);
      for (const mode of ["fts", "semantic", "hybrid"]) {
        expect(idsOf((await s.call("GET", `/api/search?q=both&mode=${mode}&to=${HUMAN}`, { token: both })).body.items), mode).toContain(BOTH_MSG);
      }
      expect(await sees(s, alices, HUMAN)).toEqual(reached);
      expect(await sees(s, bobs, BOB)).toEqual(reached);
      expect(await sees(s, both, BOB)).toEqual(reached);
      expect((await s.mark(s.threadOf(BOTH_MSG))).status).toBe(201);
      expect(await sees(s, alices, HUMAN)).toEqual({ get: 404, list: false, thread: false });
      expect(await sees(s, bobs, BOB)).toEqual(reached);
      expect(await sees(s, both, BOB)).toEqual(reached);
      // A to= naming ONE held address reads that mailbox as its owner sees it (Joan's live
      // finding on 174a90e): through Alice's view the row is gone, through Bob's it stays.
      const has = async (token: string, path: string) => idsOf((await s.call("GET", path, { token })).body.items).includes(BOTH_MSG);
      const views = async (token: string, via: string) => ({
        list: await has(token, `/api/messages?to=${via}`),
        count: (await s.call("GET", `/api/messages?to=${via}&countOnly=1`, { token })).body.total,
        substr: await has(token, `/api/search?q=both&mode=substr&field=body&to=${via}`),
        fts: await has(token, `/api/search?q=both&mode=fts&to=${via}`),
        semantic: await has(token, `/api/search?q=both&mode=semantic&to=${via}`),
        hybrid: await has(token, `/api/search?q=both&mode=hybrid&to=${via}`),
        inbox: (((await s.call("GET", `/api/folders?to=${via}`, { token })).body.folders as Json[]).find((f) => f.id === "inbox") as Json).count,
      });
      // HUMAN's mail: HUMAN_MSG, SHARED_MSG, OTHER_MSG, all inbox (+ BOTH_MSG unless hidden).
      // BOB's: BOB_MSG (+ BOTH_MSG).
      const hiddenVia = { list: false, count: 3, substr: false, fts: false, semantic: false, hybrid: false, inbox: 3 };
      expect(await views(both, HUMAN)).toEqual(hiddenVia);
      expect(await views(both, BOB)).toEqual({ list: true, count: 2, substr: true, fts: true, semantic: true, hybrid: true, inbox: 2 });
      expect(await views(alices, HUMAN)).toEqual(hiddenVia);
      // With no to=, the read is judged over every held address, so Bob's grant keeps it.
      // A plain list is the estate under estate read, and the agent's own mailbox under granted.
      if (flag === "estate") expect(await has(both, "/api/messages")).toBe(true);
      expect(await has(both, "/api/search?q=both&mode=substr&field=body")).toBe(flag === "estate");
      // Bob's own mark on the same thread closes his door too, and then nobody reaches it.
      const bob = await s.signIn(BOB);
      expect((await s.mark(s.threadOf(BOTH_MSG), bob)).status).toBe(201);
      expect((await sees(s, bobs, BOB)).get).toBe(404);
      expect((await sees(s, both, BOB)).get).toBe(404);
    });

    it("an agent with no grant reaches the shared row only through the estate, and loses it", async () => {
      const s = await withBoth(flag);
      const none = (await s.agentWith("noneagent@skyphusion.org", [])).token;
      const before = (await s.call("GET", `/api/messages/${BOTH_MSG}`, { token: none })).status;
      expect(before, "CONTROL: estate reads it, granted never did").toBe(flag === "estate" ? 200 : 404);
      await s.mark(s.threadOf(BOTH_MSG));
      expect((await s.call("GET", `/api/messages/${BOTH_MSG}`, { token: none })).status).toBe(404);
    });

    it("each path judges by ITS OWN reach: read through Bob's grant, but no organize through Alice's marked one", async () => {
      const s = await withBoth(flag);
      const a = (await s.agentWith("mixagent@skyphusion.org", [{ address: HUMAN, powers: ["organize"] }, { address: BOB, powers: ["read"] }])).token;
      const flag1 = await s.call("POST", "/api/messages/flags", { token: a, body: { ids: [BOTH_MSG], set: { flagged: true } } });
      expect(flag1.body.updated, "CONTROL: organize through HUMAN's grant before the mark").toBe(1);
      await s.mark(s.threadOf(BOTH_MSG));
      expect((await s.call("GET", `/api/messages/${BOTH_MSG}`, { token: a })).status).toBe(200);
      const flag2 = await s.call("POST", "/api/messages/flags", { token: a, body: { ids: [BOTH_MSG], set: { flagged: false } } });
      expect(flag2.body.updated).toBe(0);
    });
  });
}

describe("#853 a mark by a role queue's own owner binds the agent members of that queue", () => {
  for (const flag of ["granted", "estate"] as const) {
    it(`${flag}: the agent reads and marks queue mail read through the queue; after the queue's owner marks the thread, neither`, async () => {
      const s = await setup(flag, `${QUEUE}=${AGENT}`);
      expect((await s.call("POST", "/api/admin/users", { token: OPERATOR, body: { username: QUEUE, password: PASSWORD } })).status).toBe(201);
      const id = "queue-only-1@example.com";
      await putInbound(s.env, s.ctx, { id, from: "x@example.com", to: QUEUE, subject: "for the queue" });
      const t = s.agent.token;
      expect((await s.call("GET", `/api/messages/${id}`, { token: t })).status, "CONTROL: read through the queue").toBe(200);
      expect((await s.call("POST", "/api/messages/seen", { token: t, body: { ids: [id], seen: true } })).body.updated, "CONTROL: seen through the queue").toBe(1);
      const queue = await s.signIn(QUEUE);
      expect((await s.mark(s.threadOf(id), queue)).status).toBe(201);
      expect((await s.call("GET", `/api/messages/${id}`, { token: t })).status).toBe(404);
      expect((await s.call("POST", "/api/messages/seen", { token: t, body: { ids: [id], seen: false } })).body.updated).toBe(0);
    });
  }
});

describe("#853 the short-circuit: no mark anywhere, no predicate", () => {
  const PREDICATE = "json_each(";
  const PROBE = "SELECT 1 AS hit FROM delegation_exclusions WHERE revoked_at IS NULL LIMIT 1";
  it("with no active mark an agent request runs today's SQL, after ONE probe", async () => {
    const s = await setup("granted");
    const log = s.recordSql();
    const res = await s.call("GET", `/api/messages?to=${HUMAN}`, { token: s.agent.token });
    expect(idsOf(res.body.items)).toContain(HUMAN_MSG);
    expect(log.filter((q) => q.includes(PREDICATE))).toEqual([]);
    expect(log.filter((q) => q === PROBE)).toHaveLength(1);
  });

  it("a REVOKED mark is no mark: still skipped", async () => {
    const s = await setup("granted");
    const m = await s.mark();
    expect((await s.unmark((m.body.item as Json).id as string)).status).toBe(200);
    const log = s.recordSql();
    await s.call("GET", `/api/messages?to=${HUMAN}`, { token: s.agent.token });
    expect(log.filter((q) => q.includes(PREDICATE))).toEqual([]);
  });

  it("one active mark anywhere (even on someone else's thread) turns the predicate on, probed once per request", async () => {
    const s = await setup("granted");
    const bob = await s.signIn(BOB);
    expect((await s.mark(s.threadOf(BOB_MSG), bob)).status).toBe(201);
    const log = s.recordSql();
    const res = await s.call("GET", `/api/messages?to=${HUMAN}`, { token: s.agent.token });
    expect(idsOf(res.body.items)).toContain(HUMAN_MSG);
    expect(log.filter((q) => q.includes(PREDICATE)).length).toBeGreaterThan(0);
    expect(log.filter((q) => q === PROBE)).toHaveLength(1);
  });

  it("a human session never probes and never carries the predicate", async () => {
    const s = await setup("granted");
    await s.mark();
    const log = s.recordSql();
    await s.call("GET", "/api/messages", { session: s.owner });
    expect(log.filter((q) => q.includes(PREDICATE) || q === PROBE)).toEqual([]);
  });
});

describe("#853 the owner's marks", () => {
  it("marks idempotently: 201 then 200 with the same item, one row, one audit row", async () => {
    const s = await setup("granted");
    const first = await s.mark();
    expect(first.status, first.text).toBe(201);
    const item = first.body.item as Json;
    expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "subject", "threadId"]);
    expect(item.id).toMatch(/^exc_[0-9a-f]{24}$/);
    expect([item.threadId, item.subject, first.body.created]).toEqual([s.threadOf(HUMAN_MSG), "zebraquartz invoice", true]);
    const again = await s.mark();
    expect([again.status, again.body.created, again.body.item]).toEqual([200, false, item]);
    expect(s.raw.prepare("SELECT COUNT(*) AS n FROM delegation_exclusions").get()).toEqual({ n: 1 });
    const rows = s.audit().filter((a) => a.action === "delegation.exclude");
    const prn = (s.raw.prepare("SELECT principal_id FROM credentials WHERE type = 'password' AND lookup = ? AND revoked_at IS NULL").get(HUMAN) as Json).principal_id;
    expect(rows).toEqual([{
      actor_kind: "human", actor_id: prn, action: "delegation.exclude", target_kind: "thread", target_id: s.threadOf(HUMAN_MSG),
      outcome: "ok", detail: JSON.stringify({ address: HUMAN, exclusionId: item.id }),
    }]);
    expect((s.raw.prepare("SELECT created_by, address FROM delegation_exclusions").get() as Json)).toEqual({ created_by: prn, address: HUMAN });
  });

  it("a thread with none of my mail is the same 404 as an unknown thread, and nothing is stored", async () => {
    const s = await setup("granted");
    const bobs = await s.mark(s.threadOf(BOB_MSG));
    const unknown = await s.mark("no-such-thread@example.com");
    expect([bobs.status, bobs.text]).toEqual([404, unknown.text]);
    expect(bobs.body.error).toBe("E_NOT_FOUND");
    expect(s.raw.prepare("SELECT COUNT(*) AS n FROM delegation_exclusions").get()).toEqual({ n: 0 });
  });

  it("refuses a malformed threadId and an address field", async () => {
    const s = await setup("granted");
    for (const threadId of [undefined, "", "   ", 7, "a\nb", "x".repeat(1001)]) {
      const res = await s.call("POST", "/api/delegations/mine/exclusions", { session: s.owner, body: { threadId } });
      expect([res.status, res.body.error, res.body.field], JSON.stringify(threadId)).toEqual([400, "E_VALIDATION_ERROR", "threadId"]);
    }
    const addr = await s.call("POST", "/api/delegations/mine/exclusions", { session: s.owner, body: { threadId: s.threadOf(HUMAN_MSG), address: BOB } });
    expect([addr.status, addr.body.field]).toEqual([400, "address"]);
    expect(s.raw.prepare("SELECT COUNT(*) AS n FROM delegation_exclusions").get()).toEqual({ n: 0 });
  });

  it("lists MY active marks only, newest first, each with my subject", async () => {
    const s = await setup("granted");
    const a = (await s.mark()).body.item as Json;
    s.raw.prepare("UPDATE delegation_exclusions SET created_at = '2026-01-01T00:00:00.000Z'").run();
    const b = (await s.mark(s.threadOf(OTHER_MSG))).body.item as Json;
    const bob = await s.signIn(BOB);
    expect((await s.mark(s.threadOf(BOB_MSG), bob)).status).toBe(201);
    const list = await s.call("GET", "/api/delegations/mine/exclusions", { session: s.owner });
    expect(list.body).toEqual({ ok: true, items: [b, { ...a, createdAt: "2026-01-01T00:00:00.000Z" }] });
    expect(((await s.call("GET", "/api/delegations/mine/exclusions", { session: bob })).body.items as Json[]).map((i) => i.threadId)).toEqual([s.threadOf(BOB_MSG)]);
  });

  it("unmarks MY mark once; unknown, already removed and another person's are the same 404", async () => {
    const s = await setup("granted");
    const bob = await s.signIn(BOB);
    const bobs = (await s.mark(s.threadOf(BOB_MSG), bob)).body.item as Json;
    const mine = (await s.mark()).body.item as Json;
    const other = await s.unmark(bobs.id as string);
    const unknown = await s.unmark(`exc_${"0".repeat(24)}`);
    const malformed = await s.unmark("nope");
    expect([other.status, other.body.error]).toEqual([404, "E_NOT_FOUND"]);
    expect([unknown.text, malformed.text]).toEqual([other.text, other.text]);
    expect((await s.unmark(mine.id as string)).body).toEqual({ ok: true });
    expect((await s.unmark(mine.id as string)).text).toBe(other.text);
    expect((s.raw.prepare("SELECT revoked_at FROM delegation_exclusions WHERE id = ?").get(bobs.id as string) as Json).revoked_at).toBeNull();
    const rows = s.audit().filter((a) => a.action === "delegation.unexclude" && a.outcome === "ok");
    expect(rows.map((r) => [r.target_kind, r.target_id, JSON.parse(r.detail as string)])).toEqual([
      ["thread", s.threadOf(HUMAN_MSG), { address: HUMAN, exclusionId: mine.id }],
    ]);
    // A mark can be made again after an unmark.
    expect((await s.mark()).status).toBe(201);
  });

  it("my audit trail shows my mark and unmark, and nothing of anyone else's", async () => {
    const s = await setup("granted");
    const bob = await s.signIn(BOB);
    await s.mark(s.threadOf(BOB_MSG), bob);
    const mine = (await s.mark()).body.item as Json;
    await s.unmark(mine.id as string);
    const trail = await s.call("GET", "/api/audit/mine", { session: s.owner });
    const actions = (trail.body.items as Json[]).map((i) => [i.action, (i.target as Json | null)?.kind, (i.target as Json | null)?.id]);
    expect(actions.filter((a) => String(a[0]).includes("exclude"))).toEqual([
      ["delegation.unexclude", "thread", s.threadOf(HUMAN_MSG)],
      ["delegation.exclude", "thread", s.threadOf(HUMAN_MSG)],
    ]);
  });
});
