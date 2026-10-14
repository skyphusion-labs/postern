// #731: the DELETE refusal, and whether it can be COMBINED with the read refusal into an
// existence oracle.
//
// #717 made every read 404 state the scope it was answered under and kept the body
// byte-identical for "absent" and "withheld". The delete route sat outside that issue
// because it is delete-scoped, and its 404 said nothing about scope at all.
//
// TWO QUESTIONS, and they are different shapes of evidence:
//
//   1. SCOPE ANNOUNCEMENT. A session's delete refusal is produced under the SINGLE bound
//      identity (the #404 ruling: a role view is read plus \Seen only), which is NARROWER
//      than the member-plus-role-queues scope the same session's read is answered under.
//      That is correct, and it must be stated rather than inherited, so the refusal now
//      reports the scope the check actually ran under.
//
//   2. THE TWO-ROUTE ORACLE. Each route can be careful on its own and still leak when
//      two answers are combined. So every probe here makes BOTH calls inside ONE test, for
//      the SAME id, as the SAME caller, and compares the PAIR. An id the caller may not
//      read must produce exactly the pair an id that does not exist produces.
//
// Real SQLite and a real minted session (realdb), because both claims are about access
// predicates and a fake store would only prove the fake agrees with itself.

import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { hashSecret } from "./src/smtpcreds";
import { mintNativeSession, SESSION_COOKIE, CSRF_COOKIE } from "./src/session";
import { resetRoleCache } from "./src/roles";
import { realEnv, putInbound } from "./realdb";

const ADA = "ada@skyphusion.org";
const BEN = "ben@skyphusion.org";
const CONRAD = "conrad@skyphusion.org";
const QUEUE = "abuse@skyphusion.org";
const ESTATE = "test-token";
const PASSWORD = "hunter2hunter2";

const ABSENT = "no-such-message@skyphusion.org";
const WITHHELD = "conrads-private@skyphusion.org"; // exists, addressed to CONRAD only
const ADA_LIVE = "ada-live@skyphusion.org"; // exists, hers, not in trash
const ADA_TRASH = "ada-trash@skyphusion.org"; // exists, hers, in trash
const QUEUE_MSG = "queue-1@skyphusion.org"; // exists, addressed to the queue ADA belongs to

async function world() {
  resetRoleCache();
  const w = realEnv({
    WEBMAIL_AUTH_BACKEND: "native",
    POSTERN_VIEWER_ROLES: `${QUEUE}=${ADA}+${BEN}`,
  });
  const { env, ctx, raw } = w;
  await putInbound(env, ctx, { id: WITHHELD, from: "x@example.com", to: CONRAD });
  await putInbound(env, ctx, { id: ADA_LIVE, from: "x@example.com", to: ADA });
  await putInbound(env, ctx, { id: ADA_TRASH, from: "x@example.com", to: ADA });
  await putInbound(env, ctx, { id: QUEUE_MSG, from: "x@example.com", to: QUEUE });
  // ADA_TRASH really is in the trash, by the product's own move path.
  expect(await store.moveMessages(env, [ADA_TRASH], "trash", [ADA])).toBe(1);
  return { env, ctx, raw };
}

async function signIn(env: Env, raw: DatabaseSync, address: string) {
  raw
    .prepare(
      "INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(address, address, await hashSecret(PASSWORD), "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z");
  const minted = await mintNativeSession(env, address, PASSWORD);
  if (!minted) throw new Error("session mint failed: the test would prove nothing");
  return {
    cookie: `${SESSION_COOKIE}=${minted.rawId}; ${CSRF_COOKIE}=${minted.csrfToken}`,
    csrf: minted.csrfToken,
  };
}

type Caller = { cookie: string; csrf: string } | { token: string };

function request(method: "GET" | "DELETE", id: string, who: Caller): Request {
  const headers: Record<string, string> =
    "cookie" in who
      ? { cookie: who.cookie, ...(method === "DELETE" ? { "x-postern-csrf": who.csrf } : {}) }
      : { authorization: `Bearer ${who.token}` };
  return new Request(`https://postern.example/api/messages/${encodeURIComponent(id)}`, {
    method,
    headers,
  });
}

/** The PAIR: the read answer and the delete answer for one id, one caller, one world. */
async function pair(env: Env, ctx: ExecutionContext, id: string, who: Caller) {
  const r = await handleApi(request("GET", id, who), env, ctx);
  const d = await handleApi(request("DELETE", id, who), env, ctx);
  return {
    read: { status: r.status, body: await r.text() },
    del: { status: d.status, body: await d.text() },
  };
}

describe("#731 the delete 404 states the scope it was produced under", () => {
  it("a session's refusal names the SINGLE identity, not member plus queues", async () => {
    const { env, ctx, raw } = await world();
    const ada = await signIn(env, raw, ADA);
    const res = await handleApi(request("DELETE", ABSENT, ada), env, ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("E_NOT_FOUND");
    expect(body.identityScope).toEqual({ kind: "member", addresses: [ADA] });
  });

  it("and that is deliberately NARROWER than the same session's READ scope", async () => {
    const { env, ctx, raw } = await world();
    const ada = await signIn(env, raw, ADA);
    const read = (await (await handleApi(request("GET", ABSENT, ada), env, ctx)).json()) as {
      identityScope: { addresses: string[] };
    };
    expect(read.identityScope.addresses.sort()).toEqual([ADA, QUEUE].sort());
    const del = (await (await handleApi(request("DELETE", ABSENT, ada), env, ctx)).json()) as {
      identityScope: { addresses: string[] };
    };
    expect(del.identityScope.addresses).toEqual([ADA]);
  });

  it("a static estate token's refusal says estate", async () => {
    const { env, ctx } = await world();
    const res = await handleApi(request("DELETE", ABSENT, { token: ESTATE }), env, ctx);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).identityScope).toEqual({ kind: "estate" });
  });
});

