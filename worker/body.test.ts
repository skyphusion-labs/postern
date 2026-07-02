// Streaming body cap (#196, audit F6). Unit-proves readBodyCapped: the cap
// holds for chunked / header-less bodies (counted while reading, aborted the
// moment it crosses, remainder never pulled), the declared Content-Length
// fast-reject still fires first, and normal bodies decode intact -- including
// a multi-byte character split across a chunk boundary.
//
// LOCKSTEP: this suite is kept identical in inbound/body-cap.test.ts (which
// adds handleApi integration) and worker/body.test.ts; the module under test
// is byte-identical in both packages.

import { describe, it, expect } from "vitest";
import { readBodyCapped, PayloadTooLargeError } from "./src/body";

// A small injected cap keeps the unit tests cheap; the real 30 MiB value is
// exercised in the inbound handleApi integration tests.
const CAP = 64;

// Build a chunked request: a stream body carries NO content-length header, so
// only the while-reading guard can bound it. `pulls` observes how many chunks
// the reader actually consumed (proves abort-on-cross, not buffer-then-check).
function chunkedRequest(chunks: Uint8Array[], pulls?: { count: number }): Request {
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulls) pulls.count++;
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  // Node's fetch requires half duplex for stream bodies; `duplex` is not in
  // the Request types, hence the assertion.
  return new Request("https://postern.example/send", {
    method: "POST",
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
    const req = new Request("https://postern.example/send", {
      method: "POST",
      headers: { "content-length": String(CAP + 1) },
      body: "{}",
    });
    await expect(readBodyCapped(req, CAP)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("a request without a body reads as the empty string", async () => {
    const req = new Request("https://postern.example/send", { method: "POST" });
    await expect(readBodyCapped(req, CAP)).resolves.toBe("");
  });
});
