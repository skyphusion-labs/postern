// #442: /api/smtp-auth and /ingest share the pre-gate construction #429/#441 fixed for
// the session path. Both are dispatched BEFORE the try/catch that wraps every gated
// route; smtp-auth had no catch of its own at all (an unexpected throw escaped handleApi
// entirely), and /ingest had one that routed unknown errors through errorResponse, which
// echoes err.message and answers 400 for any code outside RETRYABLE.
//
// These are the MAIL seams, so the answer is transport behavior, not cosmetics. Their
// callers branch on the STATUS: relay/client.go tests `StatusCode/100 != 2` and maps any
// non-2xx to SMTP 451 (transient, the MTA retries); relay/submit_client.go parses the
// body ONLY on a 2xx, and treats a non-2xx as an infra error that is logged and kept OUT
// of the #105 per-account throttle. So a 200 {ok:false} on an internal failure would be
// read as "wrong password" (permanent 535 plus a throttle strike per attempt, locking
// every user out during a D1 outage), and a 400 would be read as a permanent client
// fault. Both tests below assert the CALLER-visible property, not just the number.
//
// Real SQLite with a surgical failure injection (one SQL statement throws, everything
// else runs), because a fully-fake DB would prove only that the fake throws where the
// test told it to. The deliberate refusals are kept as positive controls: an envelope
// that swallowed them would be this fix quietly breaking the seams it is protecting.

import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./src/api";
import { hashSecret } from "./src/smtpcreds";
import { realEnv } from "./realdb";

const TT = "transport-secret";
const USER = "conrad@skyphusion.org";
const PASSWORD = "hunter2hunter2";
const SECRET_DETAIL = "D1_ERROR: internal detail that must not reach a client";

// TRUSTED_SENDER_DOMAINS is declared REQUIRED in Env and shipped as "" by both
// wrangler configs, so production always has it; realEnv does not set it. isTrusted()
// now guards the read (#473), so an absent var no longer throws here, but this harness
// still sets it EXPLICITLY: these tests must fail on the INJECTED fault and on nothing
// else, and pinning the trust input keeps that true. The positive control is what
// caught the original under-specification, which is exactly what it is for.
function seamEnv() {
  return realEnv({ POSTERN_TRANSPORT_TOKEN: TT, TRUSTED_SENDER_DOMAINS: "" });
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

function authReq(body: unknown, token: string | undefined = TT): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request("https://postern.example/api/smtp-auth", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ingestReq(body: unknown, token: string | undefined = TT): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request("https://postern.example/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const mail = () => ({
  messageId: "envelope442@example.com",
  from: "sender@example.com",
  to: "support@skyphusion.org",
  subject: "s",
  text: "body",
});

describe("#442 an unexpected throw on /api/smtp-auth gets the pre-gate error envelope", () => {
  it("answers 500 JSON instead of escaping handleApi entirely", async () => {
    const { env, ctx, raw } = seamEnv();
    await credential(raw);
    breakStatement(env, /FROM smtp_credentials/);

    // The defect: without the envelope this call REJECTS rather than resolving.
    const res = await handleApi(authReq({ username: USER, secret: PASSWORD }), env, ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ok: false,
      error: "E_INTERNAL_SERVER_ERROR",
      message: "auth check unavailable",
    });
  });

  it("is NOT a 2xx, so the relay reads an outage as infra and not as a wrong password", async () => {
    const { env, ctx, raw } = seamEnv();
    await credential(raw);
    breakStatement(env, /FROM smtp_credentials/);
    const res = await handleApi(authReq({ username: USER, secret: PASSWORD }), env, ctx);

    // relay/submit_client.go Authenticate: it parses {ok, from} ONLY on a 2xx, and a
    // parsed ok:false is errAuthFailed -> SMTP 535 AND a #105 throttle strike. A non-2xx
    // is an infra error: logged, generic 535 to the client, throttle deliberately NOT
    // touched, so an outage cannot lock every account out.
    const relayWouldCallItABadCredential = Math.floor(res.status / 100) === 2;
    expect(relayWouldCallItABadCredential).toBe(false);
    expect(Math.floor(res.status / 100)).toBe(5);
  });

  it("discloses nothing about the failure: no internal detail, no table name, no stack", async () => {
    const { env, ctx, raw } = seamEnv();
    await credential(raw);
    breakStatement(env, /FROM smtp_credentials/);
    const text = await (await handleApi(authReq({ username: USER, secret: PASSWORD }), env, ctx)).text();
    expect(text).not.toContain(SECRET_DETAIL);
    expect(text).not.toContain("smtp_credentials");
    expect(text.toLowerCase()).not.toContain("stack");
    expect(text).not.toContain("at Object.");
  });
});

