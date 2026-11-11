import { describe, it, expect, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import worker from "./src/index";
import { ingest, messageDate } from "./src/ingest";
import { handleApi } from "./src/api";
import * as store from "./src/store";
import { realEnv } from "./realdb";
import { makeFakeEnv } from "./fakes";

// A message's date comes from its Date header when that header parses, and from the
// time it was received otherwise. A Date header that does not parse never stops the
// message from being stored.

const enc = new TextEncoder();
function rawStream(s: string): ReadableStream<Uint8Array> {
  const bytes = enc.encode(s);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
function emailEvent(raw: string, to = "alice@skyphusion.org") {
  return {
    from: "sender@example.net",
    to,
    raw: rawStream(raw),
    rawSize: raw.length,
    headers: new Headers(),
    forward: async () => {},
    setReject: () => {},
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
}
const mime = (date: string, id: string) =>
  `From: sender@example.net\r\nTo: alice@skyphusion.org\r\nSubject: hi\r\nMessage-ID: <${id}>\r\n` +
  `Date: ${date}\r\nContent-Type: text/plain\r\n\r\nhello\r\n`;

const between = (iso: string | undefined, t0: number, t1: number) => {
  const t = Date.parse(iso ?? "");
  expect(t).toBeGreaterThanOrEqual(t0 - 1000);
  expect(t).toBeLessThanOrEqual(t1 + 1000);
};

describe("messageDate", () => {
  const received = new Date("2026-11-10T12:00:00.000Z");
  it("uses a Date header that parses", () => {
    expect(messageDate("Tue, 10 Nov 2026 10:00:00 +0000", received)).toBe("2026-11-10T10:00:00.000Z");
    expect(messageDate("2026-01-02T03:04:05Z", received)).toBe("2026-01-02T03:04:05.000Z");
  });
  it("uses the receive time when the header is missing, empty or does not parse", () => {
    for (const raw of [undefined, "", "   ", "someday soon", "Tue, 99 Foo 2026", "+275761-01-01T00:00:00Z"]) {
      expect(messageDate(raw, received), String(raw)).toBe("2026-11-10T12:00:00.000Z");
    }
  });
});

describe("a message whose Date header does not parse is stored", () => {
  it("control: email() stores a message with a valid Date under that date", async () => {
    const { env, ctx } = realEnv();
    await worker.email(emailEvent(mime("Tue, 10 Nov 2026 10:00:00 +0000", "date-ok@example.net")), env, ctx);
    expect((await store.getUnscoped(env, "date-ok@example.net"))?.date).toBe("2026-11-10T10:00:00.000Z");
  });

  it("email() stores it under the receive time", async () => {
    const { env, ctx } = realEnv();
    const t0 = Date.now();
    await worker.email(emailEvent(mime("someday soon", "date-bad@example.net")), env, ctx);
    const got = await store.getUnscoped(env, "date-bad@example.net");
    expect(got).not.toBeNull();
    between(got?.date, t0, Date.now());
  });

  it("ingest() stores it under the receive time", async () => {
    const { env, ctx } = realEnv();
    const t0 = Date.now();
    const r = await ingest(env, { messageId: "date-bad2@example.net", from: "a@example.net", to: "alice@skyphusion.org", date: "not a date", text: "x" }, ctx);
    between((await store.getUnscoped(env, r.messageId))?.date, t0, Date.now());
  });

  it("POST /ingest answers 200 and stores it", async () => {
    const TT = "transport-secret";
    const { env, ctx, settle } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const req = new Request("https://postern.example/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TT}` },
      body: JSON.stringify({ messageId: "date-bad3@example.net", from: "a@example.net", to: "support@skyphusion.org", date: "someday soon", text: "x" }),
    });
    const res = await handleApi(req, env, ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(await store.getUnscoped(env, "date-bad3@example.net")).not.toBeNull();
  });
});
