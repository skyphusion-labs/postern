import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { ROUTE_TABLE } from "./src/routes";
import { principalParity } from "./src/principalmirror";
import { SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { realEnv } from "./realdb";

// #854 M2: dual-write. Every write to smtp_credentials or agent_identities carries the
// principal-table statements in the SAME batch, so the two agree after every write, and
// GET /api/admin/principals/parity measures that. Real sqlite engine, through handleApi.

const ADMIN = "test-token"; // realdb's static both token
const READ = "static-read-token-0123456789";
const ORIGIN = "https://postern.example";
const ALICE = "alice@skyphusion.org";
const PASSWORD = "correct-horse-battery";
const SETUP_TOKEN = "setup-token-0123456789abcdef0123456789";

type Json = Record<string, unknown>;

function setup(overrides: Record<string, unknown> = {}) {
  const r = realEnv({ WEBMAIL_AUTH_BACKEND: "native", POSTERN_API_TOKEN_READ: READ, ...overrides });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers, body: opts.body === undefined || method === "GET" ? undefined : JSON.stringify(opts.body) }),
      r.env,
      r.ctx,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json, res };
  };
  const clean = async () => {
    const p = await principalParity(r.env);
    return { agents: p.agents.diffs, humans: p.humans.diffs, orphans: p.orphans.diffs };
  };
  const zero = { agents: 0, humans: 0, orphans: 0 };
  const cred = (u: string) =>
    r.raw.prepare("SELECT c.secret, p.disabled_at, p.display_name FROM credentials c JOIN principals p ON p.id = c.principal_id WHERE c.type = 'password' AND c.lookup = ? AND c.revoked_at IS NULL").get(u) as Json | undefined;
  return { ...r, call, clean, zero, cred };
}

const user = (s: ReturnType<typeof setup>, username = ALICE) =>
  s.call("POST", "/api/admin/users", { token: ADMIN, body: { username, password: PASSWORD } });
const signIn = async (s: ReturnType<typeof setup>, password = PASSWORD) => {
  const res = await s.call("POST", "/api/session", { body: { username: ALICE, password } });
  expect(res.status).toBe(200);
  const get = (n: string) => res.res.headers.getSetCookie().find((c) => c.startsWith(n + "="))!.split(";")[0];
  return { cookie: `${get(SESSION_COOKIE)}; ${get(CSRF_COOKIE)}`, "x-postern-csrf": get(CSRF_COOKIE).slice(CSRF_COOKIE.length + 1) };
};
const secretOf = (s: ReturnType<typeof setup>, u = ALICE) =>
  (s.raw.prepare("SELECT secret_hash FROM smtp_credentials WHERE username = ?").get(u) as Json | undefined)?.secret_hash;

describe("#854 M2 every write site keeps the principal tables in step (parity 0 after each)", () => {
  it("user create, disable, display name, re-enable, admin password reset, delete", async () => {
    const s = setup();
    expect((await user(s)).status).toBe(201);
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)?.secret).toBe(secretOf(s));
    await s.call("PATCH", `/api/admin/users/${encodeURIComponent(ALICE)}`, { token: ADMIN, body: { disabled: true, displayName: "Alice A" } });
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)).toMatchObject({ display_name: "Alice A" });
    expect(s.cred(ALICE)?.disabled_at).not.toBeNull();
    await s.call("PATCH", `/api/admin/users/${encodeURIComponent(ALICE)}`, { token: ADMIN, body: { disabled: false } });
    expect(s.cred(ALICE)?.disabled_at).toBeNull();
    await s.call("POST", `/api/admin/users/${encodeURIComponent(ALICE)}/password`, { token: ADMIN, body: { password: "a-different-long-password" } });
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)?.secret).toBe(secretOf(s));
    const pid = (s.raw.prepare("SELECT principal_id FROM credentials WHERE lookup = ?").get(ALICE) as Json).principal_id as string;
    expect((await s.call("DELETE", `/api/admin/users/${encodeURIComponent(ALICE)}`, { token: ADMIN })).status).toBe(200);
    expect(await s.clean(), "no orphan: the credential is revoked").toEqual(s.zero);
    expect(s.cred(ALICE)).toBeUndefined();
    expect(s.raw.prepare("SELECT disabled_at IS NOT NULL AS d FROM principals WHERE id = ?").get(pid), "disabled, never deleted").toEqual({ d: 1 });
  });

  it("self-service change password, and the upgrade-on-sign-in rehash", async () => {
    const s = setup();
    await user(s);
    const session = await signIn(s);
    const res = await s.call("POST", "/api/session/password", { headers: session, body: { currentPassword: PASSWORD, newPassword: "self-chosen-new-password" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)?.secret).toBe(secretOf(s));
    // A legacy SHA-256 hash, written straight into the old table (as an old release did),
    // is upgraded at the next sign-in; the credential follows the upgrade.
    const legacy = await (async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, key, 256));
      const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
      return `pbkdf2$1000$${b64(salt)}$${b64(bits)}`;
    })();
    s.raw.prepare("UPDATE smtp_credentials SET secret_hash = ? WHERE username = ?").run(legacy, ALICE);
    expect((await s.clean()).humans, "CONTROL: parity sees the old-table-only change").toBe(1);
    await signIn(s);
    expect(secretOf(s), "rehashed").not.toBe(legacy);
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)?.secret).toBe(secretOf(s));
  });

  it("the legacy smtp-credentials upsert and delete", async () => {
    const s = setup();
    const up = await s.call("POST", "/api/admin/smtp-credentials", { token: ADMIN, body: { username: ALICE, secret: "legacy-secret-0123456789" } });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(await s.clean()).toEqual(s.zero);
    await s.call("POST", "/api/admin/smtp-credentials", { token: ADMIN, body: { username: ALICE, secret: "rotated-secret-0123456789" } });
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)?.secret).toBe(secretOf(s));
    expect((await s.call("DELETE", `/api/admin/smtp-credentials/${encodeURIComponent(ALICE)}`, { token: ADMIN })).status).toBe(200);
    expect(await s.clean()).toEqual(s.zero);
  });

  it("first-run setup", async () => {
    const s = setup({ POSTERN_SETUP_TOKEN: SETUP_TOKEN });
    const res = await s.call("POST", "/api/setup", { body: { setupToken: SETUP_TOKEN, username: ALICE, displayName: "Owner", password: PASSWORD } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await s.clean()).toEqual(s.zero);
    expect(s.cred(ALICE)).toMatchObject({ display_name: "Owner" });
    // The principal came from the WRITE's own batch, not from the session mint that
    // follows setup (ensureHumanPrincipal would also have made one, so parity alone could
    // not tell the two apart; created_by can).
    const by = s.raw.prepare("SELECT p.created_by FROM principals p JOIN credentials c ON c.principal_id = p.id WHERE c.lookup = ?").get(ALICE);
    expect(by).toEqual({ created_by: "dual-write" });
  });

  it("agent mint and revoke", async () => {
    const s = setup();
    const a = await s.call("POST", "/api/admin/identities", { token: ADMIN, body: { from: "agent@skyphusion.org", scopes: ["read", "send"] } });
    expect(a.status).toBe(201);
    expect(await s.clean()).toEqual(s.zero);
    const id = a.body.id as string;
    expect(s.raw.prepare("SELECT kind FROM principals WHERE id = ?").get(id)).toEqual({ kind: "agent" });
    await s.call("DELETE", `/api/admin/identities/${id}`, { token: ADMIN });
    expect(await s.clean()).toEqual(s.zero);
    expect(s.raw.prepare("SELECT revoked_at IS NOT NULL AS r FROM credentials WHERE principal_id = ?").get(id)).toEqual({ r: 1 });
  });
});

