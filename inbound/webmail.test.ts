import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEBMAIL_HTML, serveWebmail } from "./src/webmail";
import { handleApi } from "./src/api";
import { makeFakeEnv } from "./fakes";

// The worker embeds the page (it cannot read a file at request time), but the
// canonical editable source is webmail/index.html at the repo root. Regenerate
// the embed with `npm run sync-webmail`; this guard fails if the two drift.
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
    // frame-src 'self' permits the sandboxed srcdoc iframe the body view uses.
    expect(csp).toContain("frame-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("the page is XSS-conscious by construction", () => {
  it("defaults search to hybrid mode (parity with MCP)", () => {
    expect(WEBMAIL_HTML).toContain('mode: mode');
    expect(WEBMAIL_HTML).toContain('id="searchMode"');
    expect(WEBMAIL_HTML).toContain("postern_search_mode");
  });
  it("never assigns innerHTML (all message content goes through text nodes)", () => {
    // A blunt but effective guard: the page script must not use innerHTML, which
    // is the one sink that would let stored message bytes execute. If a future
    // edit introduces it, this test forces a deliberate review.
    expect(WEBMAIL_HTML).not.toMatch(/\.innerHTML\s*=/);
  });
  it("requests the token as a Bearer header, never places it in a URL", () => {
    expect(WEBMAIL_HTML).toContain('"authorization": "Bearer "');
  });
  it("renders the message body in a sandbox=\"\" iframe (no scripts, no same-origin)", () => {
    // The body iframe must be sandboxed with an EMPTY sandbox (no allow-scripts,
    // no allow-same-origin), so stored body content cannot execute or reach the
    // token/API even though it is rendered as HTML via srcdoc.
    expect(WEBMAIL_HTML).toContain('f.setAttribute("sandbox", "")');
    expect(WEBMAIL_HTML).not.toContain("allow-scripts");
    expect(WEBMAIL_HTML).not.toContain("allow-same-origin");
  });
  it("renders bodyHtml when present, into the sandboxed iframe via srcdoc", () => {
    // The body iframe prefers the stored HTML body; it is placed into srcdoc
    // (sandboxed), never via innerHTML, so it cannot execute or reach the API.
    expect(WEBMAIL_HTML).toContain("m.bodyHtml");
    expect(WEBMAIL_HTML).toContain('f.setAttribute("srcdoc"');
  });
  it("downloads attachments via a Bearer fetch, not a tokenized URL", () => {
    // The attachment download fetches with the Authorization header and builds an
    // object URL; the token must never be placed into the attachment URL.
    expect(WEBMAIL_HTML).toContain("function downloadAttachment");
    expect(WEBMAIL_HTML).toContain("URL.createObjectURL");
    expect(WEBMAIL_HTML).not.toMatch(/attachments\/[^"'`]*\+\s*state\.token/);
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
