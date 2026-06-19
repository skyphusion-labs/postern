import { describe, it, expect } from "vitest";
// Imports follow the code: the transport-side helpers live in headers.ts (kept
// out of index.ts so this suite need not import the worker entrypoint); the
// storage-side pure helpers live in ingest.ts.
import { extractSpfResult, extractDkimResult, extractDmarcResult, toArrayBuffer } from "./src/headers";
import { isTrusted, cleanBody, htmlToText, chunkText, sha256hex } from "./src/ingest";

// These cover the pure ingestion helpers: auth-verdict parsing, the allowlist
// trust decision (the security-sensitive bit), body cleaning, chunking (the
// Vectorize cost bound), and the content<->ArrayBuffer conversion. The email()
// handler itself needs a live ForwardableEmailMessage + bindings, so it is
// verified end-to-end against wrangler dev / a real inbound message, not here.

describe("extractSpfResult", () => {
  it("reads the leading verdict from a Received-SPF header", () => {
    expect(extractSpfResult("pass (google.com: domain of x designates ...)")).toBe("pass");
    expect(extractSpfResult("Fail (sender not permitted)")).toBe("fail");
    expect(extractSpfResult("softfail")).toBe("softfail");
  });

  it("defaults to none for empty or unrecognized headers", () => {
    expect(extractSpfResult("")).toBe("none");
    expect(extractSpfResult("garbage value")).toBe("none");
  });
});

describe("extractDkimResult", () => {
  it("pulls the dkim= verdict out of Authentication-Results", () => {
    expect(extractDkimResult("spf=pass; dkim=pass header.d=skyphusion.org")).toBe("pass");
    expect(extractDkimResult("dkim=FAIL")).toBe("fail");
  });

  it("defaults to none when no dkim token is present", () => {
    expect(extractDkimResult("spf=pass")).toBe("none");
    expect(extractDkimResult("")).toBe("none");
  });
});

describe("extractDmarcResult", () => {
  it("pulls the dmarc= verdict out of Authentication-Results", () => {
    expect(extractDmarcResult("dmarc=pass action=none")).toBe("pass");
    expect(extractDmarcResult("dmarc=bestguesspass")).toBe("bestguesspass");
  });

  it("defaults to none when absent", () => {
    expect(extractDmarcResult("spf=pass; dkim=pass")).toBe("none");
  });
});

describe("isTrusted", () => {
  const allow = "skyphusion.org,rockenhaus.net,github.com";

  it("trusts an allowlisted domain that passes SPF", () => {
    expect(isTrusted("alerts@skyphusion.org", "pass", "none", allow)).toBe(true);
  });

  it("trusts an allowlisted domain that passes DKIM even if SPF did not", () => {
    expect(isTrusted("bot@github.com", "fail", "pass", allow)).toBe(true);
  });

  it("does NOT trust a sender off the allowlist regardless of auth", () => {
    expect(isTrusted("evil@example.com", "pass", "pass", allow)).toBe(false);
  });

  it("does NOT trust an allowlisted domain that fails both SPF and DKIM", () => {
    // spoof attempt: on the allowlist but auth actively failed (not stripped)
    expect(isTrusted("spoof@skyphusion.org", "fail", "fail", allow)).toBe(false);
    expect(isTrusted("spoof@skyphusion.org", "softfail", "fail", allow)).toBe(false);
  });

  it("trusts an allowlisted domain when CF stripped both auth headers (none/none)", () => {
    // CF Email Routing removes transport auth headers; allowlist alone suffices.
    expect(isTrusted("cron@skyphusion.org", "none", "none", allow)).toBe(true);
  });

  it("matches a full address allowlist entry, not just a bare domain", () => {
    expect(isTrusted("ci@skyphusion.org", "none", "none", "ci@skyphusion.org")).toBe(true);
  });

  it("is case-insensitive on the sender and the allowlist", () => {
    expect(isTrusted("Alerts@SkyPhusion.ORG", "pass", "none", "SKYPHUSION.ORG")).toBe(true);
  });

  it("does not treat a lookalike domain suffix as on-allowlist", () => {
    // notskyphusion.org must not match skyphusion.org
    expect(isTrusted("x@notskyphusion.org", "pass", "pass", "skyphusion.org")).toBe(false);
  });

  it("returns false for an empty allowlist", () => {
    expect(isTrusted("anyone@skyphusion.org", "pass", "pass", "")).toBe(false);
  });
});

