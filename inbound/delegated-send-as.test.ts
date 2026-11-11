import { describe, it, expect, vi, afterEach } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { realEnv, putInbound } from "./realdb";

// #740 S4: send_as. On a transport that can set `Sender:` (the relay), a send_as send
// goes out with From = the granted human (the human's display name), Sender = the agent
// identity, Reply-To = the human, audited BEFORE dispatch. On the default Cloudflare
// transport, which cannot set Sender, it is refused with E_SEND_AS_UNSUPPORTED and nothing
// is dispatched (Conrad's S4 ruling: fail closed, never downgrade). Real sqlite engine,
// through the real handleApi.

const ADMIN = "test-token"; // realdb's static both token
const AGENT = "agent@skyphusion.org";
const AGENT_NAME = "Triage Agent";
const HUMAN = "conrad@skyphusion.org";
const HUMAN_NAME = "Human Owner";
const OUTSIDER = "outsider@example.net";
const AGENT_MSG = "agent-1@example.com";

type Json = Record<string, unknown>;
type Transport = "relay" | "cf";

async function setup(transport: Transport) {
  const relayed: Json[] = [];
  const cfSent: Json[] = [];
  if (transport === "relay") {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      relayed.push(JSON.parse(init.body) as Json);
      return new Response(JSON.stringify({ ok: true, providerMessageId: "relay-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }
  const r = realEnv({
    DEFAULT_FROM: AGENT,
    EMAIL: { async send(m: Json) { cfSent.push(m); return { messageId: "cf-1" }; } },
    ...(transport === "relay"
      ? { OUTBOUND_TRANSPORT: "relay", RELAY_DISPATCH_URL: "https://relay.example/dispatch", POSTERN_TRANSPORT_TOKEN: "transport-0123456789" }
      : {}),
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
  // The human's account carries the display name a send_as From must use.
  r.raw
    .prepare("INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at, display_name) VALUES (?, ?, ?, 0, ?, ?, ?)")
    .run(HUMAN, HUMAN, "pbkdf2-sha512$1$x$y", "2026-11-11T00:00:00Z", "2026-11-11T00:00:00Z", HUMAN_NAME);
  await putInbound(r.env, r.ctx, { id: AGENT_MSG, from: OUTSIDER, to: AGENT });
  const minted = await call("POST", "/api/admin/identities", ADMIN, { from: AGENT, displayName: AGENT_NAME, scopes: ["read", "send"] });
  expect(minted.status, minted.text).toBe(201);
  const agent = minted.body as { id: string; token: string };
  const grant = async (powers: string[]) => {
    const res = await call("POST", "/api/admin/delegations", ADMIN, { granteeId: agent.id, address: HUMAN, powers });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const revoke = async (id: string) => expect((await call("DELETE", `/api/admin/delegations/${id}`, ADMIN)).status).toBe(200);
  const audits = () =>
    r.raw.prepare("SELECT actor_kind, actor_id, target_kind, target_id, detail FROM audit_log WHERE action = 'delegation.send_as' ORDER BY id").all() as Array<Record<string, string>>;
  const dispatched = () => (transport === "relay" ? relayed : cfSent);
  return { ...r, call, agent, grant, revoke, audits, dispatched, relayed };
}
type S = Awaited<ReturnType<typeof setup>>;

// One request per send-scoped route row that takes a caller `from`, asking to send as the
// human. Drafts take no caller from, so a draft send always goes out as the identity.
const SENDS: Record<string, { op: string; run: (s: S, token: string, from: string) => Promise<{ status: number; text: string; body: Json }> }> = {
  send: { op: "send", run: (s, t, from) => s.call("POST", "/api/send", t, { to: "friend@example.net", from, subject: "s", text: "t" }) },
  "send-alias": { op: "send", run: (s, t, from) => s.call("POST", "/send", t, { to: "friend@example.net", from, subject: "s", text: "t" }) },
  reply: { op: "reply", run: (s, t, from) => s.call("POST", "/api/reply", t, { messageId: AGENT_MSG, from, text: "re" }) },
};
const NOT_SEND_AS: Record<string, string> = { drafts: "takes no caller from: a draft send goes out as the identity" };

afterEach(() => vi.unstubAllGlobals());

describe("#740 S4 every send-scoped route is classified (derived from the route table)", () => {
  it("each send-scoped row is a send_as request or named as one that cannot be", () => {
    const rows = ROUTE_TABLE.filter((r) => r.scope === "send").map((r) => r.id).sort();
    expect(rows).toEqual([...Object.keys(SENDS), ...Object.keys(NOT_SEND_AS)].sort());
  });
});

describe("#740 S4 on the relay transport (can set Sender)", () => {
  for (const [id, q] of Object.entries(SENDS)) {
    it(`${id}: no send_as grant sends as the agent; send_as sends From=human, Sender=agent, Reply-To=human, audited; revoke stops it`, async () => {
      const s = await setup("relay");
      // No grant, and a grant of every OTHER power: the agent's own address, no Sender.
      const other = await s.grant(["read", "organize", "quote"]);
      const plain = await q.run(s, s.agent.token, HUMAN);
      expect(plain.status, plain.text).toBe(200);
      expect(plain.body.from).toBe(AGENT);
      expect(plain.body).not.toHaveProperty("sender");
      expect(s.relayed.at(-1)!.sender).toBeUndefined();
      await s.revoke(other);
      expect(s.audits()).toEqual([]);

      const g = await s.grant(["send_as"]);
      const res = await q.run(s, s.agent.token, HUMAN);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ from: HUMAN, sender: AGENT });
      const wire = s.relayed.at(-1)!;
      expect(wire.from, "From is the human, with the HUMAN's name").toEqual({ email: HUMAN, name: HUMAN_NAME });
      expect(wire.sender, "Sender is the agent identity").toEqual({ email: AGENT, name: AGENT_NAME });
      expect(wire.replyTo, "Reply-To is the human").toEqual({ email: HUMAN, name: HUMAN_NAME });
      const rows = s.audits();
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ actor_kind: "agent", actor_id: s.agent.id, target_kind: "address", target_id: HUMAN });
      expect(JSON.parse(rows[0].detail)).toEqual({ op: q.op });

      await s.revoke(g);
      const after = await q.run(s, s.agent.token, HUMAN);
      expect(after.body.from, "revoked: back to the agent's own address").toBe(AGENT);
      expect(s.audits().length).toBe(1);
    });

    it(`${id}: the caller's display name never reaches From under send_as`, async () => {
      const s = await setup("relay");
      await s.grant(["send_as"]);
      // The caller names the human with a display name of its own choosing.
      const res = await q.run(s, s.agent.token, { email: HUMAN, name: "Someone Else" } as unknown as string);
      expect(res.status, res.text).toBe(200);
      expect(s.relayed.at(-1)!.from, "the human's own name, never the caller's").toEqual({ email: HUMAN, name: HUMAN_NAME });
    });

    it(`${id}: if the audit insert fails, nothing is dispatched`, async () => {
      const s = await setup("relay");
      await s.grant(["send_as"]);
      s.raw.exec(
        "CREATE TRIGGER send_as_audit_down BEFORE INSERT ON audit_log WHEN NEW.action = 'delegation.send_as' " +
          "BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
      );
      const res = await q.run(s, s.agent.token, HUMAN);
      expect(res.status, res.text).not.toBe(200);
      expect(s.relayed, "no audit, no send").toHaveLength(0);
      // CONTROL: the same trigger leaves an ordinary send as the agent alone.
      expect((await q.run(s, s.agent.token, AGENT)).status).toBe(200);
    });
  }

  it("send: under send_as, replyTo may be the granted address and nothing else", async () => {
    const s = await setup("relay");
    await s.grant(["send_as"]);
    const bad = await s.call("POST", "/api/send", s.agent.token, { to: "friend@example.net", from: HUMAN, replyTo: "elsewhere@example.net", subject: "s", text: "t" });
    expect(bad.status).toBe(400);
    expect(s.relayed).toHaveLength(0);
    expect(s.audits()).toEqual([]);
    const ok = await s.call("POST", "/api/send", s.agent.token, { to: "friend@example.net", from: HUMAN, replyTo: HUMAN, subject: "s", text: "t" });
    expect(ok.status, ok.text).toBe(200);
  });

  it("CONTROL (owner): the agent sending as its own address with send_as held gets no Sender and no audit row", async () => {
    const s = await setup("relay");
    await s.grant(["send_as"]);
    const res = await SENDS.send.run(s, s.agent.token, AGENT);
    expect(res.status, res.text).toBe(200);
    expect(res.body.from).toBe(AGENT);
    expect(s.relayed.at(-1)!.sender).toBeUndefined();
    expect(s.audits()).toEqual([]);
  });

  it("CONTROL (operator): the static both token sends from the human address with no Sender and no send_as audit", async () => {
    const s = await setup("relay");
    const res = await s.call("POST", "/api/send", ADMIN, { to: "friend@example.net", from: HUMAN, subject: "s", text: "t" });
    expect(res.status, res.text).toBe(200);
    expect(s.relayed.at(-1)!.sender).toBeUndefined();
    expect(s.audits()).toEqual([]);
  });
});

describe("#740 S4 on the default Cloudflare transport (cannot set Sender)", () => {
  for (const [id, q] of Object.entries(SENDS)) {
    it(`${id}: a send_as send is refused E_SEND_AS_UNSUPPORTED, nothing is dispatched and nothing audited`, async () => {
      const s = await setup("cf");
      await s.grant(["send_as"]);
      const res = await q.run(s, s.agent.token, HUMAN);
      expect(res.status, res.text).toBe(422);
      expect(res.body.error).toBe("E_SEND_AS_UNSUPPORTED");
      expect(String(res.body.message)).toMatch(/Sender/);
      expect(s.dispatched()).toHaveLength(0);
      expect(s.audits()).toEqual([]);
    });

    it(`${id}: CONTROL: without the grant the same request sends as the agent`, async () => {
      const s = await setup("cf");
      const res = await q.run(s, s.agent.token, HUMAN);
      expect(res.status, res.text).toBe(200);
      expect(res.body.from).toBe(AGENT);
      expect(s.dispatched()).toHaveLength(1);
    });
  }
});
