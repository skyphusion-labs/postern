import { describe, it, expect } from "vitest";
import * as store from "./src/store";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// POST /ingest: the out-of-Worker inbound driver (CONTRACT section 2, #22/#29).
// The relay POSTs a ParsedInbound (attachment content base64) here; it was
// documented since M3 but never implemented until #14.

const TT = "transport-secret";
const MIB = 1024 * 1024;

function ingestReq(body: unknown, opts: { token?: string; contentLength?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.contentLength !== undefined) headers["content-length"] = opts.contentLength;
  return new Request("https://postern.example/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const base = () => ({ from: "sender@example.com", to: "support@skyphusion.org" });

describe("POST /ingest auth (fail-closed transport gate)", () => {
  it("REFUSES when POSTERN_TRANSPORT_TOKEN is unbound, even with a bearer", async () => {
    const { env, ctx } = makeFakeEnv(); // no POSTERN_TRANSPORT_TOKEN in the fake env
    const res = await handleApi(ingestReq({ ...base(), messageId: "x@e.com" }, { token: "anything" }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("401s a wrong transport token", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const res = await handleApi(ingestReq({ ...base(), messageId: "x@e.com" }, { token: "nope" }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("405s a non-POST /ingest", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const req = new Request("https://postern.example/ingest", { method: "GET", headers: { authorization: `Bearer ${TT}` } });
    const res = await handleApi(req, env, ctx);
    expect(res.status).toBe(405);
  });
});

describe("POST /ingest happy path", () => {
  it("stores a row with wire_size, toHeader-derived to_addr, and deliveredTo=[envelope rcpt]", async () => {
    const { env, ctx, settle } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const res = await handleApi(
      ingestReq(
        {
          messageId: "ing1@example.com",
          from: "boss@example.com",
          to: "support@skyphusion.org",
          toHeader: "Support <support@skyphusion.org>, Ops <ops@skyphusion.org>",
          cc: "ops@skyphusion.org",
          replyTo: "Boss <boss-replies@example.com>",
          subject: "relay delivered",
          text: "hello from the relay",
          rawSize: 6042,
        },
        { token: TT },
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: string; stored: boolean; merged: boolean; threadId: string };
    expect(body).toMatchObject({ ok: true, messageId: "ing1@example.com", stored: true, merged: false });
    await settle();

    const msg = await store.get(env, "ing1@example.com");
    expect(msg?.to).toBe("Support <support@skyphusion.org>, Ops <ops@skyphusion.org>"); // raw To header fidelity
    expect(msg?.deliveredTo).toEqual(["support@skyphusion.org"]); // the envelope recipient
    expect(msg?.cc).toBe("ops@skyphusion.org");
    expect(msg?.replyTo).toBe("Boss <boss-replies@example.com>");
    expect(msg?.wireSize).toBe(6042);
    expect(msg?.direction).toBe("inbound");
  });

  it("decodes a base64 attachment to bytes in R2", async () => {
    const { env, ctx, r2, atts, settle } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const payload = "relay attachment bytes";
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    const res = await handleApi(
      ingestReq(
        { messageId: "att1@example.com", from: "a@example.com", to: "conrad@skyphusion.org", text: "see attached", attachments: [{ filename: "note.txt", mimeType: "text/plain", content: b64 }] },
        { token: TT },
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await settle();
    expect(r2).toHaveLength(1);
    expect(Buffer.from(r2[0].bytes).toString("utf8")).toBe(payload);
    expect(atts[0]).toMatchObject({ message_id: "att1@example.com", filename: "note.txt", mime: "text/plain", size: payload.length });
  });
});

describe("POST /ingest validation", () => {
  it("400 E_FIELD_MISSING when from or to is absent", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const noTo = await handleApi(ingestReq({ from: "a@example.com" }, { token: TT }), env, ctx);
    expect(noTo.status).toBe(400);
    expect((await noTo.json() as { error: string }).error).toBe("E_FIELD_MISSING");
    const noFrom = await handleApi(ingestReq({ to: "conrad@skyphusion.org" }, { token: TT }), env, ctx);
    expect(noFrom.status).toBe(400);
  });

  it("400 E_VALIDATION_ERROR on malformed base64 attachment content", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const res = await handleApi(
      ingestReq({ ...base(), messageId: "bad@e.com", attachments: [{ filename: "x.bin", content: "!!! not base64 !!!" }] }, { token: TT }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("E_VALIDATION_ERROR");
  });

  it("413 when the declared content-length is over the 30 MiB cap", async () => {
    const { env, ctx } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    const res = await handleApi(
      ingestReq({ ...base(), messageId: "big@e.com" }, { token: TT, contentLength: String(30 * MIB + 1) }),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toBe("E_PAYLOAD_TOO_LARGE");
  });
});

// #473: TRUSTED_SENDER_DOMAINS is read on the INGEST path, so a clean-install operator
// who omits it from their own wrangler config used to TypeError on EVERY inbound
// message. The throw surfaced as a TRANSIENT INFRA FAULT, not a config message: the
// in-Worker email() handler lets it escape (CF retries the delivery), and /ingest
// answers a fixed 500 that relay/client.go maps to SMTP 451, so the sending MTA queues
// and retries forever. Both are the right answers to an unexpected failure, which is
// why the fix belongs at the source. Absent must behave exactly like the shipped "":
// an empty allowlist, nothing trusted, message still stored.
describe("POST /ingest with TRUSTED_SENDER_DOMAINS absent (#473)", () => {
  /** A config that never declares the var at all, not one that sets it empty. */
  function envWithoutAllowlist() {
    const made = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT });
    delete (made.env as unknown as Record<string, unknown>).TRUSTED_SENDER_DOMAINS;
    return made;
  }

  const message = (messageId: string) => ({
    messageId,
    from: "boss@example.com",
    to: "support@skyphusion.org",
    subject: "clean install",
    text: "hello from an operator who pruned the var",
  });

  it("stores the message untrusted rather than failing the delivery", async () => {
    const { env, ctx, settle } = envWithoutAllowlist();
    // Control on the harness itself: the var must really be gone, or this proves nothing.
    expect("TRUSTED_SENDER_DOMAINS" in (env as unknown as Record<string, unknown>)).toBe(false);

    const res = await handleApi(ingestReq(message("no-allowlist@example.com"), { token: TT }), env, ctx);
    expect(res.status).toBe(200);
    await settle();

    const msg = await store.get(env, "no-allowlist@example.com");
    expect(msg?.messageId).toBe("no-allowlist@example.com");
    expect(msg?.trusted).toBe(false);
  });

  it("still trusts the SAME sender when the var IS set (positive control)", async () => {
    // Without this, a guard that broke the trust decision outright would pass the case
    // above: only the allowlist value differs between the two.
    const { env, ctx, settle } = makeFakeEnv({ POSTERN_TRANSPORT_TOKEN: TT, TRUSTED_SENDER_DOMAINS: "example.com" });
    const res = await handleApi(ingestReq(message("allowlisted@example.com"), { token: TT }), env, ctx);
    expect(res.status).toBe(200);
    await settle();

    const msg = await store.get(env, "allowlisted@example.com");
    expect(msg?.trusted).toBe(true);
  });
});
