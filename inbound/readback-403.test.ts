// #403: two read-back defects that made a mailbox answer "yes" without evidence.
//
//  1. mode=fts could not express ABSENCE: the MATCH expression OR-joined the query
//     tokens, so a marker string that exists NOWHERE still matched every message
//     carrying any ONE of its tokens. "search for the marker, assert a hit" went
//     green on garbage.
//  2. `direction` was swallowed by the recipient lens: a viewer-scoped
//     direction=inbound was rewritten into the #350 viewer-relative INBOX, so an
//     outbound SENT copy came back under an inbound filter and a self-sent probe
//     read as a delivery.
//
// Both are false-PASS defects, so every case here is anchored on a working NEGATIVE
// (the thing that must NOT be returned) plus a positive control proving the query
// path is alive -- a negative over a dead path passes for the wrong reason.
//
// Real SQLite (./realdb), never the pattern-matching fake: an FTS5 MATCH expression
// and a WHERE predicate are exactly what a fake cannot judge.

import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";
import { realEnv, putInbound, putOutbound, AUTH } from "./realdb";

const MARKER = "cp115-abuse-intake-probe-7f3a9c"; // the marker from the issue repro

function get(path: string): Request {
  return new Request(`https://postern.example${path}`, {
    headers: { authorization: "Bearer test-token" },
  });
}

async function ids(res: Response): Promise<string[]> {
  const body = (await res.json()) as { items: Array<{ messageId?: string; message?: { messageId: string } }> };
  return body.items.map((i) => i.messageId ?? i.message!.messageId);
}

describe("#403 defect 1: an fts query for a string that exists nowhere returns nothing", () => {
  // Messages that individually carry the marker's TOKENS (abuse, intake, probe) but
  // never the marker itself: the exact shape that produced 10 confident false hits.
  async function seedDecoys(env: Env, ctx: ExecutionContext) {
    await putInbound(env, ctx, {
      id: "d1@skyphusion.org", from: "notifications@github.com", to: "abuse@skyphusion.org",
      subject: "abuse report", body: "an abuse notification, nothing to do with the probe",
    });
    await putInbound(env, ctx, {
      id: "d2@skyphusion.org", from: "notifications@github.com", to: "conrad@skyphusion.org",
      subject: "intake", body: "intake queue probe status 7f3a9c-ish",
    });
    await putInbound(env, ctx, {
      id: "d3@skyphusion.org", from: "ci@skyphusion.org", to: "conrad@skyphusion.org",
      subject: "cp115", body: "cp115 rollout notes",
    });
  }

  it("returns ZERO for the absent marker, and the SAME query finds it once it exists", async () => {
    const { env, ctx } = realEnv();
    await seedDecoys(env, ctx);

    // The negative: absence is representable.
    const miss = await store.search(env, { q: MARKER, mode: "fts", limit: 10 });
    expect(miss.items).toHaveLength(0);

    // The positive control: the same query, same mode, over a store that DOES hold
    // the marker. Without this, the zero above could just mean "search is broken".
    await putInbound(env, ctx, {
      id: "hit@skyphusion.org", from: "strummer@skyphusion.org", to: "abuse@skyphusion.org",
      subject: "delivery proof", body: `marker ${MARKER} end`,
    });
    const hit = await store.search(env, { q: MARKER, mode: "fts", limit: 10 });
    expect(hit.items.map((h) => h.message.messageId)).toEqual(["hit@skyphusion.org"]);
  });

  it("requires EVERY token, not any (the OR-join was the root cause)", async () => {
    const { env, ctx } = realEnv();
    await putInbound(env, ctx, {
      id: "both@skyphusion.org", from: "ext@gmail.com", to: "conrad@skyphusion.org",
      subject: "deploy", body: "deploy notes for tuesday",
    });
    await putInbound(env, ctx, {
      id: "one@skyphusion.org", from: "ext@gmail.com", to: "conrad@skyphusion.org",
      subject: "deploy", body: "deploy only, no other word here",
    });

    const both = await store.search(env, { q: "deploy notes", mode: "fts" });
    expect(both.items.map((h) => h.message.messageId)).toEqual(["both@skyphusion.org"]);
    // Control: each token alone still matches its message (the tokens are indexed).
    expect((await store.search(env, { q: "deploy", mode: "fts" })).items).toHaveLength(2);
  });

  it("an all-punctuation query still matches nothing (unchanged)", async () => {
    const { env, ctx } = realEnv();
    await seedDecoys(env, ctx);
    expect((await store.search(env, { q: "--- ...", mode: "fts" })).items).toHaveLength(0);
  });

  it("list(q=) shares the same AND semantics as search", async () => {
    const { env, ctx } = realEnv();
    await seedDecoys(env, ctx);
    expect((await store.list(env, { q: MARKER })).items).toHaveLength(0);
    expect((await store.list(env, { q: "cp115" })).items.map((m) => m.messageId)).toEqual(["d3@skyphusion.org"]);
  });

  it("no mode silently widens: fts and hybrid both answer zero for the absent marker", async () => {
    const { env, ctx } = realEnv();
    await seedDecoys(env, ctx);
    // realEnv binds no AI/Vectorize, so semantic degrades to empty (documented) and
    // hybrid is the fts side alone: it must NOT resurrect the decoys.
    expect((await store.search(env, { q: MARKER, mode: "fts" })).items).toHaveLength(0);
    expect((await store.search(env, { q: MARKER, mode: "hybrid" })).items).toHaveLength(0);
    expect((await store.search(env, { q: MARKER, mode: "semantic" })).items).toHaveLength(0);
  });

  it("API surface: GET /api/search?mode=fts over the real engine reports count 0", async () => {
    const { env, ctx } = realEnv();
    await seedDecoys(env, ctx);
    const res = await handleApi(get(`/api/search?q=${encodeURIComponent(MARKER)}&mode=fts&limit=10`), env, ctx);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([]);
  });
});

