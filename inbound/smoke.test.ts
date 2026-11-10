import { describe, it, expect } from "vitest";
// Imports follow the code: the transport-side helpers live in headers.ts (kept
// out of index.ts so this suite need not import the worker entrypoint); the
// storage-side pure helpers live in ingest.ts.
import { extractSpfResult, extractDkimResult, extractDmarcResult, toArrayBuffer, parseAuthResults, firstHeaderInstance, authResultsText } from "./src/headers";
import { isTrusted, domainsAlign, bareAddress, cleanBody, htmlToText, chunkText, sha256hex } from "./src/ingest";

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
  const allow = "skyphusion.org,example.net,github.com";
  const none = { spf: "none", dkim: "none", dmarc: "none" };

  it("does NOT trust an aligned SPF pass alone (SPF is not a trust leg)", () => {
    expect(isTrusted("alerts@skyphusion.org", { ...none, spf: "pass", spfDomain: "skyphusion.org" } as typeof none, allow)).toBe(false);
  });

  it("trusts an aligned DKIM pass even if SPF did not pass", () => {
    expect(isTrusted("bot@github.com", { ...none, spf: "fail", dkim: "pass", dkimDomains: ["github.com"] }, allow)).toBe(true);
  });

  it("trusts DMARC pass for the From domain", () => {
    expect(isTrusted("bot@github.com", { ...none, dmarc: "pass", dmarcFrom: "github.com" }, allow)).toBe(true);
  });

  it("does NOT trust a sender off the allowlist regardless of auth", () => {
    expect(isTrusted("evil@example.com", { spf: "pass", dkim: "pass", dkimDomains: ["example.com"], dmarc: "pass", dmarcFrom: "example.com" }, allow)).toBe(false);
  });

  it("does NOT trust an allowlisted domain that fails both SPF and DKIM", () => {
    expect(isTrusted("spoof@skyphusion.org", { ...none, spf: "fail", dkim: "fail" }, allow)).toBe(false);
    expect(isTrusted("spoof@skyphusion.org", { ...none, spf: "softfail", dkim: "fail" }, allow)).toBe(false);
  });

  it("does NOT trust an allowlisted From with no auth data (none/none)", () => {
    expect(isTrusted("cron@skyphusion.org", none, allow)).toBe(false);
  });

  it("does NOT trust a pass for a domain that does not align with the From", () => {
    expect(isTrusted("ceo@skyphusion.org", { ...none, dkim: "pass", dkimDomains: ["attacker.example"] }, allow)).toBe(false);
    expect(isTrusted("ceo@skyphusion.org", { ...none, dmarc: "pass", dmarcFrom: "attacker.example" }, allow)).toBe(false);
    // A lookalike suffix is not a subdomain.
    expect(isTrusted("ceo@skyphusion.org", { ...none, dkim: "pass", dkimDomains: ["notskyphusion.org"] }, allow)).toBe(false);
  });

  it("matches a full address allowlist entry, not just a bare domain", () => {
    expect(isTrusted("ci@skyphusion.org", { ...none, dkim: "pass", dkimDomains: ["skyphusion.org"] }, "ci@skyphusion.org")).toBe(true);
    expect(isTrusted("other@skyphusion.org", { ...none, dkim: "pass", dkimDomains: ["skyphusion.org"] }, "ci@skyphusion.org")).toBe(false);
  });

  it("is case-insensitive on the sender, the allowlist and the auth domains", () => {
    expect(isTrusted("Alerts@SkyPhusion.ORG", { ...none, dkim: "pass", dkimDomains: ["SKYPHUSION.org"] }, "SKYPHUSION.ORG")).toBe(true);
    expect(isTrusted("Alerts@SkyPhusion.ORG", { ...none, dmarc: "pass", dmarcFrom: "SKYPHUSION.org" }, "SKYPHUSION.ORG")).toBe(true);
  });

  it("does not treat a lookalike domain suffix as on-allowlist", () => {
    expect(isTrusted("x@notskyphusion.org", { ...none, dkim: "pass", dkimDomains: ["notskyphusion.org"] }, "skyphusion.org")).toBe(false);
  });

  it("returns false for an empty allowlist", () => {
    expect(isTrusted("anyone@skyphusion.org", { ...none, dmarc: "pass", dmarcFrom: "skyphusion.org" }, "")).toBe(false);
  });

  it("parses the bare address from a display-name From before matching", () => {
    const ok = { ...none, dkim: "pass", dkimDomains: ["skyphusion.org"] };
    expect(isTrusted('"Cloudflare" <alerts@skyphusion.org>', ok, allow)).toBe(true);
    expect(isTrusted('"Doe, Jane @ HQ" <alerts@skyphusion.org>', ok, allow)).toBe(true);
    expect(isTrusted('"Skyphusion Support" <x@evil.example>', { ...none, dkim: "pass", dkimDomains: ["evil.example"] }, allow)).toBe(false);
  });

  it("refuses a From that holds more than one address", () => {
    const ok = { ...none, dkim: "pass", dkimDomains: ["skyphusion.org"] };
    expect(isTrusted("x@evil.example, CEO <ceo@skyphusion.org>", ok, allow)).toBe(false);
    expect(isTrusted("Evil <x@evil.example>, <ceo@skyphusion.org>", ok, allow)).toBe(false);
  });

  it("returns false when TRUSTED_SENDER_DOMAINS is absent, instead of throwing (#473)", () => {
    expect(isTrusted("anyone@skyphusion.org", { ...none, dmarc: "pass", dmarcFrom: "skyphusion.org" }, undefined)).toBe(false);
    expect(isTrusted("cron@skyphusion.org", none, undefined)).toBe(false);
  });
});

