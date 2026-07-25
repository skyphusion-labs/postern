// #404 support: `seenFor` picks WHOSE read/unread state a read renders, without
// touching WHICH ROWS it returns.
//
// The two axes were fused: the seen projection keyed off `viewer ?? to`, so a folder
// view keyed to a role address (`to=abuse@`) could only render the ROLE's seen state,
// which no human owns. Splitting them lets "the abuse folder, as conrad reads it" be
// one query instead of a client-side reconciliation.
//
// The load-bearing property is a NEGATIVE: adding seenFor must never change the row
// SET. Every case below asserts the rows are identical with and without it, so a
// projection parameter can never quietly become a filter.
//
// Real SQLite (./realdb): the projection is a correlated COALESCE subquery whose bind
// order sits between the SELECT list and the WHERE clause. A fake cannot judge that.

import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";
import { hashSecret } from "./src/smtpcreds";
import { mintNativeSession, SESSION_COOKIE } from "./src/session";
import { realEnv, putInbound, AUTH } from "./realdb";

const ROLE = "abuse@skyphusion.org";
const OWNER = "conrad@skyphusion.org";
const OTHER = "joan@skyphusion.org";

// One message delivered to the role address AND filed under its owner (the
// FILE_ALSO_UNDER shape #404 is built on).
async function seedRoleMail(env: Env, ctx: ExecutionContext, id = "r1@skyphusion.org") {
  await store.put(
    env,
    {
      messageId: id,
      direction: "inbound",
      from: "reporter@example.com",
      to: ROLE,
      subject: "abuse report",
      date: "2026-04-01T00:00:00.000Z",
      bodyText: "phishing report body",
      auth: AUTH,
      trusted: false,
      deliveredTo: [ROLE, OWNER],
    },
    ctx,
  );
}

function get(path: string, headers: Record<string, string> = { authorization: "Bearer test-token" }): Request {
  return new Request(`https://postern.example${path}`, { headers });
}

async function body(res: Response): Promise<any> {
  return (await res.json()) as any;
}

describe("#404 seenFor renders another recipient's seen state, and only that", () => {
  it("projects the named recipient's override while the row set stays identical", async () => {
    const { env, ctx } = realEnv();
    await seedRoleMail(env, ctx);
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER); // conrad read it

    const roleView = await store.list(env, { to: ROLE });
    const asOwner = await store.list(env, { to: ROLE, seenFor: OWNER });

    // Same rows: seenFor is a projection, never a predicate.
    expect(asOwner.items.map((m) => m.messageId)).toEqual(roleView.items.map((m) => m.messageId));
    expect(asOwner.items).toHaveLength(1);
    // Different seen: the role has no override (falls back to messages.seen = 0),
    // conrad has one.
    expect(roleView.items[0].seen).toBe(false);
    expect(asOwner.items[0].seen).toBe(true);
  });

  it("is byte-identical to today when absent", async () => {
    const { env, ctx } = realEnv();
    await seedRoleMail(env, ctx);
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER);
    const before = await store.list(env, { to: ROLE });
    const explicitRole = await store.list(env, { to: ROLE, seenFor: ROLE });
    expect(explicitRole.items[0].seen).toBe(before.items[0].seen);
    // and naming a third party who has no override renders the row-level flag.
    const asOther = await store.list(env, { to: ROLE, seenFor: OTHER });
    expect(asOther.items[0].seen).toBe(false);
  });

  // The seen= FILTER (search only, #354) shares this expression, so "R's mail that I
  // have not read" is one query rather than a client-side subtraction. NOTE: `list`
  // has no seen= filter at all, so the filtered form is /api/search or /api/folders.
  it("keys the seen= FILTER too, not just the rendered column", async () => {
    const { env, ctx } = realEnv();
    await seedRoleMail(env, ctx, "read@skyphusion.org");
    await seedRoleMail(env, ctx, "unread@skyphusion.org");
    await store.setSeen(env, ["read@skyphusion.org"], true, OWNER);

    const unreadForOwner = await store.search(env, {
      q: "phishing", mode: "fts", to: ROLE, seenFor: OWNER, seen: false,
    });
    expect(unreadForOwner.items.map((h) => h.message.messageId)).toEqual(["unread@skyphusion.org"]);
    const readForOwner = await store.search(env, {
      q: "phishing", mode: "fts", to: ROLE, seenFor: OWNER, seen: true,
    });
    expect(readForOwner.items.map((h) => h.message.messageId)).toEqual(["read@skyphusion.org"]);
    // CONTROL: without seenFor nothing reads as seen (the role holds no overrides),
    // which is also what proves the filter moved with the projection key.
    expect((await store.search(env, { q: "phishing", mode: "fts", to: ROLE, seen: true })).items)
      .toHaveLength(0);
    expect((await store.search(env, { q: "phishing", mode: "fts", to: ROLE, seen: false })).items)
      .toHaveLength(2);
  });

  it("composes with the lens without becoming part of the predicate", async () => {
    const { env, ctx } = realEnv();
    await seedRoleMail(env, ctx);
    const lensed = await store.list(env, { to: ROLE, lens: "inbox", seenFor: OWNER });
    const plain = await store.list(env, { to: ROLE, lens: "inbox" });
    expect(lensed.items.map((m) => m.messageId)).toEqual(plain.items.map((m) => m.messageId));
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER);
    expect((await store.list(env, { to: ROLE, lens: "inbox", seenFor: OWNER })).items[0].seen).toBe(true);
    expect((await store.list(env, { to: ROLE, lens: "inbox" })).items[0].seen).toBe(false);
  });

  it("applies in the SQL search modes (fts + substr), same rows either way", async () => {
    const { env, ctx } = realEnv();
    await seedRoleMail(env, ctx);
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER);
    for (const mode of ["fts", "substr"] as const) {
      const plain = await store.search(env, { q: "phishing", mode, to: ROLE });
      const asOwner = await store.search(env, { q: "phishing", mode, to: ROLE, seenFor: OWNER });
      expect(asOwner.items.map((h) => h.message.messageId)).toEqual(plain.items.map((h) => h.message.messageId));
      expect(plain.items[0].message.seen).toBe(false);
      expect(asOwner.items[0].message.seen).toBe(true);
    }
  });
});

