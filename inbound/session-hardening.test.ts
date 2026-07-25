import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { pruneAuthFailures } from "./src/auththrottle";
import { SESSION_COOKIE } from "./src/session";

// #409 hardening of POST /api/session: the durable brute-force lockout, the body cap,
// and the login-CSRF origin check.
//
// These run against a REAL sqlite database built from schema.sql (the same harness
// durable-mailboxes-sql.test.ts uses), NOT a hand-written fake: the throttle lives or
// dies on actual SQL (an IN-list read, an ON CONFLICT upsert, a PRIMARY KEY), and a
// regex fake would only prove that the fake agrees with itself. Migration 0014 is
// exercised separately, on its own empty database, so BOTH the fresh-DB path
// (schema.sql) and the upgrade path (migrations/) are verified.

const PASSWORD = "hunter2hunter2";
const USER = "conrad@skyphusion.org";

function realEnv(overrides: Record<string, unknown> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const seenSql: string[] = [];

  function prepare(sql: string) {
    seenSql.push(sql);
    const stmt = db.prepare(sql);
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async all<T>() {
        return { results: stmt.all(...(bound as never[])) as unknown as T[] };
      },
      async first<T>() {
        return (stmt.get(...(bound as never[])) ?? null) as T | null;
      },
      async run() {
        const result = stmt.run(...(bound as never[]));
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }

  const env = {
    DB: { prepare },
    ALLOWED_FROM_DOMAIN: "skyphusion.org",
    WEBMAIL_AUTH_BACKEND: "native",
    ...overrides,
  } as unknown as Env;
  return { env, raw: db, seenSql };
}

async function seedCredential(db: DatabaseSync, username = USER, password = PASSWORD): Promise<void> {
  const hash = await hashSecret(password);
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?)",
  ).run(username, username, hash, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface MintOpts {
  username?: string;
  password?: string;
  ip?: string;
  origin?: string;
  fetchSite?: string;
  rawBody?: string;
}

function mintRequest(opts: MintOpts = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (opts.origin) headers["origin"] = opts.origin;
  if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite;
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : JSON.stringify({ username: opts.username ?? USER, password: opts.password ?? PASSWORD });
  return new Request("https://postern.example/api/session", { method: "POST", headers, body });
}

function mint(env: Env, opts: MintOpts = {}): Promise<Response> {
  return handleApi(mintRequest(opts), env, CTX);
}

function failureRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM webmail_auth_failures ORDER BY scope_key").all() as Array<
    Record<string, unknown>
  >;
}

// --- part 1: the durable brute-force lockout --------------------------------

