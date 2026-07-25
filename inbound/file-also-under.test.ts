// ROLE-ADDRESS FILING (FILE_ALSO_UNDER): the fix for an intake address nobody can see.
//
// THE DEFECT THIS CLOSES, found live rather than theorised. Mail to a shared role address
// (abuse@, studio@) was delivered, stored, and readable through the API -- and appeared in NO
// mailbox view, because the deployment scopes every folder to the viewer address and a role
// address has no owner. A published abuse intake that lands where no person looks is the failure
// mode publishing it was meant to prevent.
//
// WHAT IS ASSERTED HERE. The delivered set on the STORED ROW, through the real ingest path with
// the real store fake -- not the parser in isolation. The parser gets its own unit coverage below
// for the shapes that are awkward to drive end to end, and each of those is paired with a
// through-ingest case so the two cannot drift.
//
// THE CONTROL IS THE POINT. Every "it files under the extra address" test sits beside one proving
// an address NOT in the map still files under itself alone, and one proving an empty map changes
// nothing. A filing rule that quietly widened every recipient would look identical in the happy
// path and be a privacy defect.

import { describe, it, expect } from "vitest";
import { ingest, fileAlsoUnder, type ParsedInbound } from "./src/ingest";
import { makeFakeEnv } from "./fakes";

const MAP = "abuse@example.com=owner@example.com,studio@example.com=owner@example.com";

function msg(to: string, over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: `${to.replace(/[^a-z]/g, "")}@example.com`,
    from: "reporter@elsewhere.test",
    to,
    subject: "report",
    text: "body",
    ...over,
  };
}

/** The delivered set as the STORE recorded it, parsed back out of the row. */
const deliveredOf = (rows: { delivered_to?: string | null; to_addr: string }[], i = 0): string[] =>
  (rows[i].delivered_to ?? `,${rows[i].to_addr},`).split(",").filter(Boolean);

describe("FILE_ALSO_UNDER, through the real ingest path", () => {
  it("files a mapped role address under the owner TOO, not instead", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv({ FILE_ALSO_UNDER: MAP });
    await ingest(env, msg("abuse@example.com"), ctx);
    await settle();

    expect(rows).toHaveLength(1);
    const delivered = deliveredOf(rows);
    // BOTH. The role address keeps its envelope role (it is what the sender wrote, and what an
    // audit of an abuse report has to show), and the owner gains a view of the same row.
    expect(delivered).toContain("abuse@example.com");
    expect(delivered).toContain("owner@example.com");
    // ONE row, not a copy: same message, one body, one search hit.
    expect(rows[0].to_addr).toBe("abuse@example.com");
  });

  it("CONTROL: an address that is NOT mapped still files under itself ALONE", async () => {
    // Without this, a rule that widened EVERY recipient would pass the test above.
    const { env, ctx, settle, rows } = makeFakeEnv({ FILE_ALSO_UNDER: MAP });
    await ingest(env, msg("someone@example.com"), ctx);
    await settle();

    expect(deliveredOf(rows)).toEqual(["someone@example.com"]);
  });

  it("CONTROL: an EMPTY map changes nothing at all", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv({ FILE_ALSO_UNDER: "" });
    await ingest(env, msg("abuse@example.com"), ctx);
    await settle();

    expect(deliveredOf(rows)).toEqual(["abuse@example.com"]);
  });

  it("CONTROL: an UNSET map changes nothing at all", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv();
    await ingest(env, msg("abuse@example.com"), ctx);
    await settle();

    expect(deliveredOf(rows)).toEqual(["abuse@example.com"]);
  });

  it("matches case-insensitively, because envelope case is the sender choice", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv({ FILE_ALSO_UNDER: MAP });
    await ingest(env, msg("Abuse@Example.COM"), ctx);
    await settle();

    const delivered = deliveredOf(rows);
    expect(delivered).toContain("abuse@example.com");
    expect(delivered).toContain("owner@example.com");
  });

  it("keeps the mapped role address FIRST, so the dedup merge still names the envelope recipient", async () => {
    // store.put merges deliveredList[0] on a same-Message-ID dedup. If the extra address led, a
    // second delivery of a multi-recipient message would merge the OWNER instead of the recipient
    // that invocation was actually for.
    const { env, ctx, settle, rows } = makeFakeEnv({ FILE_ALSO_UNDER: MAP });
    await ingest(env, msg("abuse@example.com"), ctx);
    await settle();

    expect(deliveredOf(rows)[0]).toBe("abuse@example.com");
  });

  it("does not disturb a second, unmapped recipient of the SAME message", async () => {
    const { env, ctx, settle, rows } = makeFakeEnv({ FILE_ALSO_UNDER: MAP });
    const id = "shared@example.com";
    await ingest(env, msg("abuse@example.com", { messageId: id }), ctx);
    await ingest(env, msg("someone@example.com", { messageId: id }), ctx);
    await settle();

    // One row (dedup by Message-ID), carrying all three: the two envelope recipients and the owner
    // the first delivery filed under.
    expect(rows).toHaveLength(1);
    const delivered = deliveredOf(rows);
    expect(delivered).toContain("abuse@example.com");
    expect(delivered).toContain("someone@example.com");
    expect(delivered).toContain("owner@example.com");
  });
});

describe("fileAlsoUnder, the parsing rules", () => {
  it("returns the mapped target, and nothing for an unmapped address", () => {
    expect(fileAlsoUnder("abuse@example.com", MAP)).toEqual(["owner@example.com"]);
    expect(fileAlsoUnder("someone@example.com", MAP)).toEqual([]);
  });

  it("is SINGLE HOP, so no config can build a chain or a cycle", () => {
    // a=b and b=c: an a-message files under b only. b is never expanded again, and the mirror
    // config a=b,b=a cannot ping-pong either, because the map is consulted once.
    const chain = "a@example.com=b@example.com,b@example.com=c@example.com";
    expect(fileAlsoUnder("a@example.com", chain)).toEqual(["b@example.com"]);
    const cycle = "a@example.com=b@example.com,b@example.com=a@example.com";
    expect(fileAlsoUnder("a@example.com", cycle)).toEqual(["b@example.com"]);
  });

  it("treats a self-map as a no-op and collapses duplicate targets", () => {
    expect(fileAlsoUnder("a@example.com", "a@example.com=a@example.com")).toEqual([]);
    expect(
      fileAlsoUnder("a@example.com", "a@example.com=b@example.com,a@example.com=b@example.com"),
    ).toEqual(["b@example.com"]);
  });

  it("SKIPS a malformed entry and still applies the valid ones", () => {
    // Parsed on the delivery path: throwing here would turn one typo into refused mail for every
    // recipient. The bad entries are dropped loudly (console.warn) and the good one survives.
    const messy = "not-an-entry, =owner@example.com, abuse@example.com=, abuse@example.com=owner@example.com";
    expect(fileAlsoUnder("abuse@example.com", messy)).toEqual(["owner@example.com"]);
  });

  it("tolerates whitespace and an empty or absent map", () => {
    expect(fileAlsoUnder("abuse@example.com", "  abuse@example.com = owner@example.com  ")).toEqual([
      "owner@example.com",
    ]);
    expect(fileAlsoUnder("abuse@example.com", "")).toEqual([]);
    expect(fileAlsoUnder("abuse@example.com", undefined)).toEqual([]);
    expect(fileAlsoUnder("", MAP)).toEqual([]);
  });
});
