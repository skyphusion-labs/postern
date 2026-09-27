// An address is matched LITERALLY wherever the store asks whether a viewer is on the
// delivered set. That membership test is a SQL LIKE over a ",a,b," string, and SQLite
// LIKE reads `_` as "any one character" and `%` as "any run of characters", so an
// address reaching a pattern unescaped would answer a WIDER question than the one the
// call site asks. Underscores are ordinary in mail addresses, so this is not a corner
// case, and the same predicate has nine call sites.
//
// Refs GHSA-pjv6-4xmx-29cw.
//
// WHY realEnv AND NOT makeFakeEnv: the subject here IS a SQL predicate. A fake store
// that pattern-matches SQL strings answers a wildcard predicate and a literal one
// identically, so this suite would go green on the exact thing it exists to measure.
// realEnv runs node:sqlite against the shipped schema, so the predicate that ships is
// the predicate under test.
//
// EVERY negative is paired with an inverse control on the same call, because "returned
// nothing" is also what a predicate matching NOTHING returns; the controls are what make
// each negative mean "literal" instead of "inert". The second half of the suite is the
// other direction of the same risk: escaping must not break the legitimate
// multi-recipient delivery these clauses exist to support.
import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { readFileSync } from "node:fs";
import { realEnv, putInbound, putOutbound } from "./realdb";

// Two real addresses differing at ONE position, where the wildcard-bearing one is the
// VIEWER and the plain one is the recipient. `_` is the wildcard; `.` is the character
// it must not match.
const WILDCARD_VIEWER = "john_doe@example.org";
const PLAIN_RECIPIENT = "john.doe@example.org";
const OUTSIDER = "outsider@example.net";
const SECRET = "the body a lookalike address must never reach";

// The `%` half of the same defect: `%` matches ANY run of characters, so an address
// beginning with it would match every row in the store.
const PERCENT_VIEWER = "%@example.org";

async function seeded() {
  const { env, ctx, raw } = realEnv();
  await putInbound(env, ctx, {
    id: "victim@x",
    from: OUTSIDER,
    to: PLAIN_RECIPIENT,
    subject: "victim subject",
    body: SECRET,
  });
  return { env, ctx, raw };
}

