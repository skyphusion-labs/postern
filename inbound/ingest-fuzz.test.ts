import { describe, it, expect } from "vitest";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// Corpus-driven hardening for the /ingest JSON parse path (#198). Goal: malformed
// or adversarial bodies never throw out of handleApi; they return 4xx/413.
const TT = "transport-secret";

function ingestReq(body: unknown, opts: { token?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  return new Request("https://postern.example/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const corpus: unknown[] = [
  null,
  "not-json",
  "{",
  [],
  42,
  "",
  {},
  { from: "only-from@example.com" },
  { to: "only-to@example.com" },
  { from: "bad", to: "dest@skyphusion.org" },
  { from: "sender@example.com", to: "dest@skyphusion.org", attachments: "not-an-array" },
  { from: "sender@example.com", to: "dest@skyphusion.org", attachments: [{}] },
  { from: "sender@example.com", to: "dest@skyphusion.org", attachments: [{ content: "!!!" }] },
  { from: "sender@example.com", to: "dest@skyphusion.org", attachments: [{ content: "YQ==", filename: "\u0000\uD800" }] },
  { from: "sender@example.com", to: "dest@skyphusion.org", text: "\u0000\uD800\xff" },
  { from: "sender@example.com", to: "dest@skyphusion.org", html: "<script>" + "x".repeat(5000) },
  { from: "sender@example.com", to: "dest@skyphusion.org", references: "not-an-array" },
  { from: "sender@example.com", to: "dest@skyphusion.org", auth: { spf: 123 } },
];

describe("POST /ingest fuzz corpus (#198)", () => {
  for (let i = 0; i < corpus.length; i++) {
    it(`corpus[${i}] returns a controlled HTTP status (no throw)`, async () => {
      const { env, ctx } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
      const res = await handleApi(ingestReq(corpus[i], { token: TT }), env, ctx);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(600);
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status >= 400) {
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
      } else {
        expect(body.ok).toBe(true);
      }
    });
  }

  it("a minimal valid body still stores", async () => {
    const { env, ctx, settle } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const res = await handleApi(
      ingestReq(
        {
          messageId: "fuzz-ok@example.com",
          from: "sender@example.com",
          to: "dest@skyphusion.org",
          subject: "fuzz ok",
          text: "hello",
        },
        { token: TT },
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await settle();
  });
});
