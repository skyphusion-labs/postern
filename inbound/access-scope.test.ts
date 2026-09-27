// A scoped store call states WHOSE mail it may touch, and an empty answer means NOTHING.
//
// The invariant: `store.AccessScope` has two inhabitants and a call site must pick one.
// `"estate"` is the deliberate, greppable unconstrained case (the static operator token,
// the IMAP door, the same-account RPC entrypoint). Anything else is a member set, and an
// EMPTY member set matches NOTHING.
//
// That empty case is the whole point. The parameter used to be an optional address, so
// "no identity resolved for this caller" and "this caller may touch the estate" were the
// same value (`undefined`) and produced the same SQL (none). A route added later inherited
// estate reach by leaving an argument off, which is not a thing a reviewer can see. Now
// there is no argument to leave off, and the fail-closed answer is representable.
//
// WHY realEnv AND NOT makeFakeEnv: the subject is a SQL predicate. The fake store
// pattern-matches SQL strings and ignores the access clause entirely, so it would answer
// an absent predicate exactly as cheerfully as a correct one and this suite would go green
// on the defect it exists to catch. realEnv runs node:sqlite against the shipped
// schema.sql, so the predicate that ships is the predicate under test.
//
// Every empty-scope assertion is PAIRED with the same call under `[OWNER]` and under
// `"estate"`, because "updated 0" is also what a completely broken write path returns. The
// controls are what make the zeros mean "refused" instead of "inert".

import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { realEnv, putInbound } from "./realdb";

const OWNER = "owner@skyphusion.org";
const STRANGER = "stranger@skyphusion.org";
const MINE = "mine@x";

async function seeded() {
  const { env, ctx } = realEnv();
  await putInbound(env, ctx, { id: MINE, from: "sender@example.net", to: OWNER });
  return { env, ctx };
}

describe("AccessScope: a write names its scope, and an empty scope reaches nothing", () => {
  it("setSeen", async () => {
    const { env } = await seeded();
    expect(await store.setSeen(env, [MINE], true, []), "empty member set").toBe(0);
    expect(await store.setSeen(env, [MINE], true, [STRANGER]), "another member").toBe(0);
    expect(await store.setSeen(env, [MINE], true, [OWNER]), "the owner").toBe(1);
    expect(await store.setSeen(env, [MINE], false, "estate"), "estate").toBe(1);
  });

  it("setFlags", async () => {
    const { env } = await seeded();
    expect(await store.setFlags(env, [MINE], { flagged: true }, []), "empty member set").toBe(0);
    expect(await store.setFlags(env, [MINE], { flagged: true }, [STRANGER]), "another member").toBe(0);
    expect(await store.setFlags(env, [MINE], { flagged: true }, [OWNER]), "the owner").toBe(1);
    expect(await store.setFlags(env, [MINE], { flagged: false }, "estate"), "estate").toBe(1);
  });

  it("moveMessages", async () => {
    const { env } = await seeded();
    expect(await store.moveMessages(env, [MINE], "trash", []), "empty member set").toBe(0);
    expect(await store.moveMessages(env, [MINE], "trash", [STRANGER]), "another member").toBe(0);
    expect(await store.moveMessages(env, [MINE], "trash", [OWNER]), "the owner").toBe(1);
    expect(await store.moveMessages(env, [MINE], null, "estate"), "estate").toBe(1);
  });

  // A count of 0 says a statement reported nothing; this says the STORE did not move. What
  // this suite cannot isolate, and it is worth saying so: moveMessages gates the placement
  // read AND the UPDATE with the same predicate, so no input reaches one gate without the
  // other, and no test here can prove the UPDATE alone would refuse. The redundancy is
  // deliberate (a write that inherits its only guard from a preceding SELECT is one
  // refactor away from having none); what is TESTED is that the pair refuses together.
  it("a refused move leaves the row where it was", async () => {
    const { env } = await seeded();
    expect(await store.moveMessages(env, [MINE], "trash", [STRANGER])).toBe(0);
    expect((await store.getUnscoped(env, MINE))?.mailbox ?? null).toBe(null);
  });
});

describe("AccessScope: the read projections agree with the writes", () => {
  it("messageAccessible refuses an empty member set and admits the owner", async () => {
    const { env } = await seeded();
    expect(await store.messageAccessible(env, MINE, []), "empty member set").toBe(false);
    expect(await store.messageAccessible(env, MINE, [STRANGER]), "another member").toBe(false);
    expect(await store.messageAccessible(env, MINE, [OWNER]), "the owner").toBe(true);
  });

  // thread() keeps an OPTIONAL viewer, because an ABSENT one is the documented estate read
  // the operator token and the IMAP door rely on. An empty ARRAY is not the same thing: it
  // was passed, it resolved to no addresses, and it reaches nothing.
  it("thread separates an absent viewer from an empty one", async () => {
    const { env } = await seeded();
    const threadId = (await store.getUnscoped(env, MINE))?.threadId as string;
    expect((await store.thread(env, threadId)).length, "absent = estate").toBe(1);
    expect((await store.thread(env, threadId, [])).length, "empty member set").toBe(0);
    expect((await store.thread(env, threadId, [STRANGER])).length, "another member").toBe(0);
    expect((await store.thread(env, threadId, [OWNER])).length, "the owner").toBe(1);
  });
});