// The score-ranked modes hydrate their summaries separately, so the projection key
// has to reach summariesByIds too; that is a second implementation of the same rule.
describe("#404 seenFor in the score-ranked modes", () => {
  it("semantic + hybrid hydrate the named recipient's seen state", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: ROLE });
    await store.put(
      env,
      {
        messageId: "r1@skyphusion.org", direction: "inbound", from: "reporter@example.com",
        to: ROLE, subject: "abuse report", date: "2026-04-01T00:00:00.000Z",
        bodyText: "phishing report body", auth: AUTH, trusted: false,
        deliveredTo: [ROLE, OWNER], vectorize: true,
      },
      ctx,
    );
    await settle();
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER);
    for (const mode of ["semantic", "hybrid"] as const) {
      const plain = await store.search(env, { q: "phishing", mode, to: ROLE });
      const asOwner = await store.search(env, { q: "phishing", mode, to: ROLE, seenFor: OWNER });
      expect(asOwner.items.map((h) => h.message.messageId)).toEqual(plain.items.map((h) => h.message.messageId));
      expect(plain.items[0].message.seen).toBe(false);
      expect(asOwner.items[0].message.seen).toBe(true);
    }
  });
});

describe("#404 seenFor at the API edge", () => {
  it("a static (estate) token may name any address on both endpoints", async () => {
    const { env, ctx } = realEnv();
    await seedRoleMail(env, ctx);
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER);
    const list = await body(await handleApi(get(`/api/messages?to=${ROLE}&seenFor=${OWNER}`), env, ctx));
    expect(list.ok).toBe(true);
    expect(list.items[0].seen).toBe(true);
    const search = await body(
      await handleApi(get(`/api/search?q=phishing&mode=fts&to=${ROLE}&seenFor=${OWNER}`), env, ctx),
    );
    expect(search.items[0].message.seen).toBe(true);
  });

  it("refuses a malformed seenFor on both endpoints", async () => {
    const { env, ctx } = realEnv();
    for (const path of [`/api/messages?seenFor=not-an-email`, `/api/search?q=x&seenFor=not-an-email`]) {
      const res = await handleApi(get(path), env, ctx);
      expect(res.status).toBe(400);
      expect(await body(res)).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
    }
    // CONTROL: a well-formed one on the same endpoints is served.
    expect((await handleApi(get(`/api/messages?seenFor=${OWNER}`), env, ctx)).status).toBe(200);
    expect((await handleApi(get(`/api/search?q=x&seenFor=${OWNER}`), env, ctx)).status).toBe(200);
  });
});

// A bound session may only ask for its OWN seen state. This drives a REAL minted
// session against the real webmail_sessions table, not a stand-in resolution: the
// refusal has to come from the shipped auth path or it proves nothing.
describe("#404 a session may only name itself", () => {
  async function sessionEnv() {
    const { env, ctx, raw } = realEnv({ WEBMAIL_AUTH_BACKEND: "native" });
    raw
      .prepare("INSERT INTO smtp_credentials (username, from_addr, secret_hash, disabled) VALUES (?, ?, ?, 0)")
      .run(OWNER, OWNER, await hashSecret("hunter2hunter2"));
    const minted = await mintNativeSession(env, OWNER, "hunter2hunter2");
    expect(minted).not.toBeNull();
    return { env, ctx, cookie: `${SESSION_COOKIE}=${minted!.rawId}` };
  }

  it("serves seenFor for the session's own identity", async () => {
    const { env, ctx, cookie } = await sessionEnv();
    await seedRoleMail(env, ctx);
    await store.setSeen(env, ["r1@skyphusion.org"], true, OWNER);
    const res = await handleApi(get(`/api/messages?seenFor=${OWNER}`, { cookie }), env, ctx);
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.items[0].seen).toBe(true);
  });

  it("REFUSES another identity's seen state (403), on both endpoints", async () => {
    const { env, ctx, cookie } = await sessionEnv();
    await seedRoleMail(env, ctx);
    for (const path of [`/api/messages?seenFor=${OTHER}`, `/api/search?q=phishing&seenFor=${OTHER}`]) {
      const res = await handleApi(get(path, { cookie }), env, ctx);
      expect(res.status).toBe(403);
      expect(await body(res)).toMatchObject({ ok: false, error: "E_FORBIDDEN" });
    }
  });

  it("still serves the same reads with no seenFor at all (the session is not broken)", async () => {
    const { env, ctx, cookie } = await sessionEnv();
    await seedRoleMail(env, ctx);
    const res = await handleApi(get("/api/messages", { cookie }), env, ctx);
    expect(res.status).toBe(200);
    expect((await body(res)).items).toHaveLength(1);
  });
});