describe("domainsAlign", () => {
  it("aligns equal domains and either-direction subdomains, not siblings or lookalikes", () => {
    expect(domainsAlign("skyphusion.org", "skyphusion.org")).toBe(true);
    expect(domainsAlign("cloudflare.com", "notify.cloudflare.com")).toBe(true);
    expect(domainsAlign("bounce.notify.cloudflare.com", "notify.cloudflare.com")).toBe(true);
    expect(domainsAlign("a.example.com", "b.example.com")).toBe(false);
    expect(domainsAlign("notskyphusion.org", "skyphusion.org")).toBe(false);
    expect(domainsAlign(undefined, "skyphusion.org")).toBe(false);
    expect(domainsAlign("", "skyphusion.org")).toBe(false);
  });
});

describe("parseAuthResults / firstHeaderInstance", () => {
  it("reads the dkim run and dmarc, strips comments, collects passing DKIM domains", () => {
    const r = parseAuthResults(
      "mx.cloudflare.net; dkim=pass header.d=esp.example header.s=a; dkim=pass header.d=Skyphusion.org header.s=b; " +
      "dkim=fail header.d=x.example; dmarc=pass (p=none; sp=none) header.from=skyphusion.org; " +
      "spf=pass (whatever) smtp.mailfrom=b@bounce.skyphusion.org",
    );
    expect(r).toEqual({ spf: "none", dkim: "pass", dkimDomains: ["esp.example", "skyphusion.org"], dmarc: "pass", dmarcFrom: "skyphusion.org" });
  });
  it("reads nothing at or after the first raw spf= (SPF is never parsed)", () => {
    expect(parseAuthResults("mx; dkim=none; spf=pass smtp.mailfrom=a@b.example; dkim=pass header.d=late.example; dmarc=pass header.from=late.example"))
      .toEqual({ spf: "none", dkim: "none", dmarc: "none" });
    // A planted spf= earlier (inside a selector) only truncates evidence.
    expect(parseAuthResults("mx; dkim=pass header.d=x.example header.s=spf=1; dmarc=pass header.from=x.example").dmarc).toBe("none");
  });
  it("voids the whole instance on an unterminated or unbalanced quote or comment", () => {
    for (const bad of [
      'mx; dkim=pass header.d=ours.example header.s="open; dmarc=pass header.from=ours.example',
      "mx; dkim=pass header.d=ours.example header.s=a( ; dmarc=pass header.from=ours.example",
      "mx; dkim=pass header.d=ours.example header.s=a) ; dmarc=pass header.from=ours.example",
    ]) {
      expect(parseAuthResults(bad)).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
    }
  });
  it("treats a quoted-string inside a comment as atomic", () => {
    expect(authResultsText('a; (c ")" d) x')).toBe("a;   x");
    expect(authResultsText('a; x="q;\\"r" ; (c;(n)) d')).toBe('a; x="" ;   d');
    expect(authResultsText('a; (open "q)')).toBeNull();
    expect(authResultsText("a; (open")).toBeNull();
    expect(authResultsText("a; stray)")).toBeNull();
    expect(authResultsText('a; "open')).toBeNull();
    // Drop-the-rest would leave a well-formed, aligned prefix here; it must void instead.
    expect(parseAuthResults('mx; dkim=pass header.d=ours.example; dmarc=pass header.from=ours.example; "open'))
      .toEqual({ spf: "none", dkim: "none", dmarc: "none" });
  });
  it("voids the whole instance when an entry breaks the strict grammar", () => {
    const ok = "mx; dkim=pass header.d=ours.example header.s=s1 header.b=AbC=; dmarc=pass header.from=ours.example policy.dmarc=reject";
    expect(parseAuthResults(ok)).toEqual({ spf: "none", dkim: "pass", dkimDomains: ["ours.example"], dmarc: "pass", dmarcFrom: "ours.example" });
    const NONE = { spf: "none", dkim: "none", dmarc: "none" };
    for (const bad of [
      "mx; dkim=pass header.d=attacker.example header.s=q header.d=ours.example; dmarc=pass header.from=ours.example", // duplicate key
      "mx; dkim=pass header.d=ours.example header.x=1; dmarc=pass header.from=ours.example",                          // unknown key
      "mx; dkim=pass header.d=ours.example junk; dmarc=pass header.from=ours.example",                                 // bare token
      "mx; dkim=pass header.d=ours.example header.s=; dmarc=pass header.from=ours.example",                            // empty value
      "mx; dkim=pass header.d = ours.example; dmarc=pass header.from=ours.example",                                    // spaced =
      "mx; dkim=great header.d=ours.example; dmarc=pass header.from=ours.example",                                     // unknown result
      "mx; dkim=pass header.d=ours.example; bimi=pass header.d=ours.example; dmarc=pass header.from=ours.example",      // unknown method
      "mx; dkim=pass header.d=ours.example; dmarc=pass header.from=ours.example header.from=ours.example",             // duplicate in dmarc
      "mx; dkim=pass header.d=ours.example; dmarc=pass header.d=ours.example",                                         // key of another method
    ]) {
      expect(parseAuthResults(bad)).toEqual(NONE);
    }
  });
  it("returns none for an empty instance", () => {
    expect(parseAuthResults("")).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
  });
  it("keeps only the first instance of a joined header", () => {
    expect(firstHeaderInstance("mx.cloudflare.net; dkim=none, evil; dkim=pass header.d=skyphusion.org")).toBe("mx.cloudflare.net; dkim=none");
    expect(firstHeaderInstance(null)).toBe("");
  });
});

describe("bareAddress", () => {
  it("extracts the angle address from a display-name From", () => {
    expect(bareAddress('"Cloudflare" <noreply@notify.cloudflare.com>')).toBe("noreply@notify.cloudflare.com");
  });
  it("passes a bare address through (lower-cased)", () => {
    expect(bareAddress("Alice@Example.COM")).toBe("alice@example.com");
  });
  it("keeps a comma-bearing display name from splitting the address", () => {
    expect(bareAddress('"Doe, Jane" <jane@example.com>')).toBe("jane@example.com");
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

  it("preserves MCP JSON-RPC log markers", () => {
    const raw = [
      "Report for RunPod:",
      '>>> {"jsonrpc":"2.0","method":"tools/call"}',
      '<<< {"jsonrpc":"2.0","result":{}}',
      "> old ticket quote",
    ].join("\n");
    expect(cleanBody(raw)).toBe(
      [
        "Report for RunPod:",
        '>>> {"jsonrpc":"2.0","method":"tools/call"}',
        '<<< {"jsonrpc":"2.0","result":{}}',
      ].join("\n"),
    );
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