describe("#731 the two-route oracle: both calls, one id, one caller, one test", () => {
  it("an id the caller may not read gives exactly the pair an absent id gives", async () => {
    const { env, ctx, raw } = await world();
    const ada = await signIn(env, raw, ADA);

    const absent = await pair(env, ctx, ABSENT, ada);
    const withheld = await pair(env, ctx, WITHHELD, ada);

    // Control: the instrument can see a difference when there is one. A readable id is NOT
    // the same pair as an absent one, so an equal pair below means something.
    const readable = await pair(env, ctx, ADA_LIVE, ada);
    expect(readable.read.status).toBe(200);
    expect(absent.read.status).toBe(404);

    expect(withheld.read).toEqual(absent.read);
    expect(withheld.del).toEqual(absent.del);
    expect(absent.read.status).toBe(404);
    expect(absent.del.status).toBe(404);
  });

  it("holds for the delete-only caller too: withheld and absent are one answer", async () => {
    const { env, ctx } = await world();
    // A static estate token reads and deletes everything, so there is nothing withheld from
    // it. The property under test is the opposite one: its refusal for an absent id is a
    // plain 404 carrying the estate scope, with no hint of why.
    const absent = await pair(env, ctx, ABSENT, { token: ESTATE });
    expect(absent.del.status).toBe(404);
    expect(JSON.parse(absent.del.body)).toEqual({
      ok: false,
      error: "E_NOT_FOUND",
      message: "not found",
      identityScope: { kind: "estate" },
    });
  });

  it("a queue message the member can READ is not deletable by it, and says the same thing", async () => {
    const { env, ctx, raw } = await world();
    const ada = await signIn(env, raw, ADA);
    const p = await pair(env, ctx, QUEUE_MSG, ada);
    expect(p.read.status).toBe(200); // readable through the queue (#425)
    expect(p.del.status).toBe(404); // the #404 ruling: a role view is read plus \Seen only
    // And the refusal is byte-identical to the one an absent id gets.
    const absent = await pair(env, ctx, ABSENT, ada);
    expect(p.del).toEqual(absent.del);
    // Nothing was deleted by the refusal.
    expect(await store.getUnscoped(env, QUEUE_MSG)).not.toBeNull();
  });
});

describe("#731 what the 404 does NOT disambiguate, recorded so it is not mistaken for an oracle", () => {
  it("own mail that is not in the trash is refused with the same 404 an absent id gets", async () => {
    const { env, ctx, raw } = await world();
    const ada = await signIn(env, raw, ADA);
    const live = await pair(env, ctx, ADA_LIVE, ada);
    const absent = await pair(env, ctx, ABSENT, ada);
    expect(live.read.status).toBe(200);
    expect(live.del.status).toBe(404);
    // Same delete answer as an absent id: the precondition (must be in the trash) collapses
    // into "not found". This tells the caller nothing it did not already learn from the
    // read, but it IS a third reason hiding behind one body.
    expect(live.del).toEqual(absent.del);
    expect(await store.getUnscoped(env, ADA_LIVE)).not.toBeNull();
  });

  it("and the same mail IS deletable once it is in the trash", async () => {
    const { env, ctx, raw } = await world();
    const ada = await signIn(env, raw, ADA);
    const res = await handleApi(request("DELETE", ADA_TRASH, ada), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: ADA_TRASH });
    expect(await store.getUnscoped(env, ADA_TRASH)).toBeNull();
  });
});
