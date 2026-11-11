import { sqliteBatch } from "./test-support";
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// node URL, not the workers-types global: these are file URLs fed to node:fs (#638).
import { URL } from "node:url";
import { handleApi } from "./src/api";
import { hashIterations, hashSecret, PBKDF2_ITERATIONS, pbkdf2Iterations, TEST_PBKDF2_ITERATIONS_VAR, verifySecret } from "./src/smtpcreds";
import { insertSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";

// #821, as RULED by the lead: the deployed Workers runtime caps PBKDF2 at 100,000
// iterations and the target was 210,000, so no native credential could be created or
// verified in production. The target is PBKDF2-SHA512 at 100,000 (contract
// webmail-v2-contracts 1.10.2); a stored hash above the cap fails closed with a logged
// config error and the wrong-password answer.
//
// The cap value is written here as a literal, NOT imported from the shim module:
// importing test-setup/workers-pbkdf2-cap.ts installs the shim, so a control that did so
// would pass even if vitest.config.ts stopped loading it.
const CAP = 100_000;

const ORIGIN = "https://postern.example";
const PASSWORD = "correct-horse-battery";
const USER = "alice@skyphusion.org";
const ADMIN = "admin-both-token-0123456789";
const TRANSPORT = "transport-token-0123456789";
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function realEnv() {
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
    DB: { prepare, batch: sqliteBatch(db) }, ALLOWED_FROM_DOMAIN: "skyphusion.org", WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_API_TOKEN: ADMIN, POSTERN_TRANSPORT_TOKEN: TRANSPORT,
  } as unknown as Env;
  return { env, raw: db };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

// A hash derived at a LEGAL count, so the shim allows building it.
async function sha256Hash(secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  return ["pbkdf2", String(iterations), b64(salt), b64(bits)].join("$");
}

// An above-cap row: well-formed, labelled 210,000. The verifier must refuse it on the
// LABEL, before deriving (deriving would throw on the edge, and does under the shim).
async function aboveCapRow(): Promise<string> {
  const parts = (await sha256Hash(PASSWORD, 1000)).split("$");
  parts[1] = "210000";
  return parts.join("$");
}

function seed(db: DatabaseSync, hash: string, username = USER): void {
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  ).run(username, username, hash, "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z");
}

function post(env: Env, path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(ORIGIN + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), env, CTX);
}
const signIn = (env: Env, username = USER, password = PASSWORD) => post(env, "/api/session", { username, password });
const failures = (db: DatabaseSync, key: string) =>
  (db.prepare("SELECT failures FROM webmail_auth_failures WHERE scope_key = ?").get(key) as { failures: number } | undefined)?.failures ?? 0;

describe("#821 the suite runs under the Workers PBKDF2 cap", () => {
  it("CONTROL: the shim (loaded by setupFiles alone) refuses above the cap like the edge, and allows the cap", async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("x"), "PBKDF2", false, ["deriveBits"]);
    const salt = new Uint8Array(16);
    await expect(
      crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: CAP + 1 }, key, 256),
    ).rejects.toThrow(/iteration counts above 100000 are not supported/);
    const ok = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: CAP }, key, 256);
    expect(ok.byteLength).toBe(32);
    // One derive at the production count. The default 5000ms budget is what #909
    // exists to get the rest of the suite off; this one stays, with room.
  }, 60_000);
});

describe("#821 item 2: the target can never exceed the cap", () => {
  it("PBKDF2_ITERATIONS is at most 100,000 (red at 210,000)", () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(CAP);
  });

  it("every hash hashSecret writes parses to at most 100,000, and is SHA-512 at the active target (#828)", async () => {
    const count = pbkdf2Iterations();
    // The suite override is on. Equal to PBKDF2_ITERATIONS means #909 is gone and
    // the sign-in tests are back on vitest's 5000ms default.
    expect(count).toBeLessThan(PBKDF2_ITERATIONS);
    expect(count).toBeLessThanOrEqual(CAP);
    for (let i = 0; i < 3; i++) {
      const h = await hashSecret(PASSWORD + i);
      expect(hashIterations(h)).toBe(count);
      const [tag, iters, saltB64, hashB64] = h.split("$");
      expect([tag, iters]).toEqual(["pbkdf2-sha512", String(count)]);
      // Independent derivation: the stored bytes ARE PBKDF2-HMAC-SHA512 at that count (#828).
      const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD + i), "PBKDF2", false, ["deriveBits"]);
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations: count }, key, 512));
      expect(b64(bits)).toBe(hashB64);
    }
  });

  it("an unset override hashes at 100,000, and the shipping configs never set it", async () => {
    for (const name of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
      const text = readFileSync(new URL("./" + name, import.meta.url), "utf8");
      expect(text, name).not.toContain(TEST_PBKDF2_ITERATIONS_VAR);
    }
    // An empty binding is "not set" and must not consult the suite's process override.
    const prod = { POSTERN_TEST_PBKDF2_ITERATIONS: "" };
    expect(pbkdf2Iterations(prod)).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBe(CAP);
    const h = await hashSecret(PASSWORD, prod);
    const [tag, iters, saltB64, hashB64] = h.split("$");
    expect([tag, iters]).toEqual(["pbkdf2-sha512", String(CAP)]);
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations: CAP }, key, 512));
    expect(b64(bits)).toBe(hashB64);
  }, 60_000);

  it("the Worker env binding selects the count, and an invalid one stays at the production count", async () => {
    const h = await hashSecret(PASSWORD, { POSTERN_TEST_PBKDF2_ITERATIONS: "2500" });
    expect(h.split("$")[1]).toBe("2500");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(pbkdf2Iterations({ POSTERN_TEST_PBKDF2_ITERATIONS: "nope" })).toBe(PBKDF2_ITERATIONS);
      expect(pbkdf2Iterations({ POSTERN_TEST_PBKDF2_ITERATIONS: "100001" })).toBe(PBKDF2_ITERATIONS);
      expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("config error");
    } finally {
      spy.mockRestore();
    }
  });

  it("an invalid process override is ignored in favour of the production count", () => {
    const prev = process.env.POSTERN_TEST_PBKDF2_ITERATIONS;
    process.env.POSTERN_TEST_PBKDF2_ITERATIONS = "nope";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(pbkdf2Iterations()).toBe(PBKDF2_ITERATIONS);
    } finally {
      if (prev === undefined) delete process.env.POSTERN_TEST_PBKDF2_ITERATIONS;
      else process.env.POSTERN_TEST_PBKDF2_ITERATIONS = prev;
      spy.mockRestore();
    }
  });
});