describe("delivered-set membership matches an address literally", () => {
  describe("CONTROL: the instrument can see both sides of the boundary", () => {
    it("the real recipient reads its own message, and a plain stranger does not", async () => {
      const { env } = await seeded();
      const mine = await store.get(env, "victim@x", PLAIN_RECIPIENT);
      expect(mine, "the actual recipient must be able to read its own mail").not.toBeNull();
      expect(mine?.bodyText).toContain(SECRET);

      const theirs = await store.get(env, "victim@x", "stranger@example.org");
      expect(theirs, "an unrelated address must not read it").toBeNull();
    });
  });

  describe("a LIKE metacharacter in the viewer address is a literal character", () => {
    it("store.get: an address differing only at the `_` position does not match", async () => {
      const { env } = await seeded();
      const got = await store.get(env, "victim@x", WILDCARD_VIEWER);
      expect(got, `${WILDCARD_VIEWER} must not read mail delivered to ${PLAIN_RECIPIENT}`).toBeNull();
    });

    it("store.messageAccessible: the same answer on the shared predicate", async () => {
      const { env } = await seeded();
      expect(await store.messageAccessible(env, "victim@x", WILDCARD_VIEWER)).toBe(false);
      expect(
        await store.messageAccessible(env, "victim@x", PLAIN_RECIPIENT),
        "inverse control: the real recipient still resolves",
      ).toBe(true);
    });

    it("store.get: a `%` in the viewer address does not match everything", async () => {
      const { env } = await seeded();
      const got = await store.get(env, "victim@x", PERCENT_VIEWER);
      expect(got, `${PERCENT_VIEWER} must not read mail delivered to ${PLAIN_RECIPIENT}`).toBeNull();
    });

    it("store.thread: a thread read is scoped literally", async () => {
      const { env, ctx } = await seeded();
      const row = await store.getUnscoped(env, "victim@x");
      const threadId = row?.threadId ?? "victim@x";

      const leaked = await store.thread(env, threadId, WILDCARD_VIEWER);
      expect(leaked.map((m) => m.messageId), "no row may come back under a lookalike").toEqual([]);

      const real = await store.thread(env, threadId, PLAIN_RECIPIENT);
      expect(real.map((m) => m.messageId), "inverse control: the recipient sees its thread").toEqual([
        "victim@x",
      ]);
      void ctx;
    });

    it("store.list (to=): a recipient-scoped page is scoped literally", async () => {
      const { env } = await seeded();
      const leaked = await store.list(env, { to: WILDCARD_VIEWER });
      expect(leaked.items.map((m) => m.messageId)).toEqual([]);

      const real = await store.list(env, { to: PLAIN_RECIPIENT });
      expect(real.items.map((m) => m.messageId), "inverse control").toEqual(["victim@x"]);
    });

    it("store.list (viewer=): the account boundary is scoped literally", async () => {
      const { env } = await seeded();
      const leaked = await store.list(env, { viewer: WILDCARD_VIEWER });
      expect(leaked.items.map((m) => m.messageId)).toEqual([]);

      const real = await store.list(env, { viewer: PLAIN_RECIPIENT });
      expect(real.items.map((m) => m.messageId), "inverse control").toEqual(["victim@x"]);
    });

    it("store.search (substr, to=): a search is scoped literally", async () => {
      const { env } = await seeded();
      const leaked = await store.search(env, { q: "lookalike", mode: "substr", to: WILDCARD_VIEWER });
      expect(leaked.items.map((h) => h.message.messageId)).toEqual([]);

      const real = await store.search(env, { q: "lookalike", mode: "substr", to: PLAIN_RECIPIENT });
      expect(real.items.map((h) => h.message.messageId), "inverse control").toEqual(["victim@x"]);
    });

    it("store.folders: a folder rail is counted literally", async () => {
      const { env } = await seeded();
      const leaked = await store.folders(env, WILDCARD_VIEWER);
      expect(leaked.find((f) => f.id === "all")?.count, "a lookalike counts nothing").toBe(0);

      const real = await store.folders(env, PLAIN_RECIPIENT);
      expect(real.find((f) => f.id === "all")?.count, "inverse control").toBe(1);
    });

    it("store.setSeen: a viewer-scoped write does not reach a lookalike's mail", async () => {
      const { env } = await seeded();
      expect(await store.setSeen(env, ["victim@x"], true, undefined, WILDCARD_VIEWER)).toBe(0);
      expect(
        await store.setSeen(env, ["victim@x"], true, undefined, PLAIN_RECIPIENT),
        "inverse control: the real recipient may mark its own mail read",
      ).toBe(1);
    });

    it("store.setFlags: a viewer-scoped flag write does not reach a lookalike's mail", async () => {
      const { env } = await seeded();
      expect(await store.setFlags(env, ["victim@x"], { flagged: true }, WILDCARD_VIEWER)).toBe(0);
      expect(
        await store.setFlags(env, ["victim@x"], { flagged: true }, PLAIN_RECIPIENT),
        "inverse control",
      ).toBe(1);
    });

    it("store.moveMessages: a viewer-scoped move does not reach a lookalike's mail", async () => {
      const { env } = await seeded();
      expect(await store.moveMessages(env, ["victim@x"], "trash", WILDCARD_VIEWER)).toBe(0);
      expect(
        await store.moveMessages(env, ["victim@x"], "trash", PLAIN_RECIPIENT),
        "inverse control",
      ).toBe(1);
    });
  });

  // The other direction of the same risk. An over-tightened escape that matched nothing
  // would pass every assertion above and break the mailbox, so each of these is load
  // bearing: an underscore is a LITERAL that must still match itself.
  describe("escaping does not break a legitimate address carrying the same characters", () => {
    it("an address WITH an underscore reads its own mail", async () => {
      const { env, ctx } = realEnv();
      await putInbound(env, ctx, { id: "u@x", from: OUTSIDER, to: WILDCARD_VIEWER, body: "ok" });

      const got = await store.get(env, "u@x", WILDCARD_VIEWER);
      expect(got, "a literal underscore must still match itself").not.toBeNull();
      expect(await store.list(env, { to: WILDCARD_VIEWER })).toMatchObject({
        items: [{ messageId: "u@x" }],
      });
      expect(await store.messageAccessible(env, "u@x", WILDCARD_VIEWER)).toBe(true);
      expect(await store.folders(env, WILDCARD_VIEWER).then((f) => f.find((x) => x.id === "all")?.count)).toBe(1);
    });

    it("multi-recipient delivery still reaches every recipient", async () => {
      const { env, ctx } = realEnv();
      const a = "a_one@example.org";
      const b = "b.two@example.org";
      await putOutbound(env, ctx, { id: "multi@x", from: "sender@skyphusion.org", to: [a, b] });

      expect(await store.messageAccessible(env, "multi@x", a), "recipient a").toBe(true);
      expect(await store.messageAccessible(env, "multi@x", b), "recipient b").toBe(true);
      expect(
        await store.messageAccessible(env, "multi@x", "a.one@example.org"),
        "but not a lookalike of a",
      ).toBe(false);
    });

    it("a same-Message-ID redelivery to a second recipient still merges (#178)", async () => {
      const { env, ctx } = realEnv();
      const one = "first_one@example.org";
      const two = "second_one@example.org";
      const first = await putInbound(env, ctx, { id: "m178@x", from: OUTSIDER, to: one, body: "same" });
      expect(first.stored).toBe(true);
      const second = await store.put(
        env,
        {
          messageId: "m178@x",
          direction: "inbound",
          from: OUTSIDER,
          to: one,
          subject: "s",
          date: "2026-02-02T00:00:00.000Z",
          bodyText: "same",
          auth: { spf: "none", dkim: "none", dmarc: "none" },
          trusted: false,
          deliveredTo: [two],
        },
        ctx,
      );
      expect(second.merged, "the second envelope recipient must merge, not fork").toBe(true);
      expect(await store.messageAccessible(env, "m178@x", one)).toBe(true);
      expect(await store.messageAccessible(env, "m178@x", two)).toBe(true);
    });

    it("the delivered-set NOT LIKE write guard stays idempotent for an underscore address", async () => {
      const { env, ctx } = realEnv();
      const who = "role_queue@example.org";
      await putInbound(env, ctx, { id: "idem@x", from: OUTSIDER, to: who, body: "same" });
      const again = await store.put(
        env,
        {
          messageId: "idem@x",
          direction: "inbound",
          from: OUTSIDER,
          to: who,
          subject: "s",
          date: "2026-02-02T00:00:00.000Z",
          bodyText: "same",
          auth: { spf: "none", dkim: "none", dmarc: "none" },
          trusted: false,
          deliveredTo: [who],
        },
        ctx,
      );
      expect(again.stored, "a true redelivery of the same recipient is a no-op").toBe(false);
      expect(again.merged).toBe(false);
      const row = await store.getUnscoped(env, "idem@x");
      expect(
        (row?.deliveredTo ?? []).filter((r) => r === who).length,
        "the address must appear exactly once, not twice",
      ).toBe(1);
    });
  });
});

