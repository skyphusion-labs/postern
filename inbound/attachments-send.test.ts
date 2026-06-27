import { describe, it, expect } from "vitest";
import { send } from "./src/mailbox";
import { makeFakeEnv } from "./fakes";

// base64 of a UTF-8 string, the wire form a SendRequest attachment carries.
function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

// Decode whatever the binding received back to a string for assertions. The
// transport hands the binding raw bytes (a Uint8Array), never base64.
function decode(content: ArrayBuffer | ArrayBufferView): string {
  const u8 =
    content instanceof Uint8Array
      ? content
      : content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  return new TextDecoder().decode(u8);
}

describe("mailbox.send attachments (#70)", () => {
  it("decodes base64 attachments and hands the binding raw bytes", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await send(
      env,
      {
        to: "dev@example.com",
        subject: "report",
        text: "see attached",
        attachments: [{ filename: "report.csv", mimeType: "text/csv", content: b64("a,b,c\n1,2,3") }],
      },
      ctx,
    );
    await settle();

    expect(sent).toHaveLength(1);
    const atts = sent[0].attachments!;
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe("report.csv");
    expect(atts[0].type).toBe("text/csv");
    expect(atts[0].disposition).toBe("attachment");
    // Bytes, not base64: the binding builds the MIME from the decoded content.
    expect(decode(atts[0].content)).toBe("a,b,c\n1,2,3");
  });

  it("carries multiple attachments in order", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await send(
      env,
      {
        to: "dev@example.com",
        subject: "two files",
        text: "x",
        attachments: [
          { filename: "one.txt", mimeType: "text/plain", content: b64("ONE") },
          { filename: "two.bin", mimeType: "application/octet-stream", content: b64("TWO") },
        ],
      },
      ctx,
    );
    await settle();
    const atts = sent[0].attachments!;
    expect(atts.map((a) => a.filename)).toEqual(["one.txt", "two.bin"]);
    expect(atts.map((a) => decode(a.content))).toEqual(["ONE", "TWO"]);
  });

  it("fills sane defaults when filename/mimeType are omitted", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await send(env, { to: "d@example.com", subject: "s", text: "x", attachments: [{ content: b64("ZZ") }] }, ctx);
    await settle();
    const a = sent[0].attachments![0];
    expect(a.filename).toBe("attachment-1");
    expect(a.type).toBe("application/octet-stream");
    expect(a.disposition).toBe("attachment");
  });

  it("leaves the field-based path unchanged with no attachments", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await send(env, { to: "d@example.com", subject: "s", text: "x" }, ctx);
    await settle();
    expect(sent[0].attachments).toBeUndefined();
  });

  it("treats an empty attachments array as none (field-based path)", async () => {
    const { env, ctx, settle, sent } = makeFakeEnv();
    await send(env, { to: "d@example.com", subject: "s", text: "x", attachments: [] }, ctx);
    await settle();
    expect(sent[0].attachments).toBeUndefined();
  });

  it("rejects invalid base64 content", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(
      send(env, { to: "d@example.com", subject: "s", text: "x", attachments: [{ content: "@@@not-base64@@@" }] }, ctx),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR" });
  });

  it("rejects an attachment with no content", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(
      send(env, { to: "d@example.com", subject: "s", text: "x", attachments: [{ filename: "x.bin" } as never] }, ctx),
    ).rejects.toMatchObject({ code: "E_FIELD_MISSING" });
  });

  it("rejects CRLF injection in an attachment filename", async () => {
    const { env, ctx } = makeFakeEnv();
    await expect(
      send(
        env,
        { to: "d@example.com", subject: "s", text: "x", attachments: [{ filename: "ok\r\nBcc: v@x.com", content: b64("z") }] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "E_VALIDATION_ERROR" });
  });

  it("rejects more than the per-message attachment cap", async () => {
    const { env, ctx } = makeFakeEnv();
    const many = Array.from({ length: 21 }, (_, i) => ({ filename: `f${i}.txt`, content: b64("x") }));
    await expect(send(env, { to: "d@example.com", subject: "s", text: "x", attachments: many }, ctx)).rejects.toMatchObject({
      code: "E_VALIDATION_ERROR",
    });
  });

  it("rejects attachments over the 25 MiB decoded size cap with a 413", async () => {
    const { env, ctx } = makeFakeEnv();
    const big = Buffer.alloc(25 * 1024 * 1024 + 16, 0x41).toString("base64");
    await expect(
      send(env, { to: "d@example.com", subject: "s", text: "x", attachments: [{ content: big }] }, ctx),
    ).rejects.toMatchObject({ code: "E_PAYLOAD_TOO_LARGE", status: 413 });
  });
});
