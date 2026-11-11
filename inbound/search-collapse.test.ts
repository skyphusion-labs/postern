import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import * as store from "./src/store";
import { realEnv, AUTH } from "./realdb";

// #813 through the real store and handleApi: the subject in the embedded text, the
// template-family tiebreak and collapse in semantic search, its composition with the #853
// guard, hybrid staying one row per message, and the embed_version ledger
// (reconcile + reindex staleOnly).

const OPERATOR = "test-token";
const ORIGIN = "https://postern.example";
const HUMAN = "conrad@skyphusion.org";
const AGENT = "agent@skyphusion.org";
const CI = "ci@builds.example";
const PASSWORD = "correct-horse-battery";
type Json = Record<string, unknown>;

// A deterministic embedding: hashed bag of words, L2-normalised. Near-identical texts
// score as near-ties, as templated mail does under a real model.
const DIM = 64;
function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

async function setup() {
  const embedded: string[] = [];
  const index = new Map<string, { values: number[]; metadata: Json }>();
  const AI = { async run(_m: string, i: { text: string[] }) { embedded.push(...i.text); return { data: i.text.map(embed) }; } };
  const VECTORIZE = {
    async upsert(vs: Array<{ id: string; values: number[]; metadata: Json }>) { for (const v of vs) index.set(v.id, v); return {}; },
    async query(q: number[], o: { topK: number }) {
      const matches = [...index.entries()].map(([id, v]) => ({ id, score: cos(q, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score).slice(0, o.topK);
      return { matches };
    },
    async deleteByIds() { return {}; },
    async describe() { return { vectorCount: index.size }; },
    async getByIds(ids: string[]) { return ids.filter((id) => index.has(id)).map((id) => ({ id })); },
  };
  const r = realEnv({ AI, VECTORIZE, AGENT_READ_SCOPE: "granted", WEBMAIL_AUTH_BACKEND: "native", EMAIL: { async send() { return { messageId: "p" }; } } });
  const call = async (method: string, path: string, opts: { token?: string; session?: { cookie: string; csrf: string }; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.session) { headers.cookie = opts.session.cookie; headers["x-postern-csrf"] = opts.session.csrf; }
    const res = await handleApi(new Request(ORIGIN + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), r.env, r.ctx);
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Json };
  };
  // realdb's ctx drops waitUntil work; the live index path runs there, so collect and await it.
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
  const put = async (id: string, subject: string, body: string, date: string, to = HUMAN) => {
    await store.put(r.env, { messageId: id, direction: "inbound", from: CI, to, subject, date, bodyText: body, auth: AUTH, trusted: false, deliveredTo: [to], vectorize: true }, ctx);
    await Promise.all(pending.splice(0));
  };
  // The family: five "corpus-sync" failures, distinguished only by the commit in the body.
  const commits = ["1a2b3c4", "5d6e7f8", "9a8b7c6", "d5e4f3a", "b2c1d0e"];
  for (let i = 0; i < commits.length; i++) {
    await put(`run-${i}@ci`, `Run failed: corpus-sync #48${20 + i}`, `The corpus-sync job failed at commit ${commits[i]}. See the log for details.`, `2026-11-0${i + 1}T00:00:00.000Z`);
  }
  await put("lunch@x", "Lunch on friday", "Shall we get lunch on friday near the office", "2026-11-03T00:00:00.000Z");
  await put("invoice@x", "Invoice 2211 overdue", "Your invoice 2211 is overdue, please pay by monday", "2026-11-04T00:00:00.000Z");
  return { ...r, call, put, commits, embedded, index };
}
type S = Awaited<ReturnType<typeof setup>>;
const hits = (res: { body: Json }) => (res.body.items as Json[]).map((h) => ({ id: (h.message as Json).messageId as string, similar: h.similar as Json | undefined }));
const sem = (s: S, q: string, extra = "") => s.call("GET", `/api/search?q=${encodeURIComponent(q)}&mode=semantic${extra}`, { token: OPERATOR });

describe("#813 the embedded text carries the subject; the ledger records the recipe", () => {
  it("chunk 0 starts with the subject, and every ledger row says embed_version 2", async () => {
    const s = await setup();
    expect(s.embedded).toContain("Subject: Lunch on friday\n\nShall we get lunch on friday near the office");
    const versions = s.raw.prepare("SELECT DISTINCT embed_version AS v FROM vector_ledger").all() as Json[];
    expect(versions).toEqual([{ v: 2 }]);
  });

  it("an empty body with a subject is indexed live as one chunk, and reconcile expects exactly that", async () => {
    const s = await setup();
    await s.put("empty@x", "Standup moved to 10", "", "2026-11-06T00:00:00.000Z");
    expect(s.embedded).toContain("Subject: Standup moved to 10");
    const ledger = s.raw.prepare("SELECT chunk, embed_version FROM vector_ledger WHERE message_id = 'empty@x'").all() as Json[];
    expect(ledger).toEqual([{ chunk: 0, embed_version: 2 }]);
    const rec = await store.reconcile(s.env, { verify: true, sampleSize: 0 });
    expect([rec.ledgerDrift, rec.missingExpected]).toEqual([0, 0]);
  });

  it("reconcile counts stale messages; reindex staleOnly re-embeds exactly those", async () => {
    const s = await setup();
    s.raw.prepare("UPDATE vector_ledger SET embed_version = 1 WHERE message_id IN ('lunch@x', 'run-0@ci')").run();
    expect((await store.reconcile(s.env, { verify: false, sampleSize: 0 })).staleEmbedMessages).toBe(2);
    s.embedded.length = 0;
    const page = await store.reindexPage(s.env, { staleOnly: true, limit: 50 });
    expect([page.indexed, page.skippedCurrent, page.embedVersion]).toEqual([2, 5, 2]);
    expect(s.embedded.filter((t) => t.startsWith("Subject: ")).length).toBe(2);
    expect((await store.reconcile(s.env, { verify: false, sampleSize: 0 })).staleEmbedMessages).toBe(0);
    // CONTROL: without staleOnly every message is re-embedded.
    const all = await store.reindexPage(s.env, { limit: 50 });
    expect([all.indexed, all.skippedCurrent]).toEqual([7, 0]);
  });

  it("the admin route takes staleOnly", async () => {
    const s = await setup();
    const res = await s.call("POST", "/api/admin/reindex", { token: OPERATOR, body: { staleOnly: true, limit: 50 } });
    expect([res.status, res.body.indexed, res.body.skippedCurrent]).toEqual([200, 0, 7]);
  });
});

describe("#813 semantic search: template families", () => {
  it("the commit in the query picks that run out of its family", async () => {
    const s = await setup();
    const res = await sem(s, `corpus-sync failed ${s.commits[1]}`);
    expect(hits(res)[0].id).toBe("run-1@ci");
  });

  it("with no distinguishing token the newest run leads its family", async () => {
    const s = await setup();
    const ids = hits(await sem(s, "Run failed: corpus-sync")).map((h) => h.id);
    expect(ids[0]).toBe("run-4@ci");
  });

  it("the tiebreak reads past `limit`: the newest run leads even when it ranks below the top 2 by cosine", async () => {
    const s = await setup();
    // CONTROL: by raw cosine (the index itself) the newest run is NOT in the top 2.
    const q = "Run failed: corpus-sync";
    const qv = embed(q);
    const raw = [...s.index.entries()].map(([, v]) => ({ id: v.metadata.message_id as string, score: cos(qv, v.values) }))
      .sort((a, b) => b.score - a.score).map((x) => x.id);
    const top2 = [...new Set(raw)].slice(0, 2);
    expect(top2).not.toContain("run-4@ci");
    expect(hits(await sem(s, q, "&collapse=0&limit=2"))[0].id).toBe("run-4@ci");
  });

  it("collapse folds the family into its winner by default; collapse=0 keeps every run a row", async () => {
    const s = await setup();
    const plain = hits(await sem(s, `corpus-sync failed ${s.commits[1]}`, "&collapse=0"));
    expect(plain.filter((h) => h.id.startsWith("run-")).length).toBe(5);
    expect(plain.every((h) => h.similar === undefined)).toBe(true);
    const folded = hits(await sem(s, `corpus-sync failed ${s.commits[1]}`));
    // The default IS collapse=1.
    expect(hits(await sem(s, `corpus-sync failed ${s.commits[1]}`, "&collapse=1"))).toEqual(folded);
    const runs = folded.filter((h) => h.id.startsWith("run-"));
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("run-1@ci");
    expect(runs[0].similar).toEqual({ count: 4, ids: expect.arrayContaining(["run-0@ci", "run-2@ci", "run-3@ci", "run-4@ci"]) });
    expect(folded.map((h) => h.id)).toEqual(expect.arrayContaining(["lunch@x", "invoice@x"]));
  });

  it("hybrid never collapses: collapse=1 there is refused, collapse=0 accepted", async () => {
    const s = await setup();
    for (const mode of ["hybrid", "fts", "substr"]) {
      const refused = await s.call("GET", `/api/search?q=corpus&mode=${mode}&collapse=1`, { token: OPERATOR });
      expect([refused.status, refused.body.error], mode).toEqual([400, "E_VALIDATION_ERROR"]);
    }
    const noMode = await s.call("GET", "/api/search?q=corpus&collapse=true", { token: OPERATOR });
    expect(noMode.status, "an omitted mode is fts").toBe(400);
    expect((await s.call("GET", "/api/search?q=corpus&mode=hybrid&collapse=0", { token: OPERATOR })).status).toBe(200);
    const res = await s.call("GET", `/api/search?q=${encodeURIComponent("corpus-sync")}&mode=hybrid`, { token: OPERATOR });
    expect(res.status).toBe(200);
    const h = hits(res);
    expect(h.filter((x) => x.id.startsWith("run-")).length).toBe(5);
    expect(h.every((x) => x.similar === undefined)).toBe(true);
    // A query fts cannot answer (no hit has every token), so every run comes from the
    // semantic half: if that half collapsed, hybrid would show one run.
    const fts = await s.call("GET", `/api/search?q=${encodeURIComponent("the job broke overnight")}&mode=fts`, { token: OPERATOR });
    expect((fts.body.items as Json[]).length, "CONTROL: fts finds nothing").toBe(0);
    const semOnly = hits(await s.call("GET", `/api/search?q=${encodeURIComponent("the job broke overnight")}&mode=hybrid&limit=20`, { token: OPERATOR }));
    expect(semOnly.filter((x) => x.id.startsWith("run-")).length).toBe(5);
  });
});

describe("#813 composes with #853: a hidden member is not a member", () => {
  it("a run in a human-only thread is neither the winner nor counted in similar for an agent", async () => {
    const s = await setup();
    expect((await s.call("POST", "/api/admin/users", { token: OPERATOR, body: { username: HUMAN, password: PASSWORD } })).status).toBe(201);
    const minted = await s.call("POST", "/api/admin/identities", { token: OPERATOR, body: { from: AGENT, scopes: ["read"] } });
    const agent = minted.body as { id: string; token: string };
    expect((await s.call("POST", "/api/admin/delegations", { token: OPERATOR, body: { granteeId: agent.id, address: HUMAN, powers: ["read"] } })).status).toBe(201);
    const q = `/api/search?q=${encodeURIComponent(`corpus-sync failed ${s.commits[1]}`)}&mode=semantic&collapse=1&to=${HUMAN}`;
    const before = hits(await s.call("GET", q, { token: agent.token })).find((h) => h.id.startsWith("run-"));
    expect(before, "CONTROL: the agent sees the family through its grant").toEqual({ id: "run-1@ci", similar: { count: 4, ids: expect.any(Array) } });

    const signIn = await handleApi(new Request(ORIGIN + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: HUMAN, password: PASSWORD }) }), s.env, s.ctx);
    const cookie = (n: string) => signIn.headers.getSetCookie().find((c) => c.startsWith(n + "="))!.split(";")[0];
    const session = { cookie: `${cookie(SESSION_COOKIE)}; ${cookie(CSRF_COOKIE)}`, csrf: cookie(CSRF_COOKIE).slice(CSRF_COOKIE.length + 1) };
    const thread = (id: string) => (s.raw.prepare("SELECT COALESCE(thread_id, message_id) AS t FROM messages WHERE message_id = ?").get(id) as Json).t as string;
    // Hide the WINNER and one other member.
    for (const id of ["run-1@ci", "run-3@ci"]) {
      expect((await s.call("POST", "/api/delegations/mine/exclusions", { session, body: { threadId: thread(id) } })).status).toBe(201);
    }
    const after = hits(await s.call("GET", q, { token: agent.token })).filter((h) => h.id.startsWith("run-"));
    expect(after).toHaveLength(1);
    expect(["run-1@ci", "run-3@ci"]).not.toContain(after[0].id);
    expect(after[0].similar?.count).toBe(2);
    expect(after[0].similar?.ids).not.toContain("run-1@ci");
    expect(after[0].similar?.ids).not.toContain("run-3@ci");
    // The operator still sees the whole family.
    const op = hits(await sem(s, `corpus-sync failed ${s.commits[1]}`)).find((h) => h.id.startsWith("run-"));
    expect(op).toEqual({ id: "run-1@ci", similar: { count: 4, ids: expect.any(Array) } });
  });
});
