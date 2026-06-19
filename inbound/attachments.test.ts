import { describe, it, expect } from "vitest";
import { ingest } from "./src/ingest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(path: string, token = "test-token"): Request {
  return new Request(`https://postern.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

describe("attachment bytes endpoint", () => {
  async function seedWithAttachments(env: Env, settle: () => Promise<unknown>) {
    await ingest(
      env,
      {
        messageId: "m1@example.com",
        from: "alice@example.com",
        to: "agent@example.com",
        subject: "report",
        text: "see attached",
        attachments: [
          { filename: "report.pdf", mimeType: "application/pdf", content: bytes("PDF-ONE") },
          { filename: "data.csv", mimeType: "text/csv", content: bytes("a,b,c") },
        ],
      },
      ctx,
    );
    await settle();
  }

  it("streams the i-th attachment with download headers", async () => {
    const { env, settle } = makeFakeEnv();
    await seedWithAttachments(env, settle);

    const res = await handleApi(req("/api/messages/m1@example.com/attachments/0"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("PDF-ONE");
  });

  it("addresses attachments by index in list order", async () => {
    const { env, settle } = makeFakeEnv();
    await seedWithAttachments(env, settle);

    const res = await handleApi(req("/api/messages/m1@example.com/attachments/1"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(await res.text()).toBe("a,b,c");
  });

  it("404s an out-of-range index", async () => {
    const { env, settle } = makeFakeEnv();
    await seedWithAttachments(env, settle);
    const res = await handleApi(req("/api/messages/m1@example.com/attachments/5"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("404s an unknown message", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(req("/api/messages/nope@example.com/attachments/0"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("requires the API token", async () => {
    const { env, settle } = makeFakeEnv();
    await seedWithAttachments(env, settle);
    const res = await handleApi(req("/api/messages/m1@example.com/attachments/0", ""), env, ctx);
    expect(res.status).toBe(401);
  });

  it("sanitizes the filename in Content-Disposition (no header injection)", async () => {
    const { env, settle } = makeFakeEnv();
    await ingest(
      env,
      {
        messageId: "m2@example.com",
        from: "alice@example.com",
        to: "agent@example.com",
        subject: "evil",
        text: "x",
        attachments: [
          { filename: 'a"\r\nSet-Cookie: x.bin', mimeType: "application/octet-stream", content: bytes("z") },
        ],
      },
      ctx,
    );
    await settle();
    const res = await handleApi(req("/api/messages/m2@example.com/attachments/0"), env, ctx);
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") || "";
    // The injection vectors (CR, LF, and a quote that would break out of the
    // filename="..." value) must be gone; the harmless text may remain.
    expect(cd).not.toContain("\r");
    expect(cd).not.toContain("\n");
    expect(cd).toBe('attachment; filename="a___Set-Cookie__x.bin"');
  });
});
