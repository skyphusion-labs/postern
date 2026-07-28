// #504: UTF8=ACCEPT is a WIRE capability, not a storage rule, and this file is the
// executable statement of that separation.
//
// The worry that scoped the issue was that serving a raw identifier to a connection
// that ENABLEd the extension, and a collapsed one to everyone else, would make
// "representable" connection-dependent and fork a thread depending on which client
// replied. It does not, because the two questions live in different layers AND in
// different processes:
//
//   STORAGE  (this worker)  representableId() decides what form an id LIVES under in
//                           D1. It is pure, it takes no connection, and both the serve
//                           seam and the thread-match seam call that one function.
//   WIRE     (the door)     UTF8=ACCEPT decides what bytes THIS socket may receive. It
//                           never reaches the store and the store never learns about it.
//
// So the door gained a per-connection flag and this file did not change behaviour at
// all. These tests exist to keep it that way: they fail loudly if someone later teaches
// the storage rule about connections, or removes the dual-candidate lookup that makes
// the two served forms converge on one row.

import { describe, it, expect } from "vitest";
import { ingest, representableId, sha256hex, type ParsedInbound } from "./src/ingest";
import { realEnv } from "./realdb";

const NONASCII_ID = "parent-café-日@example.com";
// What a connection that has NOT enabled the extension is shown: the ASCII fold.
const FOLDED_DISPLAY = "parent-caf?-?@example.com";

function inbound(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    messageId: "root@example.com",
    from: "sender@example.net",
    to: "conrad@example.com",
    subject: "hello",
    text: "body",
    date: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

describe("#504 representability is a STORAGE rule and takes no connection", () => {
  it("is a pure unary function: same input, same answer, no context argument", async () => {
    // Arity is the claim. A connection-dependent rule would need somewhere to put the
    // connection, and there is nowhere to put it.
    expect(representableId.length).toBe(1);
    const a = await representableId(NONASCII_ID);
    const b = await representableId(NONASCII_ID);
    expect(a).toBe(b);
    expect(a).toBe(await sha256hex(NONASCII_ID));

    // CONTROL: the function is live and discriminating, not a constant. A representable
    // id comes back verbatim, so the equality above is a real decision.
    expect(await representableId("plain@example.com")).toBe("plain@example.com");
  });

  it("both served forms of one parent converge on ONE thread", async () => {
    const { env, ctx } = realEnv();
    const root = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);

    // What every client is served today, and what an ENABLEd client would be served if
    // the storage rule later widens: the stored form.
    const viaStored = await ingest(
      env,
      inbound({ messageId: "r1@example.net", inReplyTo: `<${root.messageId}>` }),
      ctx,
    );
    expect(viaStored.threadId).toBe(root.messageId);

    // What a client that never saw our projection quotes: the sender's own raw header.
    // resolveThreadId pushes each candidate as written AND as representableId would have
    // stored it, so this lands on the same row. Deleting that second candidate is the
    // edit this assertion exists to catch.
    const viaRaw = await ingest(
      env,
      inbound({ messageId: "r2@example.net", inReplyTo: `<${NONASCII_ID}>` }),
      ctx,
    );
    expect(viaRaw.threadId).toBe(root.messageId);
  });

  it("the ASCII fold is a DISPLAY form and is deliberately not a thread key", async () => {
    // This is the argument FOR the extension, stated as a test rather than as prose.
    // The fold is lossy and many distinct ids collapse onto it, so it must never match a
    // stored row; if it did, two unrelated conversations sharing a fold would merge.
    // A client that can only ever see the folded form therefore cannot reply into the
    // right thread, and UTF8=ACCEPT is what lets a client see the real one instead.
    const { env, ctx } = realEnv();
    const root = await ingest(env, inbound({ messageId: NONASCII_ID }), ctx);

    const viaFolded = await ingest(
      env,
      inbound({ messageId: "r3@example.net", inReplyTo: `<${FOLDED_DISPLAY}>` }),
      ctx,
    );
    expect(viaFolded.threadId).toBe("r3@example.net");
    expect(viaFolded.threadId).not.toBe(root.messageId);
  });
});
