import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEBMAIL_HTML, serveWebmail } from "./src/webmail";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// The worker embeds the page (it cannot read a file at request time), but the
// canonical editable source is webmail/index.html at the repo root. This guard
// fails if the two drift, so an edit to the HTML must be reflected in the
// embedded copy (and vice versa).
describe("webmail embed stays in sync with the source file", () => {
  it("WEBMAIL_HTML equals webmail/index.html byte for byte", () => {
    const file = readFileSync(resolve(__dirname, "../webmail/index.html"), "utf8");
    expect(WEBMAIL_HTML).toBe(file);
  });
});

describe("serveWebmail", () => {
  it("returns the HTML page with a locked-down CSP and nosniff", () => {
    const res = serveWebmail();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") || "";
    // connect-src 'self' is the anti-exfiltration control: a hijacked page
    // cannot ship the pasted token to another host.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("the page is XSS-conscious by construction", () => {
  it("never assigns innerHTML (all message content goes through text nodes)", () => {
    // A blunt but effective guard: the page script must not use innerHTML, which
    // is the one sink that would let stored message bytes execute. If a future
    // edit introduces it, this test forces a deliberate review.
    expect(WEBMAIL_HTML).not.toMatch(/\.innerHTML\s*=/);
  });
  it("requests the token as a Bearer header, never places it in a URL", () => {
    expect(WEBMAIL_HTML).toContain('"authorization": "Bearer "');
  });
});

describe("the inbound worker serves the webmail route", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  it("GET /webmail returns the HTML page without requiring a token", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/webmail"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Postern webmail");
  });

  it("GET /webmail/ (trailing slash) also serves the page", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/webmail/"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("does not change the health route", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/"), env, ctx);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body).toEqual({ ok: true, service: "postern" });
  });

  it("still gates /api behind the token", async () => {
    const { env } = makeFakeEnv();
    const res = await handleApi(new Request("https://postern.example/api/messages"), env, ctx);
    expect(res.status).toBe(401);
  });
});
