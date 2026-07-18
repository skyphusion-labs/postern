import { describe, expect, it } from "vitest";
import { makeFakeEnv } from "./fakes";
import { PROJECTION_VERSION, projectRfc822Size } from "./src/rfc822Project";
import * as store from "./src/store";

describe("projected size (#342)", () => {
  it("stores projectedSize on put and exposes it on get + list summary", async () => {
    const { env, ctx, settle } = makeFakeEnv();
    const body = "hello projected";
    const att = new TextEncoder().encode("attach-bytes").buffer;
    await store.put(
      env,
      {
        messageId: "proj-1",
        direction: "inbound",
        from: "alice@example.com",
        to: "agent@skyphusion.org",
        subject: "Hello",
        date: "2026-06-18T12:00:00Z",
        bodyText: body,
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        trusted: true,
        attachments: [{ filename: "a.txt", mimeType: "text/plain", content: att }],
      },
      ctx,
    );
    await settle();

    const expected = await projectRfc822Size({
      messageId: "proj-1",
      from: "alice@example.com",
      to: "agent@skyphusion.org",
      subject: "Hello",
      date: "2026-06-18T12:00:00Z",
      bodyText: body,
      attachments: [{ filename: "a.txt", mime: "text/plain", size: att.byteLength }],
    });

    const msg = await store.get(env, "proj-1");
    expect(msg?.projectedSize).toBe(expected);
    expect(msg?.projectionVersion).toBe(PROJECTION_VERSION);

    const page = await store.list(env, { limit: 10 });
    const row = page.items.find((m) => m.messageId === "proj-1");
    expect(row?.projectedSize).toBe(expected);
    expect(row?.projectionVersion).toBe(PROJECTION_VERSION);
  });

  it("matches Python golden sizes for the shared fixture set", async () => {
    // Kept in lockstep with imap/posternimap/rfc822.py project_rfc822_size samples.
    expect(
      await projectRfc822Size({
        messageId: "abc123",
        from: "alice@example.com",
        to: "agent@skyphusion.org",
        subject: "Hello",
        date: "2026-06-18T12:00:00Z",
        bodyText: "line one\nline two",
      }),
    ).toBe(234);
    expect(
      await projectRfc822Size({
        messageId: "abc123",
        from: "alice@example.com",
        to: "agent@skyphusion.org",
        subject: "Hello",
        date: "2026-06-18T12:00:00Z",
        bodyText: "line one",
        attachments: [{ filename: "f.pdf", mime: "application/pdf", size: 100 }],
      }),
    ).toBe(697);
  });
});
