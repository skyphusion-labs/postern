// #500: a non-ASCII Message-ID was served RFC 2047 encoded, so it did not round-trip the
// projection either, and a reply to it forked the thread.
//
// Two halves, both tested here against the REAL store (./realdb) and the REAL projection:
//
//   EMISSION. `Message-ID` and `In-Reply-To` are `msg-id` (RFC 5322 section 3.6.4), a
//   STRUCTURED field body, and RFC 2047 section 5 says an encoded-word "MUST NOT be used
//   ... in any structured field body except within a 'comment' or 'phrase'". So an
//   identifier is emitted as stored, never encoded. Measured before the fix: Mutt 2.2.12
//   quoted our encoded-word back verbatim and matched no stored message_id.
//
//   REPRESENTABILITY. Emitting as stored is not enough on its own, which was measured
//   too: the door re-parses its own rendered bytes, so a non-ASCII header crashed the
//   FETCH, and once that was hardened the id came back ASCII-replaced (`na??ve-...`) and
//   the reply STILL forked. RFC 6532 makes such an id legal, but our door cannot carry it
//   until #504, so it is not representable and the #494 rule applies: verbatim unless the
//   id cannot be represented. The same transform runs on the ids thread resolution
//   matches against, or the collapse would just move the fork (finding 2 on #500).
//
// Every positive case is paired with a live control.

