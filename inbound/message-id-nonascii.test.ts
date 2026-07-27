// #500: a non-ASCII Message-ID was served RFC 2047 encoded, so it did not round-trip the
// projection either.
//
// RFC 5322 section 3.6.4 defines `Message-ID` and `In-Reply-To` as `msg-id`, a STRUCTURED
// field body. RFC 2047 section 5 says an encoded-word "MUST NOT be used ... in any
// structured field body except within a 'comment' or 'phrase'", so encoding one there was
// a MUST NOT violation, not merely something the RFC declines to bless.
//
// Measured before the fix, against the real door and a real client: the id was served as
// `=?utf-8?b?PG5hw692ZS1yb290QGV4YW1wbGUuY29tPg==?=` with the angle brackets INSIDE the
// base64, and Mutt 2.2.12 quoted that encoded-word back verbatim in `In-Reply-To`. It
// matched no stored message_id and the reply forked the thread.
//
// Real SQLite (./realdb) and the REAL projection, never a stand-in, with an ASCII control
// beside every positive case.

import { describe, it, expect } from "vitest";
import { ingest, type ParsedInbound } from "./src/ingest";
import * as store from "./src/store";
import { projectRfc822Size, renderRfc822Projection } from "./src/rfc822Project";
import { realEnv } from "./realdb";

const NONASCII_ID = "naïve-root@example.com";
const ASCII_ID = "ascii-root@example.com";

function inbound(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: ASCII_ID,
    from: "sender@example.net",
    to: "conrad@example.com",
    subject: "hello",
    text: "body",
    date: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

/** Serve a stored message back the way the IMAP door does, and read off the header a
 *  replying client would quote. Runs through renderRfc822Projection itself. */
async function projectedHeaders(env: Env, storedId: string): Promise<{ raw: string; messageId: string; inReplyTo: string | null }> {
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
  const mid = /^Message-ID: <(.*)>$/m.exec(text);
  if (!mid) throw new Error("projection emitted no Message-ID header");
  const irt = /^In-Reply-To: <(.*)>$/m.exec(text);
  return { raw: text, messageId: mid[1]!, inReplyTo: irt ? irt[1]! : null };
}

describe("#500 a structured identifier header is never RFC 2047 encoded", () => {
  it("serves a non-ASCII Message-ID as stored, so it round-trips", async () => {
    const { env, ctx } = realEnv();

    const res = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);
    expect(res.messageId).toBe(NONASCII_ID);

    const served = await projectedHeaders(env, res.messageId);
    expect(served.messageId).toBe(NONASCII_ID);
    // The pre-fix answer, named so a regression cannot pass quietly.
    expect(served.raw).not.toContain("=?utf-8?b?");
    expect(served.raw).toContain(`Message-ID: <${NONASCII_ID}>`);
  });

  it("threads a reply that quotes the served id back at us, which it could not before", async () => {
    const { env, ctx } = realEnv();
    const root = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);
    const quoted = (await projectedHeaders(env, root.messageId)).messageId;

    const reply = await ingest(
      env,
      inbound({ messageId: "reply-1@example.net", inReplyTo: `<${quoted}>` }),
      ctx,
    );
    expect(reply.threadId).toBe(NONASCII_ID);

    // The pre-fix quote, proved to fail against the same real store rather than assumed:
    // an encoded-word matches no row and starts its own thread.
    const encodedQuote = "=?utf-8?b?PG5hw692ZS1yb290QGV4YW1wbGUuY29tPg==?=";
    const forked = await ingest(
      env,
      inbound({ messageId: "reply-2@example.net", inReplyTo: `<${encodedQuote}>` }),
      ctx,
    );
    expect(forked.threadId).toBe("reply-2@example.net");

    // CONTROL: inheritance is a real lookup, not a default.
    const orphan = await ingest(
      env,
      inbound({ messageId: "reply-3@example.net", inReplyTo: "<never-stored@example.net>" }),
      ctx,
    );
    expect(orphan.threadId).toBe("reply-3@example.net");
  });

  it("serves a non-ASCII In-Reply-To as stored too", async () => {
    const { env, ctx } = realEnv();
    await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);
    const reply = await ingest(
      env,
      inbound({ messageId: "reply-4@example.net", inReplyTo: NONASCII_ID }),
      ctx,
    );

    const served = await projectedHeaders(env, reply.messageId);
    expect(served.inReplyTo).toBe(NONASCII_ID);
    expect(served.raw).not.toContain("=?utf-8?b?");
  });

  it("CONTROL: an ASCII id is unchanged, and a non-ASCII SUBJECT is still encoded", async () => {
    const { env, ctx } = realEnv();

    const root = await ingest(env, inbound({ messageId: ASCII_ID }), ctx);
    const served = await projectedHeaders(env, root.messageId);
    expect(served.messageId).toBe(ASCII_ID);
    expect(served.raw).toContain(`Message-ID: <${ASCII_ID}>`);

    // Subject IS unstructured, so RFC 2047 applies there and must keep applying. This is
    // the control that proves the change is scoped to the structured fields.
    const bytes = await renderRfc822Projection({
      messageId: ASCII_ID,
      from: "sender@example.net",
      to: "conrad@example.com",
      subject: "naïve subject",
      date: "2026-07-27T00:00:00.000Z",
      bodyText: "body",
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toMatch(/^Subject: =\?utf-8\?b\?/m);
    expect(text).toContain(`Message-ID: <${ASCII_ID}>`);
  });
});

// The two projectors are byte-length identical BY CONTRACT: the worker caches
// projected_size from D1 metadata and the door serves BODY[] from its own renderer, so a
// drift makes RFC822.SIZE disagree with the literal, the one combination that breaks
// size-validating clients. Measured live before this change (projectedSize 279 == door
// RFC822.SIZE 279; 251 == 251), so the same fixtures are asserted against the SAME
// constants on both sides. The Python half is
// imap/posternimap/tests/test_rfc822.py::ProjectionLockstepTest -- change one, change both.
const LOCKSTEP = {
  nonascii_id: 254,
  ascii_id: 249,
  nonascii_in_reply_to: 291,
} as const;

describe("#500 projection lockstep with imap/posternimap/rfc822.py", () => {
  const base = {
    from: "sender@example.net",
    to: "conrad@example.com",
    date: "2026-07-27T00:00:00Z",
    bodyText: "root body\n",
  };

  it("nonascii_id", async () => {
    expect(
      await projectRfc822Size({ ...base, messageId: NONASCII_ID, subject: "non-ascii id root" }),
    ).toBe(LOCKSTEP.nonascii_id);
  });

  it("ascii_id", async () => {
    expect(
      await projectRfc822Size({ ...base, messageId: ASCII_ID, subject: "ascii id root" }),
    ).toBe(LOCKSTEP.ascii_id);
  });

  it("nonascii_in_reply_to", async () => {
    expect(
      await projectRfc822Size({
        ...base,
        messageId: "reply@example.net",
        subject: "Re: non-ascii id root",
        inReplyTo: NONASCII_ID,
      }),
    ).toBe(LOCKSTEP.nonascii_in_reply_to);
  });
});