describe("#403 defect 2: direction is the stored fact; the viewer INBOX is a named lens", () => {
  const ABUSE = "abuse@skyphusion.org";

  // The issue repro: a role address that has BOTH a real arrival and the stored SENT
  // copy of a same-domain message addressed to it.
  async function seedRole(env: Env, ctx: ExecutionContext) {
    await putOutbound(env, ctx, {
      id: "sent@skyphusion.org", from: "strummer@skyphusion.org", to: [ABUSE],
      subject: "probe", date: "2026-02-03T00:00:00.000Z", body: "probe copy",
    });
    await putInbound(env, ctx, {
      id: "arrived@skyphusion.org", from: "reporter@example.com", to: ABUSE,
      subject: "probe", date: "2026-02-04T00:00:00.000Z", body: "probe arrival",
    });
  }

  it("to=X + direction=inbound EXCLUDES the sent copy (the reported defect)", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    const page = await store.list(env, { to: ABUSE, direction: "inbound" });
    expect(page.items.map((m) => m.messageId)).toEqual(["arrived@skyphusion.org"]);
    // The invariant behind the fix: a row can never contradict the filter it came
    // back under.
    expect(page.items.every((m) => m.direction === "inbound")).toBe(true);
  });

  it("to=X + direction=outbound is the sent copy only", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    const page = await store.list(env, { to: ABUSE, direction: "outbound" });
    expect(page.items.map((m) => m.messageId)).toEqual(["sent@skyphusion.org"]);
  });

  it("plain to=X still returns BOTH: the recipient view is unchanged", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    const page = await store.list(env, { to: ABUSE });
    expect(page.items.map((m) => m.messageId).sort()).toEqual(["arrived@skyphusion.org", "sent@skyphusion.org"]);
  });

  it("lens=inbox keeps the #350 predicate intact: the same-domain send is IN the INBOX", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    const page = await store.list(env, { to: ABUSE, lens: "inbox" });
    expect(page.items.map((m) => m.messageId).sort()).toEqual(["arrived@skyphusion.org", "sent@skyphusion.org"]);
    // and the sent copy is unseen for the recipient (per-recipient override, #350).
    expect(page.items.find((m) => m.messageId === "sent@skyphusion.org")!.seen).toBe(false);
  });

  it("lens=inbox still drops a true self-send (the documented #350 edge)", async () => {
    const { env, ctx } = realEnv();
    await putOutbound(env, ctx, { id: "self@skyphusion.org", from: ABUSE, to: [ABUSE] });
    expect((await store.list(env, { to: ABUSE, lens: "inbox" })).items).toHaveLength(0);
    // ... and it IS that address's own sent mail.
    expect((await store.list(env, { to: ABUSE, lens: "sent" })).items.map((m) => m.messageId))
      .toEqual(["self@skyphusion.org"]);
  });

  it("lens=sent is sender-based, never delivered-set based", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    // strummer authored the send; nothing was delivered TO strummer.
    const sent = await store.list(env, { to: "strummer@skyphusion.org", lens: "sent" });
    expect(sent.items.map((m) => m.messageId)).toEqual(["sent@skyphusion.org"]);
    // the role address authored nothing, even though the row was delivered to it.
    expect((await store.list(env, { to: ABUSE, lens: "sent" })).items).toHaveLength(0);
  });

  it("no viewer: direction stays the estate lens, exactly as before", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    expect((await store.list(env, { direction: "inbound" })).items.map((m) => m.messageId))
      .toEqual(["arrived@skyphusion.org"]);
    expect((await store.list(env, { direction: "outbound" })).items.map((m) => m.messageId))
      .toEqual(["sent@skyphusion.org"]);
  });

  it("EVERY SQL mode composes the same way (one builder: list, fts, substr)", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    for (const mode of ["fts", "substr"] as const) {
      const strict = await store.search(env, { q: "probe", mode, to: ABUSE, direction: "inbound" });
      expect(strict.items.map((h) => h.message.messageId)).toEqual(["arrived@skyphusion.org"]);
      const lens = await store.search(env, { q: "probe", mode, to: ABUSE, lens: "inbox" });
      expect(lens.items.map((h) => h.message.messageId).sort())
        .toEqual(["arrived@skyphusion.org", "sent@skyphusion.org"]);
      const sent = await store.search(env, { q: "probe", mode, to: "strummer@skyphusion.org", lens: "sent" });
      expect(sent.items.map((h) => h.message.messageId)).toEqual(["sent@skyphusion.org"]);
    }
  });

  it("account boundary (bound session): lens names Inbox/Sent, direction stays the fact", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    const V = "strummer@skyphusion.org";
    // No lens: everything in the account (delivered to V or authored by V).
    expect((await store.list(env, { viewer: V })).items.map((m) => m.messageId)).toEqual(["sent@skyphusion.org"]);
    // Sent = authored by V.
    expect((await store.list(env, { viewer: V, lens: "sent" })).items.map((m) => m.messageId))
      .toEqual(["sent@skyphusion.org"]);
    // Inbox = delivered to V and not authored by V: V is not a recipient here.
    expect((await store.list(env, { viewer: V, lens: "inbox" })).items).toHaveLength(0);
    // direction inside the account boundary is the stored fact.
    expect((await store.list(env, { viewer: V, direction: "inbound" })).items).toHaveLength(0);
    expect((await store.list(env, { viewer: V, direction: "outbound" })).items.map((m) => m.messageId))
      .toEqual(["sent@skyphusion.org"]);
  });

  it("API surface: strict direction, named lens, over the real engine", async () => {
    const { env, ctx } = realEnv();
    await seedRole(env, ctx);
    expect(await ids(await handleApi(get(`/api/messages?to=${ABUSE}&direction=inbound`), env, ctx)))
      .toEqual(["arrived@skyphusion.org"]);
    expect((await ids(await handleApi(get(`/api/messages?to=${ABUSE}&lens=inbox`), env, ctx))).sort())
      .toEqual(["arrived@skyphusion.org", "sent@skyphusion.org"]);
    expect(await ids(await handleApi(get(`/api/search?q=probe&mode=fts&to=${ABUSE}&direction=inbound`), env, ctx)))
      .toEqual(["arrived@skyphusion.org"]);
  });
});