// The mechanism, not just the fix. Nine call sites shared one mistake, so converting nine
// sites is only half the job: the tenth site is the one that has not been written yet, and
// a reviewer cannot be the guard. Every LIKE in the store must be paired with an ESCAPE
// clause, which is the same thing as saying every LIKE pattern came from the one escaper.
//
// Refs GHSA-pjv6-4xmx-29cw.
describe("no LIKE in the store is built without its escaper", () => {
  // Comments talk ABOUT LIKE constantly; only executable SQL is in scope.
  function unescapedLikeSites(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const out: string[] = [];
    const re = /\bLIKE\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const tail = code.slice(m.index, m.index + 60);
      if (!/\bESCAPE\b/.test(tail)) out.push(tail.split("\n")[0].trim());
    }
    return out;
  }

  const source = readFileSync(new URL("./src/store.ts", import.meta.url), "utf8");

  it("POSITIVE CONTROL: the detector fires on the shape it exists to catch", () => {
    const fixture = `
      const clause =
        "(COALESCE(delivered_to, ',' || to_addr || ',') LIKE '%,' || ? || ',%' OR lower(from_addr) = ?)";
    `;
    expect(
      unescapedLikeSites(fixture),
      "a detector that cannot see the original defect proves nothing about its absence",
    ).toHaveLength(1);
  });

  it("POSITIVE CONTROL: the detector does NOT fire on the escaped form", () => {
    const fixture = `const sql = \`\${set} LIKE ? ESCAPE '\\\\'\`;`;
    expect(unescapedLikeSites(fixture)).toEqual([]);
  });

  it("store.ts has no LIKE without an ESCAPE clause", () => {
    expect(unescapedLikeSites(source)).toEqual([]);
  });
});
