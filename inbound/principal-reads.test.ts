import { describe, it, expect, vi, afterEach } from "vitest";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { realEnv } from "./realdb";

// #854 M2 part ii: resolution consults `credentials` beside the old tables, ALWAYS acts on
// the old table's answer (agree-or-fallback: a disagreement can never allow what the old
// table denies), and counts each disagreement with ONE write, only on a miss. Real sqlite
// engine from schema.sql, through handleApi.

const ADMIN = "test-token"; // realdb's static both token
const TRANSPORT = "transport-token-0123456789";
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-different-long-password";

type Json = Record<string, unknown>;

async function setup() {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native", WEBMAIL_AUTH_THROTTLE: "off", POSTERN_TRANSPORT_TOKEN: TRANSPORT });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined || method === "GET" ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  };
  expect((await call("POST", "/api/admin/users", { token: ADMIN, body: { username: ALICE, password: PASSWORD } })).status).toBe(201);
  const minted = await call("POST", "/api/admin/identities", { token: ADMIN, body: { from: "agent@skyphusion.org", scopes: ["read"] } });
  const agent = minted.body as { id: string; token: string };
  const signIn = (password: string) => call("POST", "/api/session", { body: { username: ALICE, password } });
  const smtpAuth = async (secret: string) => (await call("POST", "/api/smtp-auth", { token: TRANSPORT, body: { username: ALICE, secret } })).body;
  const whoami = () => call("GET", "/api/whoami", { token: agent.token });
  const misses = () => r.raw.prepare("SELECT kind, misses FROM principal_read_misses ORDER BY kind").all() as Json[];
  const total = (kind: string) => misses().filter((m) => m.kind === kind).reduce((n, m) => n + Number(m.misses), 0);
  return { ...r, call, agent, signIn, smtpAuth, whoami, misses, total };
}

afterEach(() => vi.restoreAllMocks());

describe("#854 M2 reads: an agreeing credential changes nothing and writes nothing", () => {
  it("sign-ins, smtp-auth and agent calls on a dual-written deploy: same answers, zero miss rows", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) {
      expect((await s.signIn(PASSWORD)).status).toBe(200);
      expect((await s.whoami()).status).toBe(200);
    }
    expect(await s.smtpAuth(PASSWORD)).toEqual({ ok: true, from: ALICE });
    expect((await s.signIn("wrong-password-x")).status).toBe(401);
    expect(s.misses(), "an agreeing read writes nothing").toEqual([]);
  });

  it("an unknown token or login is denied by both and is not a miss", async () => {
    const s = await setup();
    expect((await s.call("GET", "/api/whoami", { token: "not-a-token-0123456789abcdef" })).status).toBe(401);
    expect((await s.call("POST", "/api/session", { body: { username: "nobody@skyphusion.org", password: PASSWORD } })).status).toBe(401);
    expect(s.misses()).toEqual([]);
  });
});

describe("#854 M2 reads: a stale credential never allows what the old table denies (each is counted)", () => {
  it("a password changed in the old table only: the OLD password is refused, the new one works, a miss is counted", async () => {
    const s = await setup();
    s.raw.prepare("UPDATE smtp_credentials SET secret_hash = ? WHERE username = ?").run(await hashSecret(NEW_PASSWORD), ALICE);
    expect((await s.signIn(PASSWORD)).status, "the credential still holds the old hash; the old table decides").toBe(401);
    expect(await s.smtpAuth(PASSWORD)).toMatchObject({ ok: false });
    expect((await s.signIn(NEW_PASSWORD)).status).toBe(200);
    expect(s.total("human")).toBeGreaterThanOrEqual(3);
  });

  it("a user disabled in the old table only is refused, and counted", async () => {
    const s = await setup();
    s.raw.prepare("UPDATE smtp_credentials SET disabled = 1 WHERE username = ?").run(ALICE);
    expect((await s.signIn(PASSWORD)).status).toBe(401);
    expect(await s.smtpAuth(PASSWORD)).toMatchObject({ ok: false });
    expect(s.total("human")).toBe(2);
  });

  it("a user deleted from the old table only (credential still live) is refused, and counted", async () => {
    const s = await setup();
    s.raw.prepare("DELETE FROM smtp_credentials WHERE username = ?").run(ALICE);
    expect((await s.signIn(PASSWORD)).status).toBe(401);
    expect(s.total("human")).toBe(1);
  });

  it("an agent revoked in the old table only (credential still live) is refused, and counted", async () => {
    const s = await setup();
    s.raw.prepare("UPDATE agent_identities SET revoked_at = '2026-11-11T03:00:00.000Z' WHERE id = ?").run(s.agent.id);
    expect((await s.whoami()).status).toBe(401);
    expect(s.total("agent")).toBe(1);
  });

  it("an agent whose scopes changed in the old table only resolves with the OLD table's scopes, and is counted", async () => {
    const s = await setup();
    s.raw.prepare(`UPDATE agent_identities SET scopes = '["send"]' WHERE id = ?`).run(s.agent.id);
    // The old table now says send-only, so the read-scoped whoami is refused at the gate.
    expect((await s.whoami()).status).toBe(403);
    expect(s.total("agent")).toBe(1);
  });
});

describe("#854 M2 reads: a failure on the new side falls back to today's resolution, never a deny", () => {
  it("the miss counter is gone: a disagreeing sign-in still gets the old table's answer", async () => {
    const s = await setup();
    s.raw.prepare("UPDATE smtp_credentials SET secret_hash = ? WHERE username = ?").run(await hashSecret(NEW_PASSWORD), ALICE);
    s.raw.exec("DROP TABLE principal_read_misses");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await s.signIn(NEW_PASSWORD)).status).toBe(200);
    expect((await s.signIn(PASSWORD)).status).toBe(401);
    expect(err.mock.calls.some((c) => String(c[0]).includes("read-miss counter"))).toBe(true);
  });

  it("the credentials table is unreadable: sign-ins and agent tokens resolve exactly as today, nothing counted", async () => {
    const s = await setup();
    s.raw.exec("ALTER TABLE credentials RENAME TO credentials_offline");
    expect((await s.signIn(PASSWORD)).status).toBe(200);
    expect((await s.signIn("wrong-password-x")).status).toBe(401);
    expect((await s.whoami()).status).toBe(200);
    expect(s.misses()).toEqual([]);
  });
});

describe("#854 M2 reads: the parity route reports the miss counts", () => {
  it("counts by kind and by day, and no identifier", async () => {
    const s = await setup();
    s.raw.prepare("UPDATE smtp_credentials SET disabled = 1 WHERE username = ?").run(ALICE);
    await s.signIn(PASSWORD);
    const res = await s.call("GET", "/api/admin/principals/parity", { token: ADMIN });
    expect(res.body.readMisses).toMatchObject({ agent: 0, human: 1 });
    expect(JSON.stringify(res.body.readMisses)).not.toContain(ALICE);
  });
});