describe("#442 the /api/smtp-auth refusals are NOT swallowed by the envelope", () => {
  it("POSITIVE CONTROL: a good credential still returns 200 {ok:true, from}", async () => {
    const { env, ctx, raw } = seamEnv();
    await credential(raw);
    const res = await handleApi(authReq({ username: USER, secret: PASSWORD }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, from: USER });
  });

  it("keeps 200 {ok:false, E_AUTH_FAILED} for a bad credential (the relay maps it to 535)", async () => {
    const { env, ctx, raw } = seamEnv();
    await credential(raw);
    const res = await handleApi(authReq({ username: USER, secret: "wrong-password-here" }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_AUTH_FAILED" });
  });

  it("keeps 401 for a wrong transport token and for an unbound one (fail closed)", async () => {
    const { env, ctx, raw } = seamEnv();
    await credential(raw);
    const wrong = await handleApi(authReq({ username: USER, secret: PASSWORD }, "nope"), env, ctx);
    expect(wrong.status).toBe(401);

    const { env: unbound, ctx: ctx2 } = realEnv(); // no POSTERN_TRANSPORT_TOKEN at all
    const res = await handleApi(authReq({ username: USER, secret: PASSWORD }, "anything"), unbound, ctx2);
    expect(res.status).toBe(401);
  });

  it("keeps the 400 request-shape refusals", async () => {
    const { env, ctx } = seamEnv();
    const missing = await handleApi(authReq({ username: USER }), env, ctx);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, error: "E_FIELD_MISSING" });

    const bad = await handleApi(authReq("{not json"), env, ctx);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
  });
});

describe("#442 an unexpected throw on /ingest answers a fixed 500, not an echoed errorResponse", () => {
  it("answers the fixed envelope where errorResponse gave a code-dependent status", async () => {
    const { env, ctx } = seamEnv();
    breakStatement(env, /INSERT INTO messages/);
    const res = await handleApi(ingestReq(mail()), env, ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ok: false,
      error: "E_INTERNAL_SERVER_ERROR",
      message: "ingest unavailable",
    });
  });

  it("stays transient to the relay, so the sending MTA still retries (SMTP 451)", async () => {
    const { env, ctx } = seamEnv();
    breakStatement(env, /INSERT INTO messages/);
    const res = await handleApi(ingestReq(mail()), env, ctx);

    // relay/client.go post(): `StatusCode/100 != 2` is the whole branch, and smtp.go maps
    // that one error to a fixed 451 4.3.0. Assert the stronger property as well -- 5xx --
    // so a driver that distinguishes a permanent 4xx from a transient 5xx (the standard
    // reading, and what errorResponse would have produced for a code outside RETRYABLE)
    // also retries rather than bouncing the mail.
    expect(Math.floor(res.status / 100)).not.toBe(2);
    expect(Math.floor(res.status / 100)).toBe(5);
  });

  it("discloses nothing: the relay logs the response body verbatim", async () => {
    const { env, ctx } = seamEnv();
    breakStatement(env, /INSERT INTO messages/);
    const text = await (await handleApi(ingestReq(mail()), env, ctx)).text();
    expect(text).not.toContain(SECRET_DETAIL);
    expect(text).not.toContain("INSERT INTO");
    expect(text).not.toContain("messages");
    expect(text.toLowerCase()).not.toContain("stack");
    expect(text).not.toContain("at Object.");
  });
});

describe("#442 the /ingest refusals are NOT swallowed by the envelope", () => {
  it("POSITIVE CONTROL: a healthy ingest still stores and returns 200 {ok:true}", async () => {
    const { env, ctx } = seamEnv();
    const res = await handleApi(ingestReq(mail()), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      messageId: "envelope442@example.com",
      stored: true,
      merged: false,
    });
  });

  it("keeps 401 for a wrong transport token and for an unbound one (fail closed)", async () => {
    const { env, ctx } = seamEnv();
    expect((await handleApi(ingestReq(mail(), "nope"), env, ctx)).status).toBe(401);

    const { env: unbound, ctx: ctx2 } = realEnv(); // no POSTERN_TRANSPORT_TOKEN at all
    expect((await handleApi(ingestReq(mail(), "anything"), unbound, ctx2)).status).toBe(401);
  });

  it("keeps the structured MailboxError refusals with their own status", async () => {
    const { env, ctx } = seamEnv();
    const noTo = await handleApi(ingestReq({ from: "a@example.com" }), env, ctx);
    expect(noTo.status).toBe(400);
    expect(await noTo.json()).toMatchObject({ ok: false, error: "E_FIELD_MISSING" });

    const badJson = await handleApi(ingestReq("{not json"), env, ctx);
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });

    const badB64 = await handleApi(
      ingestReq({ ...mail(), attachments: [{ filename: "x.txt", content: "!!!not base64!!!" }] }),
      env,
      ctx,
    );
    expect(badB64.status).toBe(400);
    expect(await badB64.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
  });

  it("keeps the 405 on a non-POST /ingest", async () => {
    const { env, ctx } = seamEnv();
    const res = await handleApi(
      new Request("https://postern.example/ingest", {
        method: "GET",
        headers: { authorization: `Bearer ${TT}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(405);
  });
});