describe("#409 POST /api/session lockout (durable, ported from relay/throttle.go)", () => {
  it("trips at the threshold: 5 rejections stay 401, the 6th is 429 with Retry-After", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "5", WEBMAIL_AUTH_LOCKOUT_SECONDS: "120" });
    await seedCredential(raw);

    for (let i = 0; i < 5; i++) {
      const res = await mint(env, { password: "wrong" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_FAILED" });
    }
    const locked = await mint(env, { password: "wrong" });
    expect(locked.status).toBe(429);
    const retryAfter = Number(locked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(120);
    expect(await locked.json()).toMatchObject({
      ok: false,
      error: "E_RATE_LIMITED",
      retryAfter,
    });

    const rows = failureRows(raw);
    expect(rows.length).toBe(1); // account layer only: no client IP header, global off
    expect(rows[0].scope_key).toBe("a:" + USER);
    expect(rows[0].failures).toBe(5);
    expect(rows[0].locked_until).toBeTruthy();
  });

  it("locks out the CORRECT password too once tripped (the lock precedes the verifier)", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "2" });
    await seedCredential(raw);
    await mint(env, { password: "wrong" });
    await mint(env, { password: "wrong" });
    const good = await mint(env);
    expect(good.status).toBe(429);
    // Nothing was minted, so a locked-out attacker gains nothing by guessing right.
    expect((raw.prepare("SELECT COUNT(*) AS n FROM webmail_sessions").get() as { n: number }).n).toBe(0);
  });

  it("does NOT extend its own lockout when knocked on again (relay: allow-denied never calls fail)", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "2", WEBMAIL_AUTH_LOCKOUT_SECONDS: "300" });
    await seedCredential(raw);
    await mint(env, { password: "wrong" });
    await mint(env, { password: "wrong" });
    const before = failureRows(raw)[0];
    await mint(env, { password: "wrong" });
    await mint(env, { password: "wrong" });
    const after = failureRows(raw)[0];
    expect(after.locked_until).toBe(before.locked_until);
    expect(after.failures).toBe(before.failures);
  });

  it("is enumeration-safe: an UNKNOWN username throttles identically, same 401 body", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "3" });
    await seedCredential(raw);

    const knownBad = await mint(env, { password: "wrong" });
    const unknownBad = await mint(env, { username: "ghost@skyphusion.org", password: "wrong" });
    expect(knownBad.status).toBe(unknownBad.status);
    expect(await knownBad.text()).toBe(await unknownBad.text());

    // The unknown name reaches its own lockout on the same schedule as a real one.
    await mint(env, { username: "ghost@skyphusion.org", password: "wrong" });
    await mint(env, { username: "ghost@skyphusion.org", password: "wrong" });
    const ghostLocked = await mint(env, { username: "ghost@skyphusion.org", password: "wrong" });
    expect(ghostLocked.status).toBe(429);
    expect(failureRows(raw).map((r) => r.scope_key)).toContain("a:ghost@skyphusion.org");
  });

  it("shares one budget across case variants of the same login", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "2" });
    await seedCredential(raw);
    await mint(env, { username: "CONRAD@Skyphusion.org", password: "wrong" });
    await mint(env, { username: "conrad@skyphusion.org", password: "wrong" });
    const rows = failureRows(raw);
    expect(rows.length).toBe(1);
    expect(rows[0].failures).toBe(2);
  });

  it("resets the account counter on a correct password, and starts the next streak at 1", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "5" });
    await seedCredential(raw);
    await mint(env, { password: "wrong" });
    await mint(env, { password: "wrong" });
    expect(failureRows(raw)[0].failures).toBe(2);

    const ok = await mint(env);
    expect(ok.status).toBe(200);
    expect(failureRows(raw).length).toBe(0);

    await mint(env, { password: "wrong" });
    expect(failureRows(raw)[0].failures).toBe(1);
  });

  it("adds NO throttle write to a clean successful login (recording proxy over every run())", async () => {
    // The dispatch constraint: counting failures must not cost a D1 write on every
    // success. Assert on what was PASSED to the store, not on final state -- a
    // point-in-time row read cannot see a write-then-delete.
    const { env, raw, seenSql } = realEnv();
    await seedCredential(raw);
    const before = seenSql.length;
    const res = await mint(env);
    expect(res.status).toBe(200);
    const statements = seenSql.slice(before);
    // CONTROL: the proxy really is recording (the mint wrote its session row).
    expect(statements.some((sql) => /INSERT INTO webmail_sessions/i.test(sql))).toBe(true);
    // The claim: not one statement touched the counter table except the gate READ.
    const touched = statements.filter((sql) => /webmail_auth_failures/i.test(sql));
    expect(touched.length).toBe(1);
    expect(touched[0]).toMatch(/^SELECT/i);
  });

  it("expires the lockout: once locked_until has passed, the door reopens", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "2" });
    await seedCredential(raw);
    await mint(env, { password: "wrong" });
    await mint(env, { password: "wrong" });
    expect((await mint(env)).status).toBe(429);
    // Wind the stored expiry into the past (a real clock would take minutes).
    raw.prepare("UPDATE webmail_auth_failures SET locked_until = ?").run("2000-01-01T00:00:00.000Z");
    expect((await mint(env)).status).toBe(200);
  });

  it("catches spread-spraying on the client-IP layer, and leaves other clients alone", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "3" });
    await seedCredential(raw);
    // Three DIFFERENT usernames, one guess each: no account key ever reaches the
    // threshold, so only the per-IP layer can catch this.
    for (const name of ["a@skyphusion.org", "b@skyphusion.org", "c@skyphusion.org"]) {
      const res = await mint(env, { username: name, password: "wrong", ip: "203.0.113.9" });
      expect(res.status).toBe(401);
    }
    const sprayed = await mint(env, { username: "d@skyphusion.org", password: "wrong", ip: "203.0.113.9" });
    expect(sprayed.status).toBe(429);
    expect(failureRows(raw).map((r) => r.scope_key)).toContain("i:203.0.113.9");

    // CONTROL: a different client is untouched, and the real user can still sign in
    // from it -- the per-IP layer is not a global denial lever.
    const elsewhere = await mint(env, { ip: "198.51.100.4" });
    expect(elsewhere.status).toBe(200);
  });

  it("does not clear the client-IP layer when one valid credential succeeds", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "3" });
    await seedCredential(raw);
    await mint(env, { username: "a@skyphusion.org", password: "wrong", ip: "203.0.113.9" });
    await mint(env, { username: "b@skyphusion.org", password: "wrong", ip: "203.0.113.9" });
    const ok = await mint(env, { ip: "203.0.113.9" });
    expect(ok.status).toBe(200);
    const ipRow = failureRows(raw).find((r) => r.scope_key === "i:203.0.113.9");
    expect(ipRow).toBeTruthy();
    expect(ipRow!.failures).toBe(2); // NOT reset by the success
  });

  it("keeps the GLOBAL layer off by default (no global denial lever on a public endpoint)", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_FAILURES: "2" });
    await seedCredential(raw);
    for (let i = 0; i < 4; i++) {
      await mint(env, { username: "spray" + i + "@skyphusion.org", password: "wrong", ip: "203.0.113.5" });
    }
    expect(failureRows(raw).map((r) => r.scope_key)).not.toContain("g:all");
    // A bystander on a different IP with a different account still signs in.
    expect((await mint(env, { ip: "198.51.100.7" })).status).toBe(200);
  });

  it("honours an opted-in GLOBAL ceiling: it cools down every mint for one window", async () => {
    const { env, raw } = realEnv({
      WEBMAIL_AUTH_MAX_FAILURES: "50",
      WEBMAIL_AUTH_GLOBAL_MAX: "2",
      WEBMAIL_AUTH_GLOBAL_WINDOW_SECONDS: "300",
    });
    await seedCredential(raw);
    for (let i = 0; i < 3; i++) {
      await mint(env, { username: "spray" + i + "@skyphusion.org", password: "wrong", ip: "203.0.113." + i });
    }
    const globalRow = failureRows(raw).find((r) => r.scope_key === "g:all");
    expect(globalRow).toBeTruthy();
    // A completely unrelated, valid login is now cooled down too (the accepted cost).
    const bystander = await mint(env, { ip: "198.51.100.20" });
    expect(bystander.status).toBe(429);
  });

  it("fails CLOSED when the counter store is unreadable: 503, and NO session is minted", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    // CONTROL first: with the store healthy this exact request mints.
    expect((await mint(env)).status).toBe(200);
    raw.prepare("DELETE FROM webmail_sessions").run();

    // Now break ONLY the counter read (the real refusal path, not a stand-in).
    const brokenEnv = {
      ...(env as unknown as Record<string, unknown>),
      DB: {
        prepare(sql: string) {
          if (/webmail_auth_failures/i.test(sql)) throw new Error("D1_ERROR: no such table");
          return (env as unknown as { DB: { prepare: (s: string) => unknown } }).DB.prepare(sql);
        },
      },
    } as unknown as Env;
    const res = await mint(brokenEnv);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_UNAVAILABLE" });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM webmail_sessions").get() as { n: number }).n).toBe(0);
  });

  it("prunes only decayed, unlocked rows", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_MAX_LOCKOUT_SECONDS: "60" });
    raw
      .prepare(
        "INSERT INTO webmail_auth_failures (scope_key, failures, window_start_at, last_failure_at, locked_until) VALUES (?, ?, ?, ?, ?)",
      )
      .run("a:old@skyphusion.org", 1, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", null);
    const fresh = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO webmail_auth_failures (scope_key, failures, window_start_at, last_failure_at, locked_until) VALUES (?, ?, ?, ?, ?)",
      )
      .run("a:live@skyphusion.org", 9, fresh, fresh, new Date(Date.now() + 60000).toISOString());
    expect(await pruneAuthFailures(env)).toBe(1);
    expect(failureRows(raw).map((r) => r.scope_key)).toEqual(["a:live@skyphusion.org"]);
  });

  it("can be switched off explicitly, and then records nothing (documented escape hatch)", async () => {
    const { env, raw } = realEnv({ WEBMAIL_AUTH_THROTTLE: "off", WEBMAIL_AUTH_MAX_FAILURES: "2" });
    await seedCredential(raw);
    for (let i = 0; i < 4; i++) {
      const res = await mint(env, { password: "wrong" });
      expect(res.status).toBe(401);
    }
    expect(failureRows(raw).length).toBe(0);
  });
});