describe("#854 M2 a write and its mirror land together or not at all", () => {
  it("if the principal insert fails, the user is not created either", async () => {
    const s = setup();
    s.raw.exec("CREATE TRIGGER principals_down BEFORE INSERT ON principals WHEN NEW.kind = 'human' BEGIN SELECT RAISE(ABORT, 'principals down'); END;");
    const res = await user(s);
    expect(res.status).not.toBe(201);
    expect(s.raw.prepare("SELECT COUNT(*) AS n FROM smtp_credentials").get(), "rolled back with its mirror").toEqual({ n: 0 });
    // CONTROL: the same trigger leaves agent writes alone.
    expect((await s.call("POST", "/api/admin/identities", { token: ADMIN, body: { from: "agent@skyphusion.org", scopes: ["read"] } })).status).toBe(201);
  });
});

describe("#854 M2 parity sees every kind of disagreement (CONTROLS for the zeros above)", () => {
  it("a stale secret, a credential left live on a revoked agent, and an orphaned credential are each counted", async () => {
    const s = setup();
    await user(s);
    const a = await s.call("POST", "/api/admin/identities", { token: ADMIN, body: { from: "agent@skyphusion.org", scopes: ["read"] } });
    expect(await s.clean()).toEqual(s.zero);
    s.raw.prepare("UPDATE credentials SET secret = 'stale' WHERE lookup = ?").run(ALICE);
    s.raw.prepare("UPDATE agent_identities SET revoked_at = '2026-11-11T02:00:00.000Z' WHERE id = ?").run(a.body.id as string);
    s.raw.prepare("INSERT INTO credentials (id, principal_id, type, lookup, secret, caps, created_at) VALUES ('crd_orphan', 'prn_x', 'password', 'nobody@skyphusion.org', 's', '[]', '2026-11-11T00:00:00.000Z')").run();
    const res = await s.call("GET", "/api/admin/principals/parity", { token: ADMIN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agents: { checked: 1, diffs: 1, sample: [a.body.id] },
      humans: { checked: 1, diffs: 1, sample: [ALICE] },
      orphans: { diffs: 1, sample: ["crd_orphan"] },
    });
  });

  it("the parity route is operator only, and audited", async () => {
    const s = setup();
    const row = ROUTE_TABLE.find((r) => r.id === "admin-principals-parity")!;
    expect(row).toMatchObject({ method: "GET", scope: "admin" });
    expect((await s.call("GET", row.path, { token: READ })).status).toBe(403);
    expect((await s.call("GET", row.path)).status).toBe(401);
    expect((await s.call("GET", row.path, { token: ADMIN })).status).toBe(200);
    expect(s.raw.prepare("SELECT action, actor_id FROM audit_log WHERE action = 'principals.parity'").get()).toEqual({ action: "principals.parity", actor_id: "svc_both" });
  });
});
