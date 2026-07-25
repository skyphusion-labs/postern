import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { hashSecret } from "./src/smtpcreds";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";

// #410: POST /api/messages/seen was the one route in its family of three that trusted
// body.for verbatim and never consulted the session resolution, so a session-authed
// user could write ANOTHER account per-recipient read state, or (by omitting `for`)
// flip ROW-LEVEL messages.seen on messages the same session would be denied on read.
//
// Real sqlite from schema.sql: the fix is an SQL access predicate, so a fake would
// only prove the fake agrees with itself. The negatives matter most here, and so does
// the CONTROL: bearer-token behavior must stay byte-identical, because the IMAP door
// passes `for` with a token and is legitimately estate-scoped (#350/#357).

const MINE = "mine@example.com";
const THEIRS = "theirs@example.com";
const OWNER = "conrad@skyphusion.org";
const OTHER = "other@skyphusion.org";
const PASSWORD = "hunter2hunter2";
const TOKEN = "estate-token";

function realEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  function prepare(sql: string) {
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
    POSTERN_API_TOKEN: TOKEN,
  } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return { env, ctx, raw: db };
}

async function seedMessage(env: Env, ctx: ExecutionContext, id: string, to: string): Promise<void> {
  await store.put(
    env,
    {
      messageId: id,
      direction: "inbound",
      from: "sender@example.com",
      to,
      deliveredTo: [to],
      subject: "subject",
      date: "2026-07-26T00:00:00.000Z",
      bodyText: "body",
      auth: { spf: "none", dkim: "none", dmarc: "none" },
      trusted: false,
    },
    ctx,
  );
}

async function seedCredential(db: DatabaseSync): Promise<void> {
  const hash = await hashSecret(PASSWORD);
  db.prepare(
    "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?)",
  ).run(OWNER, OWNER, hash, "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
}

function seenRow(db: DatabaseSync, id: string): number {
  return (db.prepare("SELECT seen FROM messages WHERE message_id = ?").get(id) as { seen: number }).seen;
}
function overrides(db: DatabaseSync): Array<{ message_id: string; recipient: string; seen: number }> {
  return db
    .prepare("SELECT message_id, recipient, seen FROM message_seen_by ORDER BY message_id, recipient")
    .all() as Array<{ message_id: string; recipient: string; seen: number }>;
}

function seenRequest(body: unknown, opts: { cookie?: string; csrf?: string; token?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.csrf) headers["x-postern-csrf"] = opts.csrf;
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  return new Request("https://postern.example/api/messages/seen", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function sessionAuth(env: Env, raw: DatabaseSync) {
  await seedCredential(raw);
  const minted = await mintNativeSession(env, OWNER, PASSWORD);
  return {
    cookie: `${SESSION_COOKIE}=${minted!.rawId}; ${CSRF_COOKIE}=${minted!.csrfToken}`,
    csrf: minted!.csrfToken,
  };
}

describe("#410 POST /api/messages/seen binds the session viewer", () => {
  it("403s a `for` that is not the session identity, and writes NOTHING", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, MINE, OWNER);
    const auth = await sessionAuth(env, raw);
    const res = await handleApi(
      seenRequest({ ids: [MINE], seen: true, for: OTHER }, auth),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_FORBIDDEN" });
    expect(overrides(raw).length).toBe(0);
    expect(seenRow(raw, MINE)).toBe(0);
  });

  it("accepts an explicit `for` that MATCHES the session identity", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, MINE, OWNER);
    const auth = await sessionAuth(env, raw);
    const res = await handleApi(
      seenRequest({ ids: [MINE], seen: true, for: OWNER.toUpperCase() }, auth),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
    expect(overrides(raw)).toEqual([{ message_id: MINE, recipient: OWNER, seen: 1 }]);
    expect(seenRow(raw, MINE)).toBe(0); // row-level estate flag untouched
  });

  it("with NO `for`, a session write stays per-recipient: row-level messages.seen is never flipped", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, MINE, OWNER);
    const auth = await sessionAuth(env, raw);
    const res = await handleApi(seenRequest({ ids: [MINE], seen: true }, auth), env, ctx);
    expect(res.status).toBe(200);
    expect(seenRow(raw, MINE)).toBe(0);
    expect(overrides(raw)).toEqual([{ message_id: MINE, recipient: OWNER, seen: 1 }]);
  });

  it("skips ids the session cannot see (the messageAccessible gate its siblings apply)", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, MINE, OWNER);
    await seedMessage(env, ctx, THEIRS, OTHER);
    const auth = await sessionAuth(env, raw);
    const res = await handleApi(seenRequest({ ids: [MINE, THEIRS], seen: true }, auth), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
    // Nothing was written for the other account message, under either address.
    expect(overrides(raw)).toEqual([{ message_id: MINE, recipient: OWNER, seen: 1 }]);
    expect(seenRow(raw, THEIRS)).toBe(0);
  });

  it("cannot reach another account message even when it is the ONLY id", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, THEIRS, OTHER);
    const auth = await sessionAuth(env, raw);
    const res = await handleApi(seenRequest({ ids: [THEIRS], seen: true }, auth), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 0 });
    expect(overrides(raw).length).toBe(0);
    expect(seenRow(raw, THEIRS)).toBe(0);
  });

  it("reaches a message the session SENT (from_addr), matching the sibling predicate", async () => {
    const { env, ctx, raw } = realEnv();
    await store.put(
      env,
      {
        messageId: "sent@example.com",
        direction: "outbound",
        from: OWNER,
        to: "external@example.com",
        deliveredTo: ["external@example.com"],
        subject: "subject",
        date: "2026-07-26T01:00:00.000Z",
        bodyText: "body",
        auth: { spf: "none", dkim: "none", dmarc: "none" },
        trusted: true,
      },
      ctx,
    );
    const auth = await sessionAuth(env, raw);
    const res = await handleApi(seenRequest({ ids: ["sent@example.com"], seen: false }, auth), env, ctx);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
  });
});

