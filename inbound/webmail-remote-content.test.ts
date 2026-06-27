import { describe, it, expect } from "vitest";
import { WEBMAIL_HTML } from "./src/webmail";

// #60: HTML email bodies must not auto-load remote subresources (tracking pixels,
// remote CSS) on open; a per-message opt-in then loads them. The webmail page is a
// vanilla IIFE embedded as a string, so we (1) execute its real remote-detection
// helpers in isolation (the security-relevant logic that decides what counts as
// remote), and (2) assert the default-block + opt-in wiring is present in the page.

// Pull the contiguous block of pure helpers (isRemoteUrl, hasRemoteInSrcset,
// BLOCKED_IMG, stripRemoteCssUrls) out of the shipped page source and evaluate it.
// These use only String/RegExp, so they run safely under the node test env without
// a DOM. WEBMAIL_HTML is the runtime value, so its backslashes are already real.
function loadHelpers() {
  const start = WEBMAIL_HTML.indexOf("function isRemoteUrl");
  const end = WEBMAIL_HTML.indexOf("function neutralizeRemoteHtml");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const src = WEBMAIL_HTML.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    src + "\nreturn { isRemoteUrl, hasRemoteInSrcset, stripRemoteCssUrls, BLOCKED_IMG };"
  )() as {
    isRemoteUrl: (u: unknown) => boolean;
    hasRemoteInSrcset: (s: unknown) => boolean;
    stripRemoteCssUrls: (c: string) => { css: string; count: number };
    BLOCKED_IMG: string;
  };
}

describe("#60 remote-URL detection (the block decision)", () => {
  const h = loadHelpers();

  it("treats http/https/protocol-relative as remote", () => {
    expect(h.isRemoteUrl("http://tracker.example/p.gif")).toBe(true);
    expect(h.isRemoteUrl("https://tracker.example/p.gif?id=1")).toBe(true);
    expect(h.isRemoteUrl("//cdn.example/x.png")).toBe(true);
    expect(h.isRemoteUrl("HTTPS://UP.EXAMPLE")).toBe(true);
    expect(h.isRemoteUrl("  https://x ")).toBe(true); // leading/trailing ws
  });

  it("treats inline / relative / empty as NOT remote (no network)", () => {
    expect(h.isRemoteUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(h.isRemoteUrl("cid:part1@example")).toBe(false);
    expect(h.isRemoteUrl("/relative/x.png")).toBe(false);
    expect(h.isRemoteUrl("logo.png")).toBe(false);
    expect(h.isRemoteUrl("")).toBe(false);
    expect(h.isRemoteUrl(null)).toBe(false);
  });

  it("detects a remote candidate anywhere in a srcset", () => {
    expect(h.hasRemoteInSrcset("https://cdn/x.png 2x, /a.png 1x")).toBe(true);
    expect(h.hasRemoteInSrcset("/a.png 1x, /b.png 2x")).toBe(false);
    expect(h.hasRemoteInSrcset("data:image/png;base64,AA 1x")).toBe(false);
  });
});

describe("#60 remote CSS url() neutralization", () => {
  const h = loadHelpers();

  it("strips a remote url() and counts it, leaving no remote reference", () => {
    const r = h.stripRemoteCssUrls("background:url(https://tracker.example/p.gif)");
    expect(r.count).toBe(1);
    expect(r.css).not.toContain("https://");
    expect(r.css).toContain("url('')");
  });

  it("leaves a data: url() untouched (inline, fires no request)", () => {
    const css = "background:url(data:image/png;base64,AAAA)";
    const r = h.stripRemoteCssUrls(css);
    expect(r.count).toBe(0);
    expect(r.css).toBe(css);
  });

  it("handles quoted and protocol-relative url()s", () => {
    const r = h.stripRemoteCssUrls("a{background:url('http://x/y')}b{background:url(\"//z/w\")}");
    expect(r.count).toBe(2);
    expect(r.css).not.toContain("http://x");
    expect(r.css).not.toContain("//z/w");
  });
});

describe("#60 default-block + per-message opt-in wiring", () => {
  it("renders the body via renderBody (not raw bodyIframe)", () => {
    expect(WEBMAIL_HTML).toContain("function renderBody");
    expect(WEBMAIL_HTML).toContain("r.appendChild(renderBody(m))");
  });

  it("neutralizes remote content by DEFAULT", () => {
    expect(WEBMAIL_HTML).toContain("function neutralizeRemoteHtml");
    expect(WEBMAIL_HTML).toContain("neutralizeRemoteHtml(m.bodyHtml)");
  });

  it("offers a per-message opt-in that loads the RAW body", () => {
    expect(WEBMAIL_HTML).toContain("Load remote images");
    // opt-in path renders the original HTML (so remote content loads only on opt-in)
    expect(WEBMAIL_HTML).toContain('inner = String(m.bodyHtml)');
  });

  it("stashes the original src and uses an inline data: placeholder", () => {
    expect(WEBMAIL_HTML).toContain("data-blocked-src");
    expect(WEBMAIL_HTML).toContain("data:image/svg+xml");
  });

  it("keeps the sandbox=\"\" XSS boundary in every render path", () => {
    expect(WEBMAIL_HTML).toContain('f.setAttribute("sandbox", "")');
  });

  it("never assigns innerHTML (stored content cannot inject markup/script)", () => {
    expect(WEBMAIL_HTML).not.toMatch(/\.innerHTML\s*=/);
  });
});
