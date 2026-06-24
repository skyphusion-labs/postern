import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";

// A focused D1 fake for the smtp_credentials table only: enough of the
// prepare/bind/first/run surface for the auth + admin handlers. Kept local to this
// suite so the shared message-store fake (fakes.ts) stays untouched.
interface CredRow {
  username: string;
  from_addr: string;
  secret_hash: string;
  disabled: number;
}

function makeEnv(seed: CredRow[] = [], overrides: Record<string, unknown> = {}) {
  const rows: CredRow[] = seed.map((r) => ({ ...r }));
  function stmt(sql: string) {
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first<T>() {
        if (/FROM smtp_credentials WHERE username = \?/i.test(sql)) {
          const u = String(bound[0]);
          const row = rows.find((r) => r.username === u);
          return (row ?? null) as T | null;
        }
        return null as T | null;
      },
      async run() {
        if (/INSERT INTO smtp_credentials/i.test(sql)) {
          const [username, from_addr, secret_hash] = bound as [string, string, string];
          const existing = rows.find((r) => r.username === username);
          if (existing) {
            existing.from_addr = from_addr;
            existing.secret_hash = secret_hash;
            existing.disabled = 0;
            return { meta: { changes: 1 } };
          }
          rows.push({ username, from_addr, secret_hash, disabled: 0 });
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM smtp_credentials WHERE username = \?/i.test(sql)) {
          const u = String(bound[0]);
          const i = rows.findIndex((r) => r.username === u);
          if (i >= 0) {
            rows.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
    POSTERN_API_TOKEN: "api-token",
    POSTERN_TRANSPORT_TOKEN: "transport-token",
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    ...overrides,
  } as unknown as Env;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  return { env, ctx, rows };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://postern.example${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("POST /api/smtp-auth", () => {
  it("401s without the transport token", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(req("POST", "/api/smtp-auth", { body: { username: "a@skyphusion.org", secret: "x" } }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("401s with the API token (must be the TRANSPORT token, not the API token)", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(
      req("POST", "/api/smtp-auth", { token: "api-token", body: { username: "a@skyphusion.org", secret: "x" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns the bound From on a good credential", async () => {
    const hash = await hashSecret("hunter2hunter2");
    const { env, ctx } = makeEnv([{ username: "alice@skyphusion.org", from_addr: "alice@skyphusion.org", secret_hash: hash, disabled: 0 }]);
    const res = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "Alice@Skyphusion.org", secret: "hunter2hunter2" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, from: "alice@skyphusion.org" });
  });

  it("rejects a wrong secret with ok:false (relay maps to SMTP 535)", async () => {
    const hash = await hashSecret("correct-horse");
    const { env, ctx } = makeEnv([{ username: "alice@skyphusion.org", from_addr: "alice@skyphusion.org", secret_hash: hash, disabled: 0 }]);
    const res = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "alice@skyphusion.org", secret: "wrong" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("rejects an unknown user with ok:false", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "ghost@skyphusion.org", secret: "whatever" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("rejects a disabled credential", async () => {
    const hash = await hashSecret("still-secret");
    const { env, ctx } = makeEnv([{ username: "bob@skyphusion.org", from_addr: "bob@skyphusion.org", secret_hash: hash, disabled: 1 }]);
    const res = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "bob@skyphusion.org", secret: "still-secret" } }),
      env,
      ctx,
    );
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("400s on a missing field", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "a@skyphusion.org" } }), env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("admin /api/admin/smtp-credentials", () => {
  it("401s without the API token", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(req("POST", "/api/admin/smtp-credentials", { body: { username: "a@skyphusion.org" } }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("mints a credential, returns the secret once, and it then authenticates", async () => {
    const { env, ctx } = makeEnv();
    const mint = await handleApi(
      req("POST", "/api/admin/smtp-credentials", { token: "api-token", body: { username: "carol@skyphusion.org" } }),
      env,
      ctx,
    );
    expect(mint.status).toBe(200);
    const body = (await mint.json()) as { ok: boolean; username: string; from: string; secret: string };
    expect(body.ok).toBe(true);
    expect(body.from).toBe("carol@skyphusion.org");
    expect(body.secret.length).toBeGreaterThan(20);

    // The minted secret authenticates against the freshly stored hash.
    const auth = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "carol@skyphusion.org", secret: body.secret } }),
      env,
      ctx,
    );
    expect(await auth.json()).toEqual({ ok: true, from: "carol@skyphusion.org" });
  });

  it("rejects a bound From off the allowed domain", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(
      req("POST", "/api/admin/smtp-credentials", { token: "api-token", body: { username: "dave", from: "dave@evil.example" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "E_SENDER_NOT_ALLOWED" });
  });

  it("rotates an existing credential (old secret stops working)", async () => {
    const hash = await hashSecret("old-secret-123");
    const { env, ctx } = makeEnv([{ username: "erin@skyphusion.org", from_addr: "erin@skyphusion.org", secret_hash: hash, disabled: 0 }]);
    const rot = await handleApi(
      req("POST", "/api/admin/smtp-credentials", { token: "api-token", body: { username: "erin@skyphusion.org", secret: "brand-new-secret" } }),
      env,
      ctx,
    );
    expect(rot.status).toBe(200);
    const oldAuth = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "erin@skyphusion.org", secret: "old-secret-123" } }),
      env,
      ctx,
    );
    expect(await oldAuth.json()).toMatchObject({ ok: false });
    const newAuth = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "erin@skyphusion.org", secret: "brand-new-secret" } }),
      env,
      ctx,
    );
    expect(await newAuth.json()).toEqual({ ok: true, from: "erin@skyphusion.org" });
  });

  it("revokes a credential via DELETE", async () => {
    const hash = await hashSecret("temp-secret-1");
    const { env, ctx } = makeEnv([{ username: "frank@skyphusion.org", from_addr: "frank@skyphusion.org", secret_hash: hash, disabled: 0 }]);
    const del = await handleApi(
      req("DELETE", "/api/admin/smtp-credentials/frank@skyphusion.org", { token: "api-token" }),
      env,
      ctx,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, deleted: "frank@skyphusion.org" });
    const after = await handleApi(
      req("POST", "/api/smtp-auth", { token: "transport-token", body: { username: "frank@skyphusion.org", secret: "temp-secret-1" } }),
      env,
      ctx,
    );
    expect(await after.json()).toMatchObject({ ok: false });
  });

  it("404s deleting an unknown credential", async () => {
    const { env, ctx } = makeEnv();
    const res = await handleApi(req("DELETE", "/api/admin/smtp-credentials/nobody@skyphusion.org", { token: "api-token" }), env, ctx);
    expect(res.status).toBe(404);
  });
});