describe("#410 bearer-token behavior is unchanged (the live IMAP door)", () => {
  it("a token WITHOUT `for` still flips ROW-LEVEL seen estate-wide, on every id", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, MINE, OWNER);
    await seedMessage(env, ctx, THEIRS, OTHER);
    const res = await handleApi(
      seenRequest({ ids: [MINE, THEIRS], seen: true }, { token: TOKEN }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 2 });
    expect(seenRow(raw, MINE)).toBe(1);
    expect(seenRow(raw, THEIRS)).toBe(1);
  });

  it("a token WITH `for` still writes that recipient override, for ANY address (#350/#357 estate scope)", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, THEIRS, OTHER);
    const res = await handleApi(
      seenRequest({ ids: [THEIRS], seen: true, for: OTHER }, { token: TOKEN }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
    expect(overrides(raw)).toEqual([{ message_id: THEIRS, recipient: OTHER, seen: 1 }]);
    expect(seenRow(raw, THEIRS)).toBe(0);
  });

  it("a token estate write still realigns EXISTING per-recipient overrides (#350)", async () => {
    const { env, ctx, raw } = realEnv();
    await seedMessage(env, ctx, MINE, OWNER);
    await handleApi(seenRequest({ ids: [MINE], seen: true, for: OWNER }, { token: TOKEN }), env, ctx);
    expect(overrides(raw)).toEqual([{ message_id: MINE, recipient: OWNER, seen: 1 }]);
    await handleApi(seenRequest({ ids: [MINE], seen: false }, { token: TOKEN }), env, ctx);
    expect(seenRow(raw, MINE)).toBe(0);
    expect(overrides(raw)).toEqual([{ message_id: MINE, recipient: OWNER, seen: 0 }]);
  });

  it("still 400s a malformed `for` under a token (validation order unchanged)", async () => {
    const { env, ctx } = realEnv();
    const res = await handleApi(
      seenRequest({ ids: [MINE], seen: true, for: "not-an-address" }, { token: TOKEN }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
  });
});