describe("#403 the edge refuses what it cannot honor (negatives, both read endpoints)", () => {
  async function expectRefusal(path: string, message: RegExp) {
    const { env, ctx } = realEnv();
    const res = await handleApi(get(path), env, ctx);
    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: "E_VALIDATION_ERROR" });
    expect(body.message).toMatch(message);
  }

  it("refuses an unknown lens value", async () => {
    await expectRefusal("/api/messages?to=a@skyphusion.org&lens=bogus", /lens must be inbox or sent/);
    await expectRefusal("/api/search?q=x&to=a@skyphusion.org&lens=bogus", /lens must be inbox or sent/);
  });

  it("refuses lens + direction together (both filter the same axis)", async () => {
    await expectRefusal("/api/messages?to=a@skyphusion.org&lens=inbox&direction=inbound", /mutually exclusive/);
    await expectRefusal("/api/search?q=x&to=a@skyphusion.org&lens=inbox&direction=inbound", /mutually exclusive/);
  });

  it("refuses a lens with no viewer instead of degrading to the estate view", async () => {
    await expectRefusal("/api/messages?lens=inbox", /lens requires a viewer/);
    await expectRefusal("/api/search?q=x&lens=sent", /lens requires a viewer/);
  });

  it("refuses a misspelled direction on /api/messages (it used to be silently dropped)", async () => {
    await expectRefusal("/api/messages?to=a@skyphusion.org&direction=inbund", /direction must be inbound or outbound/);
    // CONTROL: the well-spelled filter is served, so the refusal above is the
    // validator talking and not a dead endpoint.
    const { env, ctx } = realEnv();
    await putInbound(env, ctx, { id: "c@skyphusion.org", from: "ext@gmail.com", to: "a@skyphusion.org" });
    const ok = await handleApi(get("/api/messages?to=a@skyphusion.org&direction=inbound"), env, ctx);
    expect(ok.status).toBe(200);
    expect(await ids(ok)).toEqual(["c@skyphusion.org"]);
  });
});

