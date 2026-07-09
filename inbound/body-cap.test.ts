// Streaming body cap (#196, audit F6). Unit-proves readBodyCapped, then
// integration-proves the REAL 30 MiB cap through handleApi: a chunked
// over-cap POST is 413 before anything sends, an under-cap chunked POST works,
// and the declared Content-Length path is unchanged.
//
// LOCKSTEP: the unit half of this suite is kept identical in
// worker/body.test.ts; the module under test is byte-identical in both
// packages.

import { describe, it, expect } from "vitest";
import { readBodyCapped, PayloadTooLargeError } from "./src/body";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// A small injected cap keeps the unit tests cheap; the real 30 MiB value is
// exercised in the handleApi integration tests below.
const CAP = 64;

// Build a chunked request: a stream body carries NO content-length header, so
// only the while-reading guard can bound it. `pulls` observes how many chunks
// the reader actually consumed (proves abort-on-cross, not buffer-then-check).
function chunkedRequest(chunks: Uint8Array[], pulls?: { count: number }, token?: string): Request {
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulls) pulls.count++;
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  // Node's fetch requires half duplex for stream bodies; `duplex` is not in
  // the Request types, hence the assertion.
  return new Request("https://postern.example/api/send", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("readBodyCapped (#196)", () => {
  it("reassembles an under-cap chunked body, including a multi-byte char split across chunks", async () => {
    // "é" is 0xC3 0xA9; split it across the chunk boundary.
    const bytes = new TextEncoder().encode('{"subject":"café"}');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const text = await readBodyCapped(chunkedRequest([bytes.slice(0, cut), bytes.slice(cut)]), CAP);
    expect(JSON.parse(text)).toEqual({ subject: "café" });
  });

  it("accepts a body of exactly the cap (crossing means MORE than the cap)", async () => {
    const text = await readBodyCapped(chunkedRequest([new Uint8Array(CAP).fill(120)]), CAP);
    expect(text).toHaveLength(CAP);
  });

  it("rejects a chunked over-cap body the moment the cap crosses and stops pulling", async () => {
    // 32-byte chunks against a 64-byte cap: pull 1 = 32, pull 2 = 64 (still
    // allowed), pull 3 = 96 -> abort. Pulls 4-6 must never happen.
    const pulls = { count: 0 };
    const chunks = Array.from({ length: 6 }, () => new Uint8Array(32).fill(120));
    await expect(readBodyCapped(chunkedRequest(chunks, pulls), CAP)).rejects.toBeInstanceOf(PayloadTooLargeError);
    // The stream machinery may run ONE readahead pull before the cancel lands,
    // so bound it instead of pinning it: full drain would be 7 pulls (6 chunks
    // + close); crossing-pull 3 plus at most one readahead proves early abort.
    expect(pulls.count).toBeGreaterThanOrEqual(3);
    expect(pulls.count).toBeLessThanOrEqual(4);
  });

  it("fast-rejects a declared over-cap Content-Length without reading the body", async () => {
    const req = new Request("https://postern.example/api/send", {
      method: "POST",
      headers: { "content-length": String(CAP + 1) },
      body: "{}",
    });
    await expect(readBodyCapped(req, CAP)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("a request without a body reads as the empty string", async () => {
    const req = new Request("https://postern.example/api/send", { method: "POST" });
    await expect(readBodyCapped(req, CAP)).resolves.toBe("");
  });
});

describe("30 MiB body cap through handleApi (#196)", () => {
  const MIB = 1024 * 1024;

  it("accepts an under-cap chunked send (no Content-Length header)", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    const bytes = new TextEncoder().encode(JSON.stringify({ to: "d@example.com", subject: "hi", text: "yo" }));
    const req = chunkedRequest([bytes.slice(0, 10), bytes.slice(10)], undefined, "test-token");
    const res = await handleApi(req, env, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("413s a chunked over-cap send at the crossing chunk; nothing sends, the tail is never pulled", async () => {
    const { env, ctx, sent } = makeFakeEnv();
    // 8 MiB chunks against the real 30 MiB cap: crossing at pull 4 (32 MiB);
    // pulls 5-6 must never happen even though the stream could supply them.
    const pulls = { count: 0 };
    const chunks = Array.from({ length: 6 }, () => new Uint8Array(8 * MIB).fill(120));
    const res = await handleApi(chunkedRequest(chunks, pulls, "test-token"), env, ctx);
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "E_PAYLOAD_TOO_LARGE" });
    // Bounded, not pinned: the machinery may run ONE readahead pull before the
    // cancel lands. Full drain would be 7 pulls; crossing-pull 4 plus at most
    // one readahead proves the tail was never consumed.
    expect(pulls.count).toBeGreaterThanOrEqual(4);
    expect(pulls.count).toBeLessThanOrEqual(5);
    expect(sent).toHaveLength(0);
  });

  it("declared over-cap Content-Length still 413s up front (path unchanged)", async () => {
    const { env, ctx, sent } = makeFakeEnv();
    const req = new Request("https://postern.example/api/send", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-length": String(30 * MIB + 1),
      },
      body: JSON.stringify({ to: "d@example.com", subject: "hi", text: "yo" }),
    });
    const res = await handleApi(req, env, ctx);
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "E_PAYLOAD_TOO_LARGE" });
    expect(sent).toHaveLength(0);
  });
});

describe("reindex body cap through handleApi (#202)", () => {
  const MIB = 1024 * 1024;

  it("413s a chunked over-cap reindex body before the page runs", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_API_TOKEN: "both-token" });
    const pulls = { count: 0 };
    const chunks = Array.from({ length: 6 }, () => new Uint8Array(8 * MIB).fill(123));
    const req = chunkedRequest(chunks, pulls, "both-token");
    const res = await handleApi(
      new Request("https://postern.example/api/admin/reindex", {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: "half",
      } as RequestInit),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "E_PAYLOAD_TOO_LARGE" });
    expect(pulls.count).toBeGreaterThanOrEqual(4);
    expect(pulls.count).toBeLessThanOrEqual(5);
  });

  it("accepts an empty reindex body through the capped reader", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_API_TOKEN: "both-token" });
    const req = new Request("https://postern.example/api/admin/reindex", {
      method: "POST",
      headers: { authorization: "Bearer both-token" },
    });
    const res = await handleApi(req, env, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});
