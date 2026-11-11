import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { realEnv, putInbound } from "./realdb";

// #740 S2, the WRITE half: an organize grant widens mark read, flags and move to the
// granted address's mail, and each such write is audited in the SAME batch. Real sqlite
// engine built from schema.sql (realdb's batch is transactional, as D1's is), through the
// real handleApi.

const ADMIN = "test-token"; // realdb's static both token
const READ_TOKEN = "static-read-token-0123456789";
const AGENT = "agent@skyphusion.org";
const HUMAN = "conrad@skyphusion.org";
const HUMAN_MSG = "<human-1@example.com>";
const AGENT_MSG = "<agent-1@example.com>";

type Json = Record<string, unknown>;

async function setup(flag?: string) {
  const r = realEnv({ POSTERN_API_TOKEN_READ: READ_TOKEN, ...(flag === undefined ? {} : { AGENT_READ_SCOPE: flag }) });
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
  await putInbound(r.env, r.ctx, { id: HUMAN_MSG, from: "x@example.com", to: HUMAN });
  await putInbound(r.env, r.ctx, { id: AGENT_MSG, from: "y@example.com", to: AGENT });
  const minted = await call("POST", "/api/admin/identities", ADMIN, { from: AGENT, scopes: ["read", "organize"] });
  expect(minted.status, minted.text).toBe(201);
  const agent = minted.body as { id: string; token: string };
  const grant = async (powers: string[]) => {
    const res = await call("POST", "/api/admin/delegations", ADMIN, { granteeId: agent.id, address: HUMAN, powers });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const revoke = async (id: string) => expect((await call("DELETE", `/api/admin/delegations/${id}`, ADMIN)).status).toBe(200);
  const state = (id: string) => ({
    row: r.raw.prepare("SELECT seen, flagged, mailbox FROM messages WHERE message_id = ?").get(id) as Json,
    seenBy: r.raw.prepare("SELECT recipient, seen FROM message_seen_by WHERE message_id = ? ORDER BY recipient").all(id) as Json[],
  });
  const organizeAudits = () =>
    r.raw
      .prepare("SELECT actor_kind, actor_id, action, target_kind, target_id, outcome, detail FROM audit_log WHERE action = 'delegation.organize' ORDER BY id")
      .all() as Array<Record<string, string>>;
  return { ...r, call, agent, grant, revoke, state, organizeAudits };
}

// One request per organize row. `forHuman` is how the request names the human: seen
// writes a per-recipient state, so it names whose state with `for`; flags and move are
// row-level and need nothing extra.
const REQUESTS: Record<string, (id: string, forHuman: boolean) => { path: string; body: Json; op: string }> = {
  "messages-seen": (id, forHuman) => ({
    path: "/api/messages/seen",
    body: { ids: [id], seen: true, ...(forHuman ? { for: HUMAN } : {}) },
    op: "seen",
  }),
  "messages-flags": (id) => ({ path: "/api/messages/flags", body: { ids: [id], set: { flagged: true } }, op: "flags" }),
  "messages-move": (id) => ({ path: "/api/messages/move", body: { ids: [id], mailbox: "archive" }, op: "move" }),
};

describe("#740 S2 every organize route is covered (derived from the route table)", () => {
  it("the organize rows are exactly the requests below (the loops are not vacuous)", () => {
    const rows = ROUTE_TABLE.filter((r) => r.scope === "organize").map((r) => r.id).sort();
    expect(rows).toEqual(Object.keys(REQUESTS).sort());
  });
});

for (const flag of [undefined, "granted"]) {
  const mode = flag === undefined ? "AGENT_READ_SCOPE unset" : `AGENT_READ_SCOPE=${flag}`;
  describe(`#740 S2 an organize grant widens each organize route (${mode})`, () => {
    for (const [id, build] of Object.entries(REQUESTS)) {
      it(`${id}: no grant writes nothing; organize writes and audits; read alone or revoked writes nothing`, async () => {
        const s = await setup(flag);
        const req = build(HUMAN_MSG, true);
        const untouched = s.state(HUMAN_MSG);

        const none = await s.call("POST", req.path, s.agent.token, req.body);
        expect(none.status === 200 ? none.body.updated : none.status, "no grant").not.toBe(1);
        expect(s.state(HUMAN_MSG), "no grant: unchanged").toEqual(untouched);

        const readOnly = await s.grant(["read"]);
        const ro = await s.call("POST", req.path, s.agent.token, req.body);
        expect(ro.status === 200 ? ro.body.updated : ro.status, "read does not imply organize").not.toBe(1);
        expect(s.state(HUMAN_MSG)).toEqual(untouched);
        await s.revoke(readOnly);
        expect(s.organizeAudits(), "nothing written, nothing audited").toEqual([]);

        const g = await s.grant(["organize"]);
        const ok = await s.call("POST", req.path, s.agent.token, req.body);
        expect(ok.status, ok.text).toBe(200);
        expect(ok.body.updated).toBe(1);
        expect(s.state(HUMAN_MSG), "the write landed").not.toEqual(untouched);
        const audits = s.organizeAudits();
        expect(audits.length, "one audit row for the one granted message").toBe(1);
        expect(audits[0]).toMatchObject({
          actor_kind: "agent", actor_id: s.agent.id, target_kind: "message", target_id: HUMAN_MSG, outcome: "ok",
        });
        expect(JSON.parse(audits[0].detail)).toMatchObject({ op: req.op, granted: [HUMAN] });

        await s.revoke(g);
        const after = await s.call("POST", req.path, s.agent.token, build(HUMAN_MSG, true).body);
        expect(after.status === 200 ? after.body.updated : after.status, "revoked").not.toBe(1);
      });

      it(`${id}: CONTROLS: own mail writes with no audit row; the operator writes the human message`, async () => {
        const s = await setup(flag);
        await s.grant(["organize"]);
        const own = build(AGENT_MSG, false);
        expect((await s.call("POST", own.path, s.agent.token, own.body)).body.updated, "owner control").toBe(1);
        expect(s.organizeAudits(), "own mail is not a delegated write").toEqual([]);
        const op = build(HUMAN_MSG, true);
        expect((await s.call("POST", op.path, ADMIN, op.body)).body.updated, "operator control").toBe(1);
        expect(s.organizeAudits(), "the operator is not an agent acting on a grant").toEqual([]);
      });

      it(`${id}: if the audit insert fails, the write fails and nothing lands`, async () => {
        const s = await setup(flag);
        await s.grant(["organize"]);
        s.raw.exec(
          "CREATE TRIGGER audit_down BEFORE INSERT ON audit_log WHEN NEW.action = 'delegation.organize' " +
            "BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
        );
        const before = s.state(HUMAN_MSG);
        const req = build(HUMAN_MSG, true);
        const res = await s.call("POST", req.path, s.agent.token, req.body);
        // The status is whatever the route maps an engine error to; what is pinned is that
        // the request FAILS and the write did not land.
        expect(res.status, res.text).not.toBe(200);
        expect(res.body.ok).toBe(false);
        expect(s.state(HUMAN_MSG), "rolled back with its audit row").toEqual(before);
        // CONTROL: the same trigger leaves an unaudited write (own mail) alone, so the 500
        // above is the audit failing, not the route.
        const own = build(AGENT_MSG, false);
        expect((await s.call("POST", own.path, s.agent.token, own.body)).body.updated).toBe(1);
      });
    }
  });
}

describe("#740 S2 seen under a grant writes the HUMAN's read state", () => {
  it("for: HUMAN writes HUMAN's override, never the row-level flag and never the agent's", async () => {
    const s = await setup("granted");
    await s.grant(["organize"]);
    const res = await s.call("POST", "/api/messages/seen", s.agent.token, { ids: [HUMAN_MSG], seen: true, for: HUMAN });
    expect(res.body.updated).toBe(1);
    expect(s.state(HUMAN_MSG)).toEqual({ row: { seen: 0, flagged: 0, mailbox: null }, seenBy: [{ recipient: HUMAN, seen: 1 }] });
  });

  it("for: an address with no grant is still 403", async () => {
    const s = await setup("granted");
    await s.grant(["organize"]);
    const res = await s.call("POST", "/api/messages/seen", s.agent.token, { ids: [HUMAN_MSG], seen: true, for: "someone@skyphusion.org" });
    expect(res.status).toBe(403);
  });
});

describe("#740 S2 known limit: a refusal at the scope gate is not audited", () => {
  it("a read-only token is 403 on each organize route and writes no audit row (pinned; see DELEGATION.md)", async () => {
    const s = await setup("granted");
    for (const build of Object.values(REQUESTS)) {
      const req = build(HUMAN_MSG, true);
      expect((await s.call("POST", req.path, READ_TOKEN, req.body)).status).toBe(403);
    }
    expect(s.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'delegation.organize'").get()).toEqual({ n: 0 });
  });
});
