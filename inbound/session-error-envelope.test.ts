// #429: handleSession is dispatched BEFORE the try/catch that wraps every gated route,
// so an unexpected throw on the session path escaped route-level error mapping and
// surfaced as an unmapped runtime failure (handleApi itself rejecting) rather than an
// API response. Pre-existing since #351.
//
// The whole risk of the fix is the OPPOSITE failure: a generic catch that swallows the
// #409 fail-closed answers, turning "sign-in temporarily unavailable" (503, honest,
// retryable) into a flat 500, or worse letting a mint proceed unthrottled. So every
// test here is paired: the escape is now enveloped, AND each deliberate refusal still
// comes back exactly as #409 shipped it.
//
// Real SQLite with a surgical failure injection (one SQL statement throws, everything
// else runs), because a fully-fake DB would prove only that the fake throws where the
// test told it to.

import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { realEnv } from "./realdb";

const USER = "conrad@skyphusion.org";
const PASSWORD = "hunter2hunter2";
const SECRET_DETAIL = "D1_ERROR: internal detail that must not reach a client";

function sessionEnv() {
  return realEnv({ WEBMAIL_AUTH_BACKEND: "native" });
}

async function credential(db: DatabaseSync) {
  const hash = await hashSecret(PASSWORD);
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?)",
  ).run(USER, USER, hash, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
}

/** Make ONE statement fail, the way a partial D1 outage does. Everything else still
 *  runs against the real engine, so the test exercises the real path up to the fault. */
function breakStatement(env: Env, match: RegExp) {
  const real = (env as unknown as { DB: { prepare(sql: string): unknown } }).DB;
  (env as unknown as { DB: unknown }).DB = {
    prepare(sql: string) {
      if (match.test(sql)) throw new Error(SECRET_DETAIL);
      return real.prepare(sql);
    },
  };
}

function login(body: unknown = { username: USER, password: PASSWORD }): Request {
  return new Request("https://postern.example/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://postern.example" },
    body: JSON.stringify(body),
  });
}

describe("#429 an unexpected throw on the session path gets the route error envelope", () => {
  it("answers 500 JSON instead of escaping handleApi entirely", async () => {
    const { env, ctx, raw } = sessionEnv();
    await credential(raw);
    breakStatement(env, /INSERT INTO webmail_sessions/);

    // The defect: without the envelope this call REJECTS rather than resolving.
    const res = await handleApi(login(), env, ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ok: false,
      error: "E_INTERNAL_SERVER_ERROR",
      message: "session unavailable",
    });
  });

  it("discloses nothing about the failure: no internal detail, no stack", async () => {
    const { env, ctx, raw } = sessionEnv();
    await credential(raw);
    breakStatement(env, /INSERT INTO webmail_sessions/);
    const res = await handleApi(login(), env, ctx);
    const text = await res.text();
    expect(text).not.toContain(SECRET_DETAIL);
    expect(text).not.toContain("webmail_sessions");
    expect(text.toLowerCase()).not.toContain("stack");
    expect(text).not.toContain("at Object.");
  });

  it("covers the refresh route on the same pre-gate dispatch", async () => {
    const { env, ctx } = sessionEnv();
    breakStatement(env, /FROM webmail_sessions/);
    const res = await handleApi(
      new Request("https://postern.example/api/session/refresh", {
        method: "POST",
        headers: { cookie: "__Host-postern_session=whatever" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_INTERNAL_SERVER_ERROR" });
  });
});

describe("#429 the #409 fail-closed answers are NOT swallowed by the envelope", () => {
  it("keeps the 503 E_AUTH_UNAVAILABLE when the throttle store is unreadable", async () => {
    const { env, ctx, raw } = sessionEnv();
    await credential(raw);
    // The throttle gate reads webmail_auth_failures. #409 answers 503 rather than
    // letting a mint run unthrottled; that answer is a RESPONSE, and a generic catch
    // that turned it into a 500 would be this fix quietly undoing that one.
    breakStatement(env, /FROM webmail_auth_failures/);
    const res = await handleApi(login(), env, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_UNAVAILABLE" });
  });

  it("keeps 401 for a rejected credential (no enumeration, no 500)", async () => {
    const { env, ctx, raw } = sessionEnv();
    await credential(raw);
    const res = await handleApi(login({ username: USER, password: "wrong-password-here" }), env, ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_FAILED" });
  });

  it("keeps the 400 and 413 request-shape refusals", async () => {
    const { env, ctx, raw } = sessionEnv();
    await credential(raw);
    const missing = await handleApi(login({ username: USER }), env, ctx);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, error: "E_FIELD_MISSING" });

    const huge = await handleApi(
      new Request("https://postern.example/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://postern.example" },
        body: JSON.stringify({ username: USER, password: "x".repeat(8 * 1024) }),
      }),
      env,
      ctx,
    );
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ ok: false, error: "E_PAYLOAD_TOO_LARGE" });
  });

  it("POSITIVE CONTROL: a healthy sign-in still succeeds, and whoami still 401s logged out", async () => {
    const { env, ctx, raw } = sessionEnv();
    await credential(raw);
    const ok = await handleApi(login(), env, ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, identity: { from: USER } });

    const whoami = await handleApi(
      new Request("https://postern.example/api/session", { method: "GET" }),
      env,
      ctx,
    );
    expect(whoami.status).toBe(401);
    expect(await whoami.json()).toMatchObject({ ok: false, authBackend: "native" });
  });
});