describe("cleanBody", () => {
  it("strips an RFC-3676 signature block", () => {
    const raw = "Real content here.\n-- \nSent from my phone\nfooter";
    expect(cleanBody(raw)).toBe("Real content here.");
  });

  it("removes quoted-reply lines", () => {
    const raw = "My reply.\n> previous message\n>> nested quote\nStill mine.";
    expect(cleanBody(raw)).toBe("My reply.\nStill mine.");
  });

  it("removes quoted lines that have leading whitespace before the >", () => {
    const raw = "Reply.\n   > indented quote";
    expect(cleanBody(raw)).toBe("Reply.");
  });

  it("leaves a clean body untouched (modulo trim)", () => {
    expect(cleanBody("  just text  ")).toBe("just text");
  });
});

describe("htmlToText", () => {
  it("drops script and style content entirely", () => {
    const html = "<style>p{color:red}</style><p>Hello</p><script>alert(1)</script>";
    const out = htmlToText(html);
    expect(out).toContain("Hello");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("alert");
  });

  it("turns <br> and </p> into newlines", () => {
    expect(htmlToText("a<br>b</p>")).toBe("a\nb");
  });

  it("decodes the common named entities", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3 &quot;hi&quot;")).toBe('Tom & Jerry <3 "hi"');
  });

  it("strips a script block even with whitespace before the end tag", () => {
    // js/bad-tag-filter: "</script >" must still be removed.
    expect(htmlToText("a<script>evil()</script >b")).toBe("ab");
  });

  it("strips nested/obfuscated tags that defeat a single pass", () => {
    // js/incomplete-multi-character-sanitization: stripping the inner tag once
    // could re-form an outer tag; looping to a fixpoint leaves no live tag. We
    // assert the security property (no surviving <script/<style/< marker), not
    // an exact string on these pathological inputs.
    const a = htmlToText("x<scr<script>ipt>alert(1)y");
    expect(a.toLowerCase()).not.toContain("<script");
    expect(a).not.toContain("<");
    const b = htmlToText("<<style>>z");
    expect(b.toLowerCase()).not.toContain("<style");
    expect(b).not.toContain("<");
  });

  it("does not double-unescape entities revealed by decoding", () => {
    // js/double-escaping: "&amp;lt;" decodes to the literal "&lt;", not "<".
    expect(htmlToText("5 &amp;lt; 6")).toBe("5 &lt; 6");
  });
});

describe("chunkText", () => {
  it("returns a single chunk when the text fits", () => {
    expect(chunkText("short text", 1200, 150)).toEqual(["short text"]);
  });

  it("returns nothing for empty / whitespace-only input", () => {
    expect(chunkText("", 1200, 150)).toEqual([]);
    expect(chunkText("   ", 1200, 150)).toEqual([]);
  });

  it("splits long text into overlapping windows", () => {
    const text = "word ".repeat(1000).trim(); // ~5000 chars
    const chunks = chunkText(text, 1200, 150);
    expect(chunks.length).toBeGreaterThan(1);
    // every window is within (roughly) the chunk size
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200);
  });

  it("carries overlap between adjacent windows so nothing is lost on the seam", () => {
    const text = "abcdefghij ".repeat(300).trim();
    const chunks = chunkText(text, 1000, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // reconstructing with de-overlap should cover the whole input length
    const joined = chunks.join(" ");
    expect(joined.length).toBeGreaterThanOrEqual(text.length);
  });
});

describe("sha256hex", () => {
  it("produces a 64-char lowercase hex digest", async () => {
    const h = await sha256hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // known SHA-256 of "hello"
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("is the same length regardless of input size (the Vectorize-id bound)", async () => {
    const a = await sha256hex("x");
    const b = await sha256hex("y".repeat(10_000));
    expect(a.length).toBe(64);
    expect(b.length).toBe(64);
  });
});

describe("toArrayBuffer", () => {
  it("passes an ArrayBuffer through unchanged", () => {
    const buf = new ArrayBuffer(8);
    expect(toArrayBuffer(buf)).toBe(buf);
  });

  it("copies a Uint8Array into a fresh ArrayBuffer", () => {
    const view = new Uint8Array([1, 2, 3]);
    const out = toArrayBuffer(view);
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(out!)).toEqual(view);
  });

  it("encodes a string to UTF-8 bytes", () => {
    const out = toArrayBuffer("AB");
    expect(new Uint8Array(out!)).toEqual(new Uint8Array([65, 66]));
  });

  it("returns null for unsupported content types", () => {
    expect(toArrayBuffer(42)).toBeNull();
    expect(toArrayBuffer(null)).toBeNull();
    expect(toArrayBuffer({})).toBeNull();
  });
});
