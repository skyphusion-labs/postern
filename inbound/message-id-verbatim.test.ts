// #486: the stored message_id IS the Message-ID header the sender sent.
//
// The ingest path used to replace any Message-ID over 64 chars with its sha256. That
// destroyed the only machine-parseable handle a sender gives us -- GitHub encodes
// owner/repo/{issues,pull}/N@github.com in it -- at a length cliff no consumer can see
// from the outside: keying on the structured id worked until a repo name or issue number
// crossed a threshold, then silently stopped seeing new items. It also broke THREADING
// for those ids, because in_reply_to is stored raw and never matched a hashed parent.
//
// Real SQLite (./realdb), never the pattern-matching fake: the payoff cases here are a
// UNIQUE upsert, a thread-resolution SELECT, and a read-back, which is exactly what a
// fake that recognizes SQL strings cannot judge. Every positive case is paired with a
// live control, and the pre-fix behavior is asserted as the thing that must NOT happen.

import { describe, it, expect } from "vitest";
import { ingest, normalizeMessageId, sha256hex, MAX_STORED_MESSAGE_ID, type ParsedInbound } from "./src/ingest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { realEnv } from "./realdb";

// A GitHub thread root in the shape the fc#1112 watcher parses, long enough that the
// pre-#486 cutoff would have collapsed it.
const LONG_ROOT = "skyphusion-labs/a-repository-name-that-is-long/issues/12345@github.com";

function inbound(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: LONG_ROOT,
    from: "notifications@github.com",
    to: "conrad@skyphusion.org",
    subject: "hello",
    text: "body",
    date: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

function rowCount(raw: { prepare: (sql: string) => { get: () => unknown } }): number {
  return Number((raw.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
}

function deliveredTo(raw: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }, id: string): string {
  const row = raw.prepare("SELECT delivered_to FROM messages WHERE message_id = ?").get(id) as
    | { delivered_to: string | null }
    | undefined;
  return row?.delivered_to ?? "";
}

describe("#486 a Message-ID over 64 chars survives ingest intact", () => {
  it("stores a structured GitHub root verbatim rather than its sha256", async () => {
    const { env, ctx } = realEnv();
    expect(LONG_ROOT.length).toBeGreaterThan(64);

    const res = await ingest(env, inbound(), ctx);

    expect(res.messageId).toBe(LONG_ROOT);
    // The pre-fix answer, named explicitly so a regression cannot pass quietly.
    expect(res.messageId).not.toBe(await sha256hex(LONG_ROOT));
    expect((await store.get(env, LONG_ROOT))?.messageId).toBe(LONG_ROOT);
    // And the structure a consumer keys on is still parseable off the stored id.
    expect(/^([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)@github\.com$/.exec(res.messageId)?.[4]).toBe("12345");
  });

  it("threads a reply onto that long root, with a control that a miss still forks", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound(), ctx);

    const reply = await ingest(
      env,
      inbound({ messageId: "comment-1@github.com", inReplyTo: LONG_ROOT }),
      ctx,
    );
    expect(reply.threadId).toBe(LONG_ROOT);

    // CONTROL: inheritance must be a real lookup. A parent that was never stored still
    // starts its own thread, so the assertion above is not passing for free.
    const orphan = await ingest(
      env,
      inbound({ messageId: "comment-2@github.com", inReplyTo: "never-stored@github.com" }),
      ctx,
    );
    expect(orphan.threadId).toBe("comment-2@github.com");
  });

  it("merges a redelivery of a message already stored under the pre-fix hash", async () => {
    const { env, ctx, raw } = realEnv();
    const legacy = await sha256hex(LONG_ROOT);
    // Stand-in for a row written before this change: the hash IS its message_id.
    await ingest(env, inbound({ messageId: legacy }), ctx);

    const res = await ingest(env, inbound({ to: "alerts@skyphusion.org" }), ctx);

    expect(res.messageId).toBe(legacy);
    expect(res.merged).toBe(true);
    expect(rowCount(raw)).toBe(1);
    expect(deliveredTo(raw, legacy)).toContain("alerts@skyphusion.org");
  });

  it("stores the raw header when no pre-fix row exists (control for the merge above)", async () => {
    const { env, ctx, raw } = realEnv();

    const res = await ingest(env, inbound({ to: "alerts@skyphusion.org" }), ctx);

    expect(res.messageId).toBe(LONG_ROOT);
    expect(res.stored).toBe(true);
    expect(rowCount(raw)).toBe(1);
  });

  it("collapses only past the documented cap, and stores that collapse", async () => {
    const { env, ctx } = realEnv();
    const suffix = "@example.com";
    const atCap = "a".repeat(MAX_STORED_MESSAGE_ID - suffix.length) + suffix;
    expect(atCap).toHaveLength(MAX_STORED_MESSAGE_ID);
    expect(await normalizeMessageId(env, atCap)).toBe(atCap);

    const past = "b".repeat(MAX_STORED_MESSAGE_ID) + suffix;
    const res = await ingest(env, inbound({ messageId: past }), ctx);

    expect(res.messageId).toBe(await sha256hex(past));
    expect(res.messageId).toHaveLength(64);
    expect((await store.get(env, res.messageId))?.messageId).toBe(res.messageId);
  });

  it("normalizes angle brackets and surrounding whitespace, and falls back when absent", async () => {
    const { env } = realEnv();
    expect(await normalizeMessageId(env, `  <${LONG_ROOT}>  `)).toBe(LONG_ROOT);
    const generated = await normalizeMessageId(env, "   ");
    expect(generated).not.toBe("");
    expect(generated).toHaveLength(36); // crypto.randomUUID()
  });

  it("keeps the id verbatim on the IMAP APPEND path too (one shared normalizer)", async () => {
    const { env, ctx } = realEnv({ POSTERN_API_TOKEN_IMAP: "imap-token" });
    const id = "a-very-long-imported-sent-copy-identifier-0123456789abcdef@skyphusion.org";
    expect(id.length).toBeGreaterThan(64);
    const mime = [
      "From: Conrad <conrad@skyphusion.org>",
      "To: Friend <friend@example.com>",
      "Subject: imported sent copy",
      `Message-ID: <${id}>`,
      "Date: Sat, 18 Jul 2026 00:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "sent body",
    ].join("\r\n");

    const res = await handleApi(
      new Request("https://postern.example/api/imap/import", {
        method: "POST",
        headers: { authorization: "Bearer imap-token", "content-type": "application/json" },
        body: JSON.stringify({ identity: "conrad@skyphusion.org", folder: "sent", rawMime: btoa(mime) }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(201);
    expect((await store.get(env, id))?.messageId).toBe(id);
  });
});