import { describe, it, expect } from "vitest";
import { ingest, normalizeMessageId, representableId, sha256hex, type ParsedInbound } from "./src/ingest";
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
async function projectedHeaders(
  env: Env,
  storedId: string,
): Promise<{ raw: string; messageId: string; inReplyTo: string | null }> {
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
  it("emits a non-ASCII identifier as given, in both structured fields", async () => {
    // Tested on the projection DIRECTLY: the store no longer hands it one (see the
    // collapse below), but `in_reply_to` is kept raw, so an 8-bit value can still reach
    // this seam and it must not answer with an encoded-word.
    const bytes = await renderRfc822Projection({
      messageId: NONASCII_ID,
      inReplyTo: NONASCII_ID,
      from: "sender@example.net",
      to: "conrad@example.com",
      subject: "hello",
      date: "2026-07-27T00:00:00.000Z",
      bodyText: "body",
    });
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain(`Message-ID: <${NONASCII_ID}>`);
    expect(text).toContain(`In-Reply-To: <${NONASCII_ID}>`);
    // The pre-fix answer, named so a regression cannot pass quietly.
    expect(text).not.toContain("=?utf-8?b?");
  });

  it("CONTROL: Subject is unstructured, so it is still RFC 2047 encoded", async () => {
    // Without this the change could have disabled encoding everywhere and still passed.
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

describe("#500 an id the door cannot carry is not representable, so it collapses", () => {
  it("stores the sha256 instead of the unservable header", async () => {
    const { env, ctx } = realEnv();
    const hashed = await sha256hex(NONASCII_ID);

    const res = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);

    expect(res.messageId).toBe(hashed);
    expect(res.messageId).toHaveLength(64);
    expect(res.messageId).not.toBe(NONASCII_ID);
    expect(await store.get(env, NONASCII_ID)).toBeNull();
    expect((await store.get(env, hashed))?.messageId).toBe(hashed);
  });

  it("round-trips the projection, where the raw header demonstrably does not", async () => {
    const { env, ctx } = realEnv();

    const res = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);
    expect(await projectedHeaders(env, res.messageId)).toMatchObject({ messageId: res.messageId });

    // The defect itself, against the same projection rather than asserted from reading
    // it: the served bytes are ASCII, so what a client quotes can match a stored id.
    const served = (await projectedHeaders(env, res.messageId)).messageId;
    expect(served).toBe(res.messageId);
    expect(/^[\x20-\x7e]+$/.test(served)).toBe(true);
  });

  it("threads a reply that quotes the served id back at us", async () => {
    const { env, ctx } = realEnv();
    const root = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);
    const quoted = (await projectedHeaders(env, root.messageId)).messageId;

    const reply = await ingest(
      env,
      inbound({ messageId: "reply-1@example.net", inReplyTo: `<${quoted}>` }),
      ctx,
    );
    expect(reply.threadId).toBe(root.messageId);
  });

  it("threads a reply that quotes the sender's OWN raw id, which the collapse alone would have forked", async () => {
    // Finding 2 on #500: a client that never saw our projection quotes the true header.
    // Thread resolution runs the same representableId over it, so it still lands on the
    // collapsed parent instead of starting a second thread.
    const { env, ctx } = realEnv();
    const root = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);

    const reply = await ingest(
      env,
      inbound({ messageId: "reply-2@example.net", inReplyTo: `<${NONASCII_ID}>` }),
      ctx,
    );
    expect(reply.threadId).toBe(root.messageId);

    // Same via References rather than In-Reply-To.
    const viaRefs = await ingest(
      env,
      inbound({ messageId: "reply-3@example.net", references: [`<${NONASCII_ID}>`] }),
      ctx,
    );
    expect(viaRefs.threadId).toBe(root.messageId);

    // CONTROL: inheritance is a real lookup, not a default. An unrepresentable id whose
    // parent was never stored still starts its own thread.
    const orphan = await ingest(
      env,
      inbound({ messageId: "reply-4@example.net", inReplyTo: "<névér-stored@example.net>" }),
      ctx,
    );
    expect(orphan.threadId).toBe("reply-4@example.net");
  });

  it("CONTROL: an ASCII id is still stored and served verbatim, and still threads", async () => {
    const { env, ctx } = realEnv();

    const root = await ingest(env, inbound({ messageId: ASCII_ID }), ctx);
    expect(root.messageId).toBe(ASCII_ID);
    expect(root.messageId).not.toBe(await sha256hex(ASCII_ID));
    expect((await projectedHeaders(env, ASCII_ID)).messageId).toBe(ASCII_ID);

    const reply = await ingest(
      env,
      inbound({ messageId: "reply-5@example.net", inReplyTo: `<${ASCII_ID}>` }),
      ctx,
    );
    expect(reply.threadId).toBe(ASCII_ID);
  });

  it("states ONE rule: representableId decides, and normalizeMessageId agrees with it", async () => {
    const { env } = realEnv();

    // Every unrepresentable class lands on the same answer, from the same function.
    expect(await representableId(NONASCII_ID)).toBe(await sha256hex(NONASCII_ID));
    expect(await representableId("a\rb@example.com")).toBe(await sha256hex("a\rb@example.com"));
    const tooLong = "x".repeat(300) + "@example.com";
    expect(await representableId(tooLong)).toBe(await sha256hex(tooLong));

    // ...and a representable one is untouched, including one that only LOOKS exotic.
    expect(await representableId(ASCII_ID)).toBe(ASCII_ID);
    expect(await representableId("owner/repo/issues/12@github.com")).toBe(
      "owner/repo/issues/12@github.com",
    );

    // normalizeMessageId is the same rule plus the legacy existence check.
    expect(await normalizeMessageId(env, `<${NONASCII_ID}>`)).toBe(await sha256hex(NONASCII_ID));
    expect(await normalizeMessageId(env, `<${ASCII_ID}>`)).toBe(ASCII_ID);
  });
});

// The two projectors are byte-length identical BY CONTRACT: the worker caches
// projected_size from D1 metadata and the door serves BODY[] from its own renderer, so a
// drift makes RFC822.SIZE disagree with the literal it labels, the one combination that
// breaks size-validating clients. Measured live before this change (projectedSize 279 ==
// door RFC822.SIZE 279; 251 == 251), so the same fixtures are asserted against the SAME
// constants on both sides. The Python half is
// imap/posternimap/tests/test_rfc822.py::ProjectionLockstepTest -- change one, change both.
const LOCKSTEP = {
  nonascii_id: 264,
  ascii_id: 259,
  nonascii_in_reply_to: 302,
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
