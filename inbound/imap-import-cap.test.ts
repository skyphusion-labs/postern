// The DECODED-size cap on POST /api/imap/import (#493).
//
// rawMime used to be base64-decoded and handed straight to PostalMime, so the
// work the parser could be asked to do was bounded only by 4/3 of the JSON body
// cap -- an arithmetic accident rather than a stated rule. The cap is now read off
// the decoded bytes BEFORE parse, and it refuses with the same envelope the body
// cap answers with (413 E_PAYLOAD_TOO_LARGE), which the IMAP door turns into a
// tagged NO. A 5xx here would be wrong: it is reserved for transient infra and is
// load-bearing for relay retry semantics (#429/#442).
//
// These drive the REAL handleApi with real base64 at the real limit, so the
// boundary is proved against the shipped constant, not a stand-in.
import { describe, expect, it } from "vitest";
import { handleApi, MAX_IMPORT_MIME_BYTES } from "./src/api";
import { makeFakeEnv } from "./fakes";

const IDENTITY = "conrad@skyphusion.org";

function request(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`https://postern.example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A genuinely parseable message padded to EXACTLY `bytes` total, so if the guard
// ever failed to fire the message WOULD parse and store, and the row assertion
// below would catch it.
function mimeOfSize(bytes: number, messageId: string): string {
  const head = [
    "From: Conrad <conrad@skyphusion.org>",
    "To: Friend <friend@example.com>",
    "Subject: padded APPEND",
    `Message-ID: <${messageId}>`,
    "Date: Sat, 18 Jul 2026 00:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
  ].join("\r\n");
  if (head.length > bytes) throw new Error("requested size is below the header floor");
  return head + "p".repeat(bytes - head.length);
}

function importRequest(rawMime: string): Request {
  return request("POST", "/api/imap/import", "imap-token", {
    identity: IDENTITY,
    folder: "sent",
    rawMime: btoa(rawMime),
  });
}

function imapEnv() {
  return makeFakeEnv({ POSTERN_API_TOKEN: "both-token", POSTERN_API_TOKEN_IMAP: "imap-token" });
}

describe("imap import decoded-size cap (#493)", () => {
  it("refuses a decoded MIME body one byte over the cap, before it is parsed", async () => {
    const { env, ctx, rows } = imapEnv();
    const oversize = mimeOfSize(MAX_IMPORT_MIME_BYTES + 1, "oversize@example.com");

    const res = await handleApi(importRequest(oversize), env, ctx);

    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("E_PAYLOAD_TOO_LARGE");
    // Discriminates the IMPORT cap from the body cap, whose refusal carries the
    // same code with the message "request body too large". The request itself is
    // comfortably inside MAX_BODY_BYTES (30 MiB): base64 of 22 MiB is ~29.3 MiB.
    expect(body.message).toContain("import limit");
    // The refusal is a REFUSAL, never a retryable 5xx (relay semantics, #429/#442).
    expect(res.status).toBeLessThan(500);
    // Never parsed, never stored.
    expect(rows.find((r) => r.message_id === "oversize@example.com")).toBeUndefined();
  }, 120_000);

  it("accepts a decoded MIME body of exactly the cap (crossing means MORE than the cap)", async () => {
    const { env, ctx, rows } = imapEnv();
    const atLimit = mimeOfSize(MAX_IMPORT_MIME_BYTES, "at-limit@example.com");

    const res = await handleApi(importRequest(atLimit), env, ctx);

    expect(res.status).toBe(201);
    expect(rows.find((r) => r.message_id === "at-limit@example.com")).toMatchObject({
      direction: "outbound",
      mailbox: null,
    });
  }, 120_000);

  it("leaves an ordinary APPEND untouched", async () => {
    const { env, ctx, rows } = imapEnv();
    const small = mimeOfSize(2048, "ordinary@example.com");

    const res = await handleApi(importRequest(small), env, ctx);

    expect(res.status).toBe(201);
    expect(rows.find((r) => r.message_id === "ordinary@example.com")).toBeTruthy();
  });
});