// The score-ranked modes cannot push a WHERE to Vectorize, so they post-filter the
// hydrated hits. That second implementation of the same rule is where a lens/direction
// split silently drifts, so it gets its own coverage (fake env: it owns the
// deterministic embedder + vector store).
describe("#403 semantic/hybrid post-filter honors the same split", () => {
  async function seed(env: Env, ctx: ExecutionContext) {
    await store.put(env, {
      messageId: "sent@skyphusion.org", direction: "outbound", from: "strummer@skyphusion.org",
      to: "abuse@skyphusion.org", subject: "probe", date: "2026-03-01T00:00:00.000Z",
      bodyText: "probe copy", auth: AUTH, trusted: true,
      deliveredTo: ["abuse@skyphusion.org"], vectorize: true,
    }, ctx);
    await store.put(env, {
      messageId: "arrived@skyphusion.org", direction: "inbound", from: "reporter@example.com",
      to: "abuse@skyphusion.org", subject: "probe", date: "2026-03-02T00:00:00.000Z",
      bodyText: "probe arrival", auth: AUTH, trusted: false,
      deliveredTo: ["abuse@skyphusion.org"], vectorize: true,
    }, ctx);
  }

  it("direction=inbound drops the sent copy; lens=inbox keeps it", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "abuse@skyphusion.org" });
    await seed(env, ctx);
    await settle();
    for (const mode of ["semantic", "hybrid"] as const) {
      const strict = await store.search(env, { q: "probe", mode, to: "abuse@skyphusion.org", direction: "inbound" });
      expect(strict.items.map((h) => h.message.messageId)).toEqual(["arrived@skyphusion.org"]);
      const lens = await store.search(env, { q: "probe", mode, to: "abuse@skyphusion.org", lens: "inbox" });
      expect(lens.items.map((h) => h.message.messageId).sort())
        .toEqual(["arrived@skyphusion.org", "sent@skyphusion.org"]);
    }
  });

  it("lens=sent is sender-based in the score-ranked modes too", async () => {
    const { env, ctx, settle } = makeFakeEnv({ VECTORIZE_FOR: "abuse@skyphusion.org" });
    await seed(env, ctx);
    await settle();
    const sent = await store.search(env, {
      q: "probe", mode: "semantic", to: "strummer@skyphusion.org", lens: "sent",
    });
    expect(sent.items.map((h) => h.message.messageId)).toEqual(["sent@skyphusion.org"]);
  });
});

// The store is the last line: the API edge refuses a viewerless lens with a 400,
// but an internal caller could still construct one. Dropping it silently would
// answer a viewer-scoped question with an estate answer, so it throws.
describe("#403 a viewerless lens is refused in the store too", () => {
  it("throws rather than returning the estate answer", async () => {
    const { env } = realEnv();
    await expect(store.list(env, { lens: "inbox" })).rejects.toThrow(/lens requires a viewer/);
    await expect(store.search(env, { q: "x", mode: "fts", lens: "sent" })).rejects.toThrow(/lens requires a viewer/);
    // CONTROL: with a viewer the same call is served.
    await expect(store.list(env, { to: "a@skyphusion.org", lens: "inbox" })).resolves.toMatchObject({ items: [] });
  });
});