describe("#821 the auth paths work under the cap", () => {
  it("admin create + sign-in round trip", async () => {
    const { env } = realEnv();
    const made = await post(env, "/api/admin/users", { username: USER, password: PASSWORD }, { authorization: "Bearer " + ADMIN });
    expect(made.status).toBe(201);
    expect((await signIn(env)).status).toBe(200);
  });

  it("an unknown user answers 401, not a 5xx (the dummy hash is at the cap too)", async () => {
    const { env } = realEnv();
    const res = await signIn(env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "E_AUTH_FAILED" });
  });

  it("item 4: a lower-count row is re-hashed at the active target on sign-in, never above the cap", async () => {
    const { env, raw } = realEnv();
    seed(raw, await sha256Hash(PASSWORD, 1));
    expect((await signIn(env)).status).toBe(200);
    const after = (raw.prepare("SELECT secret_hash FROM smtp_credentials").get() as { secret_hash: string }).secret_hash;
    expect(hashIterations(after)).toBe(pbkdf2Iterations());
    expect(hashIterations(after)).toBeLessThanOrEqual(CAP);
    expect((await signIn(env)).status).toBe(200);
  });

  it("a row already at the target is not re-written", async () => {
    const { env, raw } = realEnv();
    const h = await hashSecret(PASSWORD);
    seed(raw, h);
    expect((await signIn(env)).status).toBe(200);
    expect((raw.prepare("SELECT secret_hash FROM smtp_credentials").get() as { secret_hash: string }).secret_hash).toBe(h);
  });
});

describe("#821 item 3: a row above the cap fails closed as a wrong password", () => {
  it("verifySecret returns false (no throw) and logs a config error naming the account", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await verifySecret(PASSWORD, await aboveCapRow(), USER)).toBe(false);
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("config error");
      expect(logged).toContain(USER);
      expect(logged).toContain("210000");
    } finally {
      spy.mockRestore();
    }
  });

  it("costs exactly the work of a wrong password: one derive at the active target, none above (timing)", async () => {
    // Build both rows BEFORE spying: building them derives too, and must not be counted.
    const capped = await aboveCapRow();
    const real = await hashSecret(PASSWORD);
    const proto = Object.getPrototypeOf(crypto.subtle) as { deriveBits: (...a: unknown[]) => Promise<ArrayBuffer> };
    const spy = vi.spyOn(proto, "deriveBits");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const counts = () => spy.mock.calls.map((c) => (c[0] as { iterations?: number }).iterations);
    try {
      // The over-cap path.
      expect(await verifySecret(PASSWORD, capped, USER)).toBe(false);
      const overCap = counts();
      spy.mockClear();
      // The comparison: a wrong password against a real row at the target.
      expect(await verifySecret("not-the-password", real, USER)).toBe(false);
      const wrong = counts();
      expect(wrong).toEqual([pbkdf2Iterations()]);
      expect(overCap).toEqual(wrong);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
  });

  it("sign-in answers byte-for-byte what a wrong password answers, and counts like one", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    seed(raw, await hashSecret(PASSWORD), "bob@skyphusion.org");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const capped = await signIn(env);
      const wrong = await signIn(env, "bob@skyphusion.org", "not-the-password");
      expect(capped.status).toBe(401);
      expect([capped.status, await capped.text()]).toEqual([wrong.status, await wrong.text()]);
      expect(failures(raw, "a:" + USER)).toBe(1);
      expect(failures(raw, "a:bob@skyphusion.org")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("/api/smtp-auth answers the wrong-password shape (200 ok:false), never a 5xx", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post(env, "/api/smtp-auth", { username: USER, secret: PASSWORD }, { authorization: "Bearer " + TRANSPORT });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: "E_AUTH_FAILED" });
      expect(text).not.toContain("Pbkdf2");
    } finally {
      spy.mockRestore();
    }
  });

  it("change password answers 401 E_AUTH_FAILED, never a 5xx", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    // The account cannot sign in, so mint its session directly (as an older runtime would have).
    const s = await insertSession(env, { username: USER, fromAddr: USER, displayName: null });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post(env, "/api/session/password", { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }, {
        cookie: SESSION_COOKIE + "=" + s.rawId + "; " + CSRF_COOKIE + "=" + s.csrfToken,
        "x-postern-csrf": s.csrfToken,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "E_AUTH_FAILED" });
    } finally {
      spy.mockRestore();
    }
  });

  it("an operator reset makes the account usable again", async () => {
    const { env, raw } = realEnv();
    seed(raw, await aboveCapRow());
    const res = await post(env, "/api/admin/users/" + encodeURIComponent(USER) + "/password",
      { password: "a-fresh-password-1" }, { authorization: "Bearer " + ADMIN });
    expect(res.status).toBe(200);
    expect((await signIn(env, USER, "a-fresh-password-1")).status).toBe(200);
  });
});
