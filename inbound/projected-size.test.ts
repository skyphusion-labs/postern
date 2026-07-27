import { describe, expect, it } from "vitest";
import { makeFakeEnv } from "./fakes";
import { PROJECTION_VERSION, projectRfc822Size, renderRfc822Projection } from "./src/rfc822Project";
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
    // Projection v3 (#507): CRLF terminators, so every constant here moved.
    const base = {
      messageId: "abc123",
      from: "alice@example.com",
      to: "agent@skyphusion.org",
      date: "2026-06-18T12:00:00Z",
    };
    expect(
      await projectRfc822Size({
        ...base,
        subject: "Hello",
        bodyText: "line one\nline two",
      }),
    ).toBe(245);
    expect(
      await projectRfc822Size({
        ...base,
        subject: "Hello",
        bodyText: "line one",
        attachments: [{ filename: "f.pdf", mime: "application/pdf", size: 100 }],
      }),
    ).toBe(719);
    // Unicode corpus (v2): B-encoding + B-encoded filenames; no Header Q/fold.
    expect(
      await projectRfc822Size({ ...base, messageId: "u1", subject: "café", bodyText: "hi" }),
    ).toBe(240);
    expect(
      await projectRfc822Size({
        ...base,
        messageId: "u2",
        from: "José <jose@example.com>",
        subject: "Hello",
        bodyText: "hi",
      }),
    ).toBe(247);
    expect(
      await projectRfc822Size({
        ...base,
        messageId: "u3",
        subject: "Hello",
        bodyText: "hi",
        attachments: [{ filename: "résumé.pdf", mime: "application/pdf", size: 10 }],
      }),
    ).toBe(633);
    expect(
      await projectRfc822Size({
        ...base,
        messageId: "u4",
        subject: ("Long ".repeat(40)) + "café",
        bodyText: "hi",
      }),
    ).toBe(508);
    expect(
      await projectRfc822Size({
        ...base,
        messageId: "u5",
        subject: "Hello café world",
        bodyText: "hi",
      }),
    ).toBe(256);
    expect(PROJECTION_VERSION).toBe(3);
  });

  it("emits CRLF terminators with no bare LF or bare CR (#507)", async () => {
    // RFC 5322 section 2.1: CR and LF MUST NOT appear independently. The worker caches
    // this projection as projected_size while the IMAP door serves the SAME bytes as
    // the BODY[] literal, so a bare LF here is both an RFC violation on the wire and a
    // size that cannot match. Mirrors CrlfProjectionTest in
    // imap/posternimap/tests/test_rfc822.py -- change one, change both.
    const base = {
      messageId: "crlf-1",
      from: "alice@example.com",
      to: "agent@skyphusion.org",
      date: "2026-06-18T12:00:00Z",
      subject: "Hello",
    };
    const att = { filename: "inv.pdf", mime: "application/pdf", size: 265 };
    const shapes: Record<string, Parameters<typeof renderRfc822Projection>[0]> = {
      plain: { ...base, bodyText: "one\ntwo\nthree" },
      html: { ...base, bodyText: "one\ntwo", bodyHtml: "<p>hi</p>" },
      attachment: { ...base, bodyText: "one\ntwo", attachments: [att] },
      "html+attachment": { ...base, bodyText: "one", bodyHtml: "<p>hi</p>", attachments: [att] },
    };
    for (const [label, input] of Object.entries(shapes)) {
      const bytes = await renderRfc822Projection(input);
      let bareLf = 0;
      let bareCr = 0;
      let crlf = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) bareLf++;
        if (bytes[i] === 0x0d && (i + 1 >= bytes.length || bytes[i + 1] !== 0x0a)) bareCr++;
        if (bytes[i] === 0x0a && i > 0 && bytes[i - 1] === 0x0d) crlf++;
      }
      expect(bareLf, `bare LF in the ${label} projection`).toBe(0);
      expect(bareCr, `bare CR in the ${label} projection`).toBe(0);
      // Controls: a zero above must come from a real render, not an empty buffer or a
      // body that had no line breaks in it to begin with.
      expect(bytes.byteLength, `${label} produced no bytes`).toBeGreaterThan(100);
      expect(crlf, `${label} contains no CRLF at all`).toBeGreaterThan(3);
    }
  });

  it("normalizes mixed input line endings to CRLF, idempotently (#507)", async () => {
    // A body arriving with CRLF must not gain a second CR, and a bare CR must not
    // survive. Byte-for-byte the same rule as _to_crlf in imap/posternimap/rfc822.py.
    const base = {
      messageId: "crlf-2",
      from: "alice@example.com",
      to: "agent@skyphusion.org",
      date: "2026-06-18T12:00:00Z",
      subject: "Hello",
    };
    const mixed = await renderRfc822Projection({ ...base, bodyText: "a\r\nb\rc\nd" });
    expect(new TextDecoder().decode(mixed)).toContain("a\r\nb\r\nc\r\nd");
    // The same body already in CRLF projects to the SAME length (idempotent).
    const already = await projectRfc822Size({ ...base, bodyText: "a\r\nb\r\nc\r\nd" });
    expect(already).toBe(mixed.byteLength);
  });
});
