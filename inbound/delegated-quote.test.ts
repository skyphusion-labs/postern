import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { realEnv, putInbound } from "./realdb";

// #740 S3: a `quote` grant widens the reply target and forward source to the granted
// address's mail, under either AGENT_READ_SCOPE value, and every such quote is audited
// BEFORE dispatch (no audit, no send). Real sqlite engine from schema.sql, through the
// real handleApi.

const ADMIN = "test-token"; // realdb's static both token
const AGENT = "agent@skyphusion.org";
const HUMAN = "conrad@skyphusion.org";
const OUTSIDER = "outsider@example.net";
const HUMAN_MSG = "human-1@example.com";
const AGENT_MSG = "agent-1@example.com";
const SECRET = "the human's stored body, only quotable with a grant";

type Json = Record<string, unknown>;

async function setup(flag?: string) {
  const sent: Json[] = [];
  const r = realEnv({
    DEFAULT_FROM: AGENT,
    EMAIL: { async send(m: Json) { sent.push(m); return { messageId: "p" }; } },
    ...(flag === undefined ? {} : { AGENT_READ_SCOPE: flag }),
  });
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await handleApi(
      new Request("https://postern.example" + path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Json };
  };
  await putInbound(r.env, r.ctx, { id: HUMAN_MSG, from: OUTSIDER, to: HUMAN, body: SECRET });
  await putInbound(r.env, r.ctx, { id: AGENT_MSG, from: OUTSIDER, to: AGENT, body: "agent's own mail" });
  const minted = await call("POST", "/api/admin/identities", ADMIN, { from: AGENT, scopes: ["read", "send"] });
  expect(minted.status, minted.text).toBe(201);
  const agent = minted.body as { id: string; token: string };
  const grant = async (powers: string[]) => {
    const res = await call("POST", "/api/admin/delegations", ADMIN, { granteeId: agent.id, address: HUMAN, powers });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const revoke = async (id: string) => expect((await call("DELETE", `/api/admin/delegations/${id}`, ADMIN)).status).toBe(200);
  const quoteAudits = () =>
    r.raw
      .prepare("SELECT actor_kind, actor_id, target_kind, target_id, outcome, detail FROM audit_log WHERE action = 'delegation.quote' ORDER BY id")
      .all() as Array<Record<string, string>>;
  return { ...r, sent, call, agent, grant, revoke, quoteAudits };
}
type S = Awaited<ReturnType<typeof setup>>;

// One quoting request per send-scoped route row. `op` is the audit detail it must record.
// A draft is created first and then sent, which is how the drafts row quotes.
const QUOTES: Record<string, { op: string; run: (s: S, token: string, id: string) => Promise<{ status: number; text: string }> }> = {
  send: { op: "forward", run: (s, t, id) => s.call("POST", "/api/send", t, { to: "friend@example.net", text: "fyi", forwardMessageId: id }) },
  "send-alias": { op: "forward", run: (s, t, id) => s.call("POST", "/send", t, { to: "friend@example.net", text: "fyi", forwardMessageId: id }) },
  reply: { op: "reply", run: (s, t, id) => s.call("POST", "/api/reply", t, { messageId: id, text: "re", quoteOriginal: true }) },
  drafts: {
    op: "forward",
    run: async (s, t, id) => {
      const d = await s.call("POST", "/api/drafts", t, { to: "friend@example.net", bodyText: "fyi", composeMode: "forward", sourceMessageId: id });
      if (d.status !== 201) return d;
      return s.call("POST", `/api/drafts/${d.body.id as string}/send`, t);
    },
  },
};

describe("#740 S3 every send-scoped route is covered (derived from the route table)", () => {
  it("the send-scoped rows are exactly the quoting requests below (the loops are not vacuous)", () => {
    const rows = ROUTE_TABLE.filter((r) => r.scope === "send").map((r) => r.id).sort();
    expect(rows).toEqual(Object.keys(QUOTES).sort());
  });
});

for (const flag of [undefined, "granted"]) {
  const mode = flag === undefined ? "AGENT_READ_SCOPE unset" : `AGENT_READ_SCOPE=${flag}`;
  describe(`#740 S3 a quote grant widens each quoting route (${mode})`, () => {
    for (const [id, q] of Object.entries(QUOTES)) {
      it(`${id}: no grant or a non-quote grant quotes nothing; quote quotes and audits first; revoked quotes nothing`, async () => {
        const s = await setup(flag);
        expect((await q.run(s, s.agent.token, HUMAN_MSG)).status, "no grant").toBe(404);
        const other = await s.grant(["read", "organize", "send_as"]);
        expect((await q.run(s, s.agent.token, HUMAN_MSG)).status, "quote is not implied by other powers").toBe(404);
        await s.revoke(other);
        expect(s.sent, "nothing dispatched without a quote grant").toHaveLength(0);
        expect(s.quoteAudits()).toEqual([]);

        const g = await s.grant(["quote"]);
        const ok = await q.run(s, s.agent.token, HUMAN_MSG);
        expect(ok.status, ok.text).toBe(200);
        expect(s.sent).toHaveLength(1);
        expect(JSON.stringify(s.sent[0]), "the granted body is quoted").toContain(SECRET);
        const audits = s.quoteAudits();
        expect(audits.length).toBe(1);
        expect(audits[0]).toMatchObject({ actor_kind: "agent", actor_id: s.agent.id, target_kind: "message", target_id: HUMAN_MSG, outcome: "ok" });
        expect(JSON.parse(audits[0].detail)).toEqual({ op: q.op, address: HUMAN });

        await s.revoke(g);
        expect((await q.run(s, s.agent.token, HUMAN_MSG)).status, "revoked").toBe(404);
        expect(s.sent).toHaveLength(1);
      });

      it(`${id}: CONTROL: quoting the agent's own mail sends with no audit row`, async () => {
        const s = await setup(flag);
        await s.grant(["quote"]);
        const own = await q.run(s, s.agent.token, AGENT_MSG);
        expect(own.status, own.text).toBe(200);
        expect(s.quoteAudits(), "own mail is not a delegated quote").toEqual([]);
      });

      it(`${id}: if the audit insert fails, nothing is sent`, async () => {
        const s = await setup(flag);
        await s.grant(["quote"]);
        s.raw.exec(
          "CREATE TRIGGER quote_audit_down BEFORE INSERT ON audit_log WHEN NEW.action = 'delegation.quote' " +
            "BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
        );
        const res = await q.run(s, s.agent.token, HUMAN_MSG);
        expect(res.status, res.text).not.toBe(200);
        expect(s.sent, "no audit, no send").toHaveLength(0);
        // CONTROL: the same trigger leaves an unaudited send alone.
        expect((await q.run(s, s.agent.token, AGENT_MSG)).status).toBe(200);
      });
    }
  });
}

describe("#740 S3 controls outside the grant model", () => {
  it("the operator token still forwards the human message, and is not audited as a delegated quote", async () => {
    const s = await setup("granted");
    const res = await s.call("POST", "/api/send", ADMIN, { to: "friend@example.net", from: AGENT, text: "fyi", forwardMessageId: HUMAN_MSG });
    expect(res.status, res.text).toBe(200);
    expect(s.quoteAudits()).toEqual([]);
  });

  it("a reply to granted mail WITHOUT quoteOriginal is still audited (it reads the target)", async () => {
    const s = await setup("granted");
    await s.grant(["quote"]);
    const res = await s.call("POST", "/api/reply", s.agent.token, { messageId: HUMAN_MSG, text: "re" });
    expect(res.status, res.text).toBe(200);
    expect(s.quoteAudits().length).toBe(1);
    expect(JSON.stringify(s.sent[0])).not.toContain(SECRET);
  });
});
