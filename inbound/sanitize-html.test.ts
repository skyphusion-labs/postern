import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "./src/sanitize-html";

describe("sanitizeHtml (D-HTML-1 adversarial battery)", () => {
  it("strips <script> tags and their text content entirely", () => {
    expect(sanitizeHtml("<p>hi</p><script>alert(1)</script><p>bye</p>")).toBe("<p>hi</p><p>bye</p>");
  });

  it("strips an unclosed/self-closed script tag and everything it would swallow", () => {
    expect(sanitizeHtml('<script src="x.js"/><p>after</p>')).toBe("<p>after</p>");
  });

  it("strips <style> tags and their CSS content", () => {
    expect(sanitizeHtml("<style>body{background:url(javascript:alert(1))}</style><p>ok</p>")).toBe("<p>ok</p>");
  });

  it("strips event-handler attributes on an otherwise-allowed tag", () => {
    expect(sanitizeHtml('<p onclick="alert(1)" onmouseover="alert(2)">hi</p>')).toBe("<p>hi</p>");
  });

  it("strips javascript: URLs in href", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).toBe("<a>click</a>");
  });

  it("strips data: URLs in href", () => {
    expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>')).toBe("<a>click</a>");
  });

  it("strips vbscript: and other non-allowlisted schemes", () => {
    expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe("<a>x</a>");
  });

  it("strips a scheme obfuscated with an embedded tab/newline", () => {
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="java\nscript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("neutralizes a numeric-entity-obfuscated javascript: URL", () => {
    // &#106;avascript: decodes to "javascript:" before the scheme check runs.
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("keeps a safe http(s)/mailto href and forces safe link attributes", () => {
    const out = sanitizeHtml('<a href="https://example.com/x?y=1">link</a>');
    expect(out).toContain('href="https://example.com/x?y=1"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain("<a ");
    expect(out).toContain(">link</a>");

    expect(sanitizeHtml('<a href="mailto:a@example.com">mail</a>')).toContain('href="mailto:a@example.com"');
  });

  it("drops a relative/bare href (no scheme) rather than passing it through", () => {
    expect(sanitizeHtml('<a href="/local/path">x</a>')).toBe("<a>x</a>");
  });

  it("strips iframe/object/embed/form entirely, including their content", () => {
    expect(sanitizeHtml("<iframe src=x>trapped</iframe>ok")).toBe("ok");
    expect(sanitizeHtml('<object data="x"><param name=a value=b>trapped</object>ok')).toBe("ok");
    expect(sanitizeHtml("<embed src=x>ok")).toBe("ok");
    expect(sanitizeHtml('<form action="/x"><input name=a></form>ok')).toBe("ok");
  });

  it("strips svg/math (common event-handler smuggling vectors) with their content", () => {
    expect(sanitizeHtml('<svg onload="alert(1)"><script>alert(2)</script></svg>ok')).toBe("ok");
    expect(sanitizeHtml("<math><mtext>trapped</mtext></math>ok")).toBe("ok");
  });

  it("drops an unrecognized/dangerous tag but keeps its text (unwrap, not swallow)", () => {
    expect(sanitizeHtml("<marquee>hi</marquee>")).toBe("hi");
    expect(sanitizeHtml("<blink>hi</blink>")).toBe("hi");
    expect(sanitizeHtml("<img src=x onerror=alert(1)>")).toBe(""); // img is not allow-listed at all
  });

  it("drops style/class/id attributes on allowed tags (no CSS-based vector)", () => {
    expect(sanitizeHtml('<p style="background:url(javascript:alert(1))" class="x" id="y">hi</p>')).toBe("<p>hi</p>");
  });

  it("strips HTML comments (a common obfuscation vector) without leaking their content", () => {
    expect(sanitizeHtml("<!-- <script>alert(1)</script> -->visible")).toBe("visible");
  });

  it("strips CDATA sections", () => {
    expect(sanitizeHtml("<![CDATA[<script>alert(1)</script>]]>visible")).toBe("visible");
  });

  it("keeps a safe small allowlisted structure (bold/italic/list/link/paragraph)", () => {
    const input = "<p>Hello <b>bold</b> and <i>italic</i></p><ul><li>one</li><li>two</li></ul>";
    expect(sanitizeHtml(input)).toBe(input);
  });

  it("keeps blockquote/pre/code/table structure", () => {
    const input = "<blockquote><p>quoted</p></blockquote><pre><code>x = 1;</code></pre>" +
      "<table><tr><td>a</td><th>b</th></tr></table>";
    expect(sanitizeHtml(input)).toBe(input);
  });

  it("closes an unclosed tag at end of input rather than leaking an open tag", () => {
    expect(sanitizeHtml("<p><b>unterminated")).toBe("<p><b>unterminated</b></p>");
  });

  it("handles overlapping/malformed nesting without desyncing the stack", () => {
    // <b><i></b></i>: closing </b> also force-closes the still-open <i>.
    expect(sanitizeHtml("<b><i>x</b>y</i>")).toBe("<b><i>x</i></b>y");
  });

  it("never throws on garbage/adversarial input", () => {
    const inputs = [
      "<<<<<<<script>>>>>>",
      "<a href='unterminated",
      "<a href=\"" + "x".repeat(5000) + "\">y</a>",
      "\u0000\u0001<script>x</script>",
      "<a href=\"jav&#97;script&colon;alert(1)\">x</a>",
      "<style>" + "a{}".repeat(10000) + "</style>",
    ];
    for (const input of inputs) {
      expect(() => sanitizeHtml(input)).not.toThrow();
    }
  });

  it("is idempotent: sanitizing already-sanitized output is a no-op", () => {
    const input = '<p>Hello <b>bold</b></p><a href="https://example.com">x</a><script>alert(1)</script>';
    const once = sanitizeHtml(input);
    const twice = sanitizeHtml(once);
    expect(twice).toBe(once);
  });

  it("re-escapes text so a decoded angle bracket cannot re-form a live tag", () => {
    // Numeric-entity-encoded "<script>" as TEXT (not inside a tag) must survive
    // as literal escaped text, never become an executable tag in the output.
    const out = sanitizeHtml("plain &#60;script&#62;alert(1)&#60;/script&#62; text");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("strips a remote <link rel=stylesheet> and legacy background= attribute paths (covered by tag/attr allowlist)", () => {
    expect(sanitizeHtml('<link rel="stylesheet" href="https://evil.example/x.css">visible')).toBe("visible");
    expect(sanitizeHtml('<table background="https://evil.example/x.png"><tr><td>a</td></tr></table>')).toBe(
      "<table><tr><td>a</td></tr></table>",
    );
  });

  it("returns empty string for empty/undefined-ish input", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("strips case-varied tag and attribute names identically to lowercase", () => {
    expect(sanitizeHtml('<SCRIPT>alert(1)</SCRIPT><P ONCLICK="x">hi</P>')).toBe("<p>hi</p>");
  });
});