// --- part 2: the body cap ---------------------------------------------------

describe("#409 POST /api/session body cap", () => {
  it("413s an oversized body with the readJson error shape, before any verify or count", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    const huge = JSON.stringify({ username: USER, password: "x".repeat(8 * 1024) });
    const res = await mint(env, { rawBody: huge });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_PAYLOAD_TOO_LARGE" });
    // A malformed/oversized request is not a credential guess: nothing is counted.
    expect(failureRows(raw).length).toBe(0);
  });

  it("413s an oversized CHUNKED body too (no content-length to fast-reject on)", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    const payload = new TextEncoder().encode(
      JSON.stringify({ username: USER, password: "x".repeat(8 * 1024) }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const req = new Request("https://postern.example/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required by undici for a streaming body
      duplex: "half",
    });
    const res = await handleApi(req, env, CTX);
    expect(res.status).toBe(413);
  });

  it("CONTROL: a normal-size body still mints", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    expect((await mint(env)).status).toBe(200);
  });
});

// --- part 3: the login-CSRF origin check ------------------------------------

describe("#409 POST /api/session origin check (login CSRF)", () => {
  it("refuses a cross-site or same-site mint by Sec-Fetch-Site", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    for (const site of ["cross-site", "same-site"]) {
      const res = await mint(env, { fetchSite: site });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "E_CROSS_ORIGIN" });
    }
    // Refused BEFORE the verifier, so a forced login costs no PBKDF2 and mints nothing.
    expect((raw.prepare("SELECT COUNT(*) AS n FROM webmail_sessions").get() as { n: number }).n).toBe(0);
  });

  it("refuses a foreign Origin header, and a literal null Origin", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    expect((await mint(env, { origin: "https://evil.example" })).status).toBe(403);
    expect((await mint(env, { origin: "null" })).status).toBe(403);
  });

  it("allows same-origin, Sec-Fetch-Site: none, and a matching Origin", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    const sameOrigin = await mint(env, { fetchSite: "same-origin", origin: "https://postern.example" });
    expect(sameOrigin.status).toBe(200);
    expect((await mint(env, { fetchSite: "none" })).status).toBe(200);
    expect((await mint(env, { origin: "https://postern.example" })).status).toBe(200);
    // Sec-Fetch-Site wins over Origin when both are present (browser-authoritative).
    const conflicting = await mint(env, { fetchSite: "cross-site", origin: "https://postern.example" });
    expect(conflicting.status).toBe(403);
  });

  it("allows a non-browser client that sends neither header (curl, the Python client, MCP)", async () => {
    const { env, raw } = realEnv();
    await seedCredential(raw);
    const res = await mint(env);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie.includes(SESSION_COOKIE) || setCookie === "").toBe(true);
  });
});

