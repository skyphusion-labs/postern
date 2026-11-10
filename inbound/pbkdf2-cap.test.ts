import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { authenticate, hashIterations, hashSecret, verifySecret } from "./src/smtpcreds";
import { insertSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";

// Deliberately NOT imported from test-setup/workers-pbkdf2-cap.ts: importing that module
// installs the shim, so a control that imported it would pass even if vitest.config.ts
// stopped loading it. The control below must see the cap from setupFiles alone.
const WORKERS_PBKDF2_MAX_ITERATIONS = 100_000;

// #821: the deployed Workers runtime caps PBKDF2 at 100,000 iterations, and the hash
// target was 210,000, so no native credential could be created or verified in
// production. Contract webmail-v2-contracts 1.10.2: the target is pbkdf2-sha512 at
// 100,000; legacy pbkdf2 (SHA-256) rows verify and upgrade; a row above the cap is an
// infra condition (never counted as a guess) that the operator resets.

const ORIGIN = "https://postern.example";
const PASSWORD = "correct-horse-battery";
const USER = "alice@skyphusion.org";
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function realEnv(overrides: Record<string, unknown> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  function prepare(sql: string) {
    const stmt = db.prepare(sql);
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) { bound = args; return this; },
      async all<T>() { return { results: stmt.all(...(bound as never[])) as unknown as T[] }; },
      async first<T>() { return (stmt.get(...(bound as never[])) ?? null) as T | null; },
      async run() { const r = stmt.run(...(bound as never[])); return { meta: { changes: Number(r.changes) } }; },
    };
  }
  const env = {
    DB: { prepare }, ALLOWED_FROM_DOMAIN: "skyphusion.org", WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_API_TOKEN: "admin-both-token-0123456789", POSTERN_TRANSPORT_TOKEN: "transport-token-0123456789",
    ...overrides,
  } as unknown as Env;
  return { env, raw: db };
}

// Derive a hash the way a runtime WITHOUT the cap would have (bypassing the shim is not
// possible, so above-cap rows are built from a known derivation at a legal count and
// then relabelled: the verifier must refuse on the LABEL before deriving anything).
async function legacySha256(secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

function seed(db: DatabaseSync, hash: string, username = USER): void {
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  ).run(username, username, hash, "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z");
}

const signIn = (env: Env, password = PASSWORD) =>
  handleApi(new Request(ORIGIN + "/api/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password }),
  }), env, CTX);

describe("#821 the suite runs under the Workers PBKDF2 cap", () => {
  it("CONTROL: the shim refuses above the cap exactly like the edge, and allows the cap itself", async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("x"), "PBKDF2", false, ["deriveBits"]);
    const salt = new Uint8Array(16);
    await expect(
      crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations: WORKERS_PBKDF2_MAX_ITERATIONS + 1 }, key, 512),
    ).rejects.toThrow(/iteration counts above 100000 are not supported/);
    const ok = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations: WORKERS_PBKDF2_MAX_ITERATIONS }, key, 512);
    expect(ok.byteLength).toBe(64);
  });
});

describe("#821 the hash target fits the runtime", () => {
  it("the stored hash IS PBKDF2-HMAC-SHA512 (checked by an independent derivation)", async () => {
    const h = await hashSecret(PASSWORD);
    const [tag, iters, saltB64, hashB64] = h.split("$");
    expect([tag, iters]).toEqual(["pbkdf2-sha512", "100000"]);
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations: 100_000 }, key, 512));
    expect(btoa(String.fromCharCode(...bits))).toBe(hashB64);
  });

  it("hashSecret writes pbkdf2-sha512 at exactly the cap, and it verifies", async () => {
    const h = await hashSecret(PASSWORD);
    expect(h).toMatch(/^pbkdf2-sha512\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hashIterations(h)).toBe(WORKERS_PBKDF2_MAX_ITERATIONS);
    expect(await verifySecret(PASSWORD, h)).toBe(true);
    expect(await verifySecret("wrong-password", h)).toBe(false);
  });

  it("the admin create + sign-in round trip works under the cap", async () => {
    const { env } = realEnv();
    const made = await handleApi(new Request(ORIGIN + "/api/admin/users", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-both-token-0123456789" },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    }), env, CTX);
    expect(made.status).toBe(201);
    expect((await signIn(env)).status).toBe(200);
  });

  it("an unknown user still answers 401 (the dummy hash fits the cap too)", async () => {
    const { env } = realEnv();
    const res = await signIn(env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "E_AUTH_FAILED" });
  });

  it("a legacy SHA-256 row verifies, then upgrades to the target on sign-in", async () => {
    const { env, raw } = realEnv();
    seed(raw, await legacySha256(PASSWORD, 1000));
    expect((await signIn(env)).status).toBe(200);
    const after = (raw.prepare("SELECT secret_hash FROM smtp_credentials").get() as { secret_hash: string }).secret_hash;
    expect(after).toMatch(/^pbkdf2-sha512\$100000\$/);
    expect((await signIn(env)).status).toBe(200);
  });
});

describe("#821 a row above the cap is an infra condition, never a counted guess", () => {
  async function aboveCapRow(): Promise<string> {
    const legal = await legacySha256(PASSWORD, 1000);
    return legal.replace(/^pbkdf2\$1000\$/, "pbkdf2$210000$");
  }

  it("verifySecret refuses it by throwing, before any derivation", async () => {
    await expect(verifySecret(PASSWORD, await aboveCapRow())).rejects.toThrow(/cannot be verified on this runtime/);
  });

  it("sign-in answers 503 E_AUTH_UNAVAILABLE and records no failure", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    const res = await signIn(env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_UNAVAILABLE" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM webmail_auth_failures").get()).toEqual({ n: 0 });
  });

  it("/api/smtp-auth answers non-2xx (an infra failure to the relay, not a 535)", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    const res = await handleApi(new Request(ORIGIN + "/api/smtp-auth", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer transport-token-0123456789" },
      body: JSON.stringify({ username: USER, secret: PASSWORD }),
    }), env, CTX);
    expect(res.status).toBeGreaterThanOrEqual(500);
    await expect(authenticate(env, USER, PASSWORD)).rejects.toThrow(/cannot be verified/);
  });

  it("change password on such an account answers 503 and records no failure", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    // The account cannot sign in, so mint its session directly (as an older runtime would have).
    const s = await insertSession(env, { username: USER, fromAddr: USER, displayName: null });
    const res = await handleApi(new Request(ORIGIN + "/api/session/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: SESSION_COOKIE + "=" + s.rawId + "; " + CSRF_COOKIE + "=" + s.csrfToken,
        "x-postern-csrf": s.csrfToken,
      },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "a-brand-new-password" }),
    }), env, CTX);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_UNAVAILABLE" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM webmail_auth_failures").get()).toEqual({ n: 0 });
  });

  it("an operator reset makes the account usable again", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    const res = await handleApi(new Request(ORIGIN + `/api/admin/users/${encodeURIComponent(USER)}/password`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-both-token-0123456789" },
      body: JSON.stringify({ password: "a-fresh-password-1" }),
    }), env, CTX);
    expect(res.status).toBe(200);
    expect((await signIn(env, "a-fresh-password-1")).status).toBe(200);
  });
});
