import { describe, it, expect } from "vitest";
import { send, reply } from "./src/mailbox";
import { handleApi } from "./src/api";
import { ingest } from "./src/ingest";
import { makeFakeEnv } from "./fakes";

// #470: the sent copy must be stored WITH its attachments. dispatchAndStore always
// handed the parts to the transport (so the recipient got them), but the store.put
// for the sent copy carried none, so the author read their own send back with
// attachmentCount 0 and no bytes to serve. These drive the REAL read handler
// (handleApi) against the stored copy, which is the contract the live smoke leg 8
// states end to end.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** base64 of a UTF-8 string: the wire form a SendRequest attachment carries. */
function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

function read(path: string, token = "test-token"): Request {
  return new Request(`https://postern.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** The stored message as the API serves it (the smoke read-back). */
async function stored(env: Env, id: string): Promise<Record<string, unknown>> {
  const res = await handleApi(read(`/api/messages/${encodeURIComponent(id)}`), env, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { message: Record<string, unknown> };
  return body.message;
}

/** The list summary for one id (where attachmentCount lives). */
async function summary(env: Env, id: string): Promise<Record<string, unknown> | undefined> {
  const res = await handleApi(read("/api/messages"), env, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Record<string, unknown>[] };
  return body.items.find((m) => m.messageId === id);
}

/** Decode whatever the transport handed the binding, for the passthrough control. */
function decode(content: ArrayBuffer | ArrayBufferView): string {
  const u8 =
    content instanceof Uint8Array
      ? content
      : content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  return new TextDecoder().decode(u8);
}

describe("sent copy stores its attachments (#470)", () => {
  it("reports the attachment metadata on the stored sent copy", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    const { messageId } = await send(
      env,
      {
        to: "dev@example.com",
        subject: "report",
        text: "see attached",
        attachments: [{ filename: "report.csv", mimeType: "text/csv", content: b64("a,b,c\n1,2,3") }],
      },
      fctx,
    );
    await settle();

    const msg = await stored(env, messageId);
    expect(msg.direction).toBe("outbound");
    expect(msg.attachments).toEqual([{ filename: "report.csv", mime: "text/csv", size: 11 }]);
    // The same fact the live smoke asserts from the list summary.
    expect((await summary(env, messageId))?.attachmentCount).toBe(1);
  });

  it("serves the sent attachment bytes back byte-for-byte", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    const payload = "postern sent-copy attachment\n";
    const { messageId } = await send(
      env,
      {
        to: "dev@example.com",
        subject: "report",
        text: "see attached",
        attachments: [{ filename: "note.txt", mimeType: "text/plain", content: b64(payload) }],
      },
      fctx,
    );
    await settle();

    const res = await handleApi(
      read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="note.txt"');
    expect(await res.text()).toBe(payload);
  });

  it("keeps handing the transport the same bytes it stores (no passthrough regression)", async () => {
    const { env, ctx: fctx, settle, sent } = makeFakeEnv();
    const { messageId } = await send(
      env,
      {
        to: "dev@example.com",
        subject: "both halves",
        text: "x",
        attachments: [{ filename: "one.txt", mimeType: "text/plain", content: b64("ONE") }],
      },
      fctx,
    );
    await settle();

    // The recipient half (what was always working).
    expect(decode(sent[0].attachments![0].content)).toBe("ONE");
    // The author half (what #470 fixes), read through the API.
    const res = await handleApi(
      read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`),
      env,
      ctx,
    );
    expect(await res.text()).toBe("ONE");
  });

  it("addresses multiple sent attachments by index, in send order", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    const { messageId } = await send(
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
      fctx,
    );
    await settle();

    const msg = await stored(env, messageId);
    expect((msg.attachments as { filename: string }[]).map((a) => a.filename)).toEqual([
      "one.txt",
      "two.bin",
    ]);
    expect((await summary(env, messageId))?.attachmentCount).toBe(2);

    const first = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`), env, ctx);
    const second = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/1`), env, ctx);
    expect(await first.text()).toBe("ONE");
    expect(second.headers.get("content-type")).toBe("application/octet-stream");
    expect(await second.text()).toBe("TWO");
  });

  it("stores attachments on a REPLY sent copy too (same dispatch seam)", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "orig@example.com",
        from: "alice@example.com",
        to: "agent@skyphusion.org",
        subject: "question",
        text: "any numbers?",
      },
      fctx,
    );
    await settle();

    const { messageId } = await reply(
      env,
      {
        messageId: "orig@example.com",
        text: "attached",
        attachments: [{ filename: "numbers.csv", mimeType: "text/csv", content: b64("1,2") }],
      },
      fctx,
    );
    await settle();

    const msg = await stored(env, messageId);
    expect(msg.attachments).toEqual([{ filename: "numbers.csv", mime: "text/csv", size: 3 }]);
    const res = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1,2");
  });

  // --- controls: the fix must not invent attachments where there are none ---

  it("CONTROL: an attachment-free send stores none, and the bytes route 404s", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    const { messageId } = await send(env, { to: "dev@example.com", subject: "plain", text: "x" }, fctx);
    await settle();

    const msg = await stored(env, messageId);
    expect(msg.attachments).toEqual([]);
    expect((await summary(env, messageId))?.attachmentCount).toBe(0);
    const res = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`), env, ctx);
    expect(res.status).toBe(404);
  });

  it("CONTROL: an empty attachments array is still none (not an empty stored part)", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    const { messageId } = await send(
      env,
      { to: "dev@example.com", subject: "plain", text: "x", attachments: [] },
      fctx,
    );
    await settle();

    expect((await stored(env, messageId)).attachments).toEqual([]);
    const res = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`), env, ctx);
    expect(res.status).toBe(404);
  });

  it("CONTROL: an out-of-range index on an attachment-bearing send 404s", async () => {
    const { env, ctx: fctx, settle } = makeFakeEnv();
    const { messageId } = await send(
      env,
      { to: "dev@example.com", subject: "one file", text: "x", attachments: [{ content: b64("ZZ") }] },
      fctx,
    );
    await settle();

    const ok = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/0`), env, ctx);
    expect(ok.status).toBe(200);
    const past = await handleApi(read(`/api/messages/${encodeURIComponent(messageId)}/attachments/1`), env, ctx);
    expect(past.status).toBe(404);
  });
});
