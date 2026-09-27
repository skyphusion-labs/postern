// The door must not normalise away the worker's caveats. Refs #631, #632 F2/F7.
//
// The worker distinguishes three states on a read response, and the difference is the whole
// point: `cursor: "<opaque>"` means there is more and here is how to get it, `cursor: null`
// means there is genuinely no more, and NO cursor key means the answer is incomplete and there
// is no continuation to offer. The old client did `cursor: body.cursor ?? null`, which collapsed
// the third state into the second and handed an agent a false claim of exhaustion.
//
// A door that normalises away the caveat is worse than no caveat, because it makes the lie look
// like the worker told it. So this suite pins the passthrough in both directions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PosternClient } from "../src/client.js";
import { READ_TOOLS } from "../src/tools.js";

function mockFetch(body: unknown) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new PosternClient("https://api.example/", "tok-123");
const tool = (name: string) => READ_TOOLS.find((t) => t.name === name)!;

const INCOMPLETE = {
  ok: true,
  items: [{ message: { messageId: "a@x" } }],
  // No `cursor` key at all: the worker cannot claim exhaustion and does not pretend to.
  complete: false,
  retrievalCap: 50,
  degraded: "more matching messages were retrieved than `limit` allows",
  identityScope: { kind: "member", addresses: ["agent@skyphusion.org"] },
};

describe("an incomplete answer survives the client without becoming an exhausted one", () => {
  it("search leaves an absent cursor ABSENT rather than coercing it to null", async () => {
    mockFetch(INCOMPLETE);
    const page = await client().search({ q: "anything" });

    // The distinction that matters: `in` rather than a truthiness check, because null and
    // undefined are both falsy and only one of them is a claim.
    expect("cursor" in page, "an absent cursor must not be materialised as null").toBe(false);
    expect(page.complete).toBe(false);
    expect(page.retrievalCap).toBe(50);
    expect(page.degraded).toMatch(/more matching messages/);
    expect(page.identityScope).toEqual({ kind: "member", addresses: ["agent@skyphusion.org"] });
  });

  it("CONTROL: a worker cursor of null IS reported as null, so the field still discriminates", async () => {
    mockFetch({ ok: true, items: [], cursor: null, complete: true });
    const page = await client().search({ q: "anything" });

    expect("cursor" in page).toBe(true);
    expect(page.cursor).toBeNull();
    expect(page.complete).toBe(true);
  });

  it("CONTROL: a real cursor is passed through verbatim", async () => {
    mockFetch({ ok: true, items: [], cursor: "opaque-123" });
    const page = await client().search({ q: "anything" });

    expect(page.cursor).toBe("opaque-123");
    // Absent `complete` is the ordinary keyset case and must stay absent, not be invented.
    expect(page.complete).toBeUndefined();
  });

  it("list carries the same fields (one contract, not two)", async () => {
    mockFetch({ ...INCOMPLETE, items: [{ messageId: "a@x" }] });
    const page = await client().list({});

    expect("cursor" in page).toBe(false);
    expect(page.complete).toBe(false);
    expect(page.identityScope).toEqual({ kind: "member", addresses: ["agent@skyphusion.org"] });
  });
});

describe("the tool RESULT an agent actually sees carries the caveat", () => {
  it("mailbox_search surfaces complete/degraded/identityScope and no null cursor", async () => {
    mockFetch(INCOMPLETE);
    const out = (await tool("mailbox_search").handler(client(), { query: "anything" })) as Record<
      string,
      unknown
    >;

    expect(out.complete).toBe(false);
    expect(out.retrievalCap).toBe(50);
    expect(out.degraded).toBeTruthy();
    expect(out.identityScope).toEqual({ kind: "member", addresses: ["agent@skyphusion.org"] });
    expect(Object.keys(out), "no cursor key at all, rather than cursor: null").not.toContain("cursor");
    // `count` stays, and stays honest about what it counts.
    expect(out.count).toBe(1);
  });

  it("mailbox_list surfaces the same, and still reports a genuine null cursor", async () => {
    mockFetch({ ok: true, items: [{ messageId: "a@x" }], cursor: null, identityScope: { kind: "estate" } });
    const out = (await tool("mailbox_list").handler(client(), {})) as Record<string, unknown>;

    expect(out.cursor).toBeNull();
    expect(out.identityScope).toEqual({ kind: "estate" });
  });

  it("CONTROL: an ordinary complete answer gains no noise", async () => {
    mockFetch({ ok: true, items: [], cursor: null });
    const out = (await tool("mailbox_search").handler(client(), { query: "anything" })) as Record<
      string,
      unknown
    >;

    // Absent means the old unambiguous case. Emitting `complete: true` everywhere would train
    // an agent to ignore the field, which is how a caveat stops being read.
    expect(out.complete).toBeUndefined();
    expect(out.degraded).toBeUndefined();
    expect(out.cursor).toBeNull();
  });
});

describe("the tool DESCRIPTIONS tell the agent what it may conclude", () => {
  it("mailbox_search warns that an incomplete result cannot prove absence, and names the mode that can", () => {
    const d = tool("mailbox_search").description;
    expect(d).toMatch(/complete: false/);
    expect(d).toMatch(/cannot prove absence/i);
    expect(d).toMatch(/fts/);
    expect(d).toMatch(/identityScope/);
  });

  it("mailbox_list declares that it DOES filter by date, and that both ends are inclusive", () => {
    // This assertion is the inverse of what it was, and the inversion is the point of #647.
    // It used to require the prose to say "does NOT filter by date", because the dates lived
    // on search only and nothing in this tool said so -- the specific wrong assumption that
    // cost a real search (#631). Now the tool HAS the filter, so the same assertion kept
    // as-is would have pinned a limitation that no longer exists and forced the prose to lie.
    // What has to stay true is that the description answers the date question truthfully,
    // whichever way the answer goes, so it is asserted in the new direction.
    const d = tool("mailbox_list").description;
    expect(d).toMatch(/after\/before/i);
    expect(d).toMatch(/INCLUSIVE/i);
    expect(d).not.toMatch(/does NOT filter by date/i);
    // And the reason it matters, which is the half an agent acts on: an exhaustive window
    // here can prove absence, where the ranked search path cannot.
    expect(d).toMatch(/cannot prove|absent/i);
  });
});
