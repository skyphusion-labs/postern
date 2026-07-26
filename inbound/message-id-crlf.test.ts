// #494: a Message-ID carrying a CR or LF cannot round-trip the RFC822 projection, so
// replies to it forked the thread.
//
// The projection neutralizes CR/LF into spaces before emitting a header (correct, and
// the reason this was never header injection), so a stored id of `a\r\nb@x` was served
// to an IMAP client as `a  b@x`. The client replied `In-Reply-To: <a  b@x>`, which
// matched no stored message_id, and the reply started its own thread. The normalizer now
// collapses such an id to its sha256, the same answer the byte budget already gives an
// id the store cannot represent; hex round-trips a header exactly.
//
// Real SQLite (./realdb) and the REAL projection, never a stand-in: the claim is about a
// thread-resolution SELECT against a header this code emitted, which only the real pair
// can judge. Every positive case is paired with a live control.

import { describe, it, expect } from "vitest";
import { ingest, normalizeMessageId, sha256hex, type ParsedInbound } from "./src/ingest";
import * as store from "./src/store";
import { renderRfc822Projection } from "./src/rfc822Project";
import { realEnv } from "./realdb";

// An interior break: trim() removes leading and trailing ones, so this is the shape that
// can actually reach a header.
const CRLF_ID = "forked\r\nroot@example.com";
const CLEAN_ID = "clean-root@example.com";

function inbound(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: CLEAN_ID,
    from: "sender@example.com",
    to: "conrad@skyphusion.org",
    subject: "hello",
    text: "body",
    date: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

/** Serve a stored message back the way the IMAP door does, and read off the Message-ID a
 *  replying client would quote. This is the whole point of the issue, so it runs through
 *  renderRfc822Projection itself rather than re-implementing what it does. */
async function projectedMessageId(env: Env, storedId: string): Promise<string> {
  const m = await store.get(env, storedId);
  if (!m) throw new Error(`no stored message ${storedId}`);
  const bytes = await renderRfc822Projection({
    messageId: m.messageId,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date,
    inReplyTo: m.inReplyTo,
    bodyText: m.bodyText,
  });
  const text = new TextDecoder().decode(bytes);
  const match = /^Message-ID: <(.*)>$/m.exec(text);
  if (!match) throw new Error("projection emitted no Message-ID header");
  return match[1]!;
}

describe("#494 a Message-ID carrying CR/LF collapses so it can round-trip", () => {
  it("stores the sha256 instead of the unrepresentable header", async () => {
    const { env, ctx } = realEnv();
    const hashed = await sha256hex(CRLF_ID);

    const res = await ingest(env, inbound({ messageId: CRLF_ID }), ctx);

    expect(res.messageId).toBe(hashed);
    expect(res.messageId).toHaveLength(64);
    // The pre-fix answer, named so a regression cannot pass quietly.
    expect(res.messageId).not.toBe(CRLF_ID);
    expect((await store.get(env, CRLF_ID))).toBeNull();
    expect((await store.get(env, hashed))?.messageId).toBe(hashed);
  });

  it("round-trips the projection, where the raw header demonstrably does not", async () => {
    const { env, ctx } = realEnv();

    const res = await ingest(env, inbound({ messageId: CRLF_ID }), ctx);

    expect(await projectedMessageId(env, res.messageId)).toBe(res.messageId);

    // The defect itself, proved live against the same projection rather than asserted
    // from reading it: had the raw header been stored, what comes back differs from it.
    const bytes = await renderRfc822Projection({
      messageId: CRLF_ID,
      from: "sender@example.com",
      to: "conrad@skyphusion.org",
      subject: "hello",
      date: "2026-07-27T00:00:00.000Z",
      bodyText: "body",
    });
    const served = /^Message-ID: <(.*)>$/m.exec(new TextDecoder().decode(bytes))![1]!;
    expect(served).not.toBe(CRLF_ID);
    expect(served).toBe("forked  root@example.com");
  });

  it("threads a reply that quotes the projected id back at us", async () => {
    const { env, ctx } = realEnv();
    const root = await ingest(env, inbound({ messageId: CRLF_ID }), ctx);
    const quoted = await projectedMessageId(env, root.messageId);

    const reply = await ingest(
      env,
      inbound({ messageId: "reply-1@example.com", inReplyTo: `<${quoted}>` }),
      ctx,
    );

    expect(reply.threadId).toBe(root.messageId);

    // CONTROL: inheritance is a real lookup, not a default. A parent that was never
    // stored still starts its own thread.
    const orphan = await ingest(
      env,
      inbound({ messageId: "reply-2@example.com", inReplyTo: "<never-stored@example.com>" }),
      ctx,
    );
    expect(orphan.threadId).toBe("reply-2@example.com");
  });

  it("CONTROL: an ordinary id is still stored and served verbatim, and still threads", async () => {
    const { env, ctx } = realEnv();

    const root = await ingest(env, inbound(), ctx);

    expect(root.messageId).toBe(CLEAN_ID);
    expect(root.messageId).not.toBe(await sha256hex(CLEAN_ID));
    expect(await projectedMessageId(env, CLEAN_ID)).toBe(CLEAN_ID);

    const reply = await ingest(
      env,
      inbound({ messageId: "reply-3@example.com", inReplyTo: `<${CLEAN_ID}>` }),
      ctx,
    );
    expect(reply.threadId).toBe(CLEAN_ID);
  });

  it("collapses a break anywhere inside the id, and only inside it", async () => {
    const { env } = realEnv();

    // A bare CR and a bare LF each trigger it, not just the pair.
    expect(await normalizeMessageId(env, "a\rb@example.com")).toBe(await sha256hex("a\rb@example.com"));
    expect(await normalizeMessageId(env, "a\nb@example.com")).toBe(await sha256hex("a\nb@example.com"));

    // Surrounding whitespace, including breaks, is TRIMMED as before and changes
    // nothing: the id is representable, so it stays verbatim.
    expect(await normalizeMessageId(env, `\r\n  <${CLEAN_ID}>  \r\n`)).toBe(CLEAN_ID);
  });

  it("leaves the legacy lookup first, so a pre-#486 row still MERGES rather than forking", async () => {
    const { env, ctx, raw } = realEnv();
    // The deliberate placement: the collapse runs AFTER the legacy existence check. A
    // long id carrying a break was stored pre-#486 under the sha256 of the UNTRIMMED
    // header, and a redelivery has to land on that row (#178). The legacy hash is hex
    // too, so the round-trip guarantee holds either way.
    const longCrlf =
      "skyphusion-labs/a-repository-name-that-is-long/issues/12345\r\nsecond@github.com";
    // PADDED, which is what makes this test discriminate: the legacy key is the sha256
    // of the untrimmed header, so it differs from the sha256 of what we would store. A
    // collapse that jumped ahead of the lookup would answer the OTHER hash and fork.
    const padded = ` ${longCrlf} `;
    expect(longCrlf.length).toBeGreaterThan(64);
    const legacy = await sha256hex(padded);
    expect(legacy).not.toBe(await sha256hex(longCrlf));
    await ingest(env, inbound({ messageId: legacy }), ctx);

    const res = await ingest(env, inbound({ messageId: padded, to: "alerts@skyphusion.org" }), ctx);

    expect(res.messageId).toBe(legacy);
    expect(res.merged).toBe(true);
    const rows = Number(
      (raw.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
    );
    expect(rows).toBe(1);
  });
});