// --- migration 0014 (the upgrade path, not just schema.sql) ------------------

describe("#409 migration 0014", () => {
  it("applies to an empty database and accepts the same rows schema.sql does", () => {
    const migrated = new DatabaseSync(":memory:");
    migrated.exec(
      readFileSync(new URL("./migrations/0014_webmail_auth_failures.sql", import.meta.url), "utf8"),
    );
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

    const insert =
      "INSERT INTO webmail_auth_failures (scope_key, failures, window_start_at, last_failure_at, locked_until) VALUES (?, ?, ?, ?, ?)";
    for (const db of [migrated, fresh]) {
      db.prepare(insert).run("a:x@skyphusion.org", 1, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z", null);
      // scope_key is the PRIMARY KEY: one row per scope, upserts collapse onto it.
      expect(() =>
        db.prepare(insert).run("a:x@skyphusion.org", 2, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z", null),
      ).toThrow();
      const row = db.prepare("SELECT * FROM webmail_auth_failures").get() as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual([
        "failures",
        "last_failure_at",
        "locked_until",
        "scope_key",
        "window_start_at",
      ]);
    }
  });

  it("is re-runnable (IF NOT EXISTS) and carries no destructive statement", () => {
    const sql = readFileSync(
      new URL("./migrations/0014_webmail_auth_failures.sql", import.meta.url),
      "utf8",
    );
    const db = new DatabaseSync(":memory:");
    db.exec(sql);
    expect(() => db.exec(sql)).not.toThrow();
    const bare = sql.replace(/--[^\n]*/g, " ");
    expect(bare).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\b|\bRENAME\b/i);
  });
});
