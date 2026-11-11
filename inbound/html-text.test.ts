import { describe, it, expect } from "vitest";
import { htmlToText, ingest } from "./src/ingest";
import * as store from "./src/store";
import { realEnv } from "./realdb";

// htmlToText converts HTML-only mail to the stored text body. These tests pin two
// things: its running time grows linearly with the input, and its output on ordinary
// mail HTML is the same as the previous regex implementation, kept below verbatim as
// the reference.

function referenceHtmlToText(html: string): string {
  let out = html;
  const blockTag = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let prev: string;
  do {
    prev = out;
    out = out.replace(blockTag, "");
  } while (out !== prev);
  out = out
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n");
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, "");
  } while (out !== prev);
  out = out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  return out.trim();
}

const SIZE = 160_000;
const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

// The running-time tests bound GROWTH, not wall time. A wall-clock budget fails on a
// loaded machine while the code is fine (#911). What these exist to catch is a
// quadratic regression, which is a property of the algorithm: t(4N) / t(N) is about 4
// for linear work and about 16 for quadratic, whatever the load. Samples of the two
// sizes alternate and the median of each is used, so a burst of load hits both sides.
// Measured 2026-11-11 at load average about 17 on a 6-core laptop: the linear converter
// gives 3.8 to 6.1 on these shapes, and the quadratic reference gives 14.3 to 18.9.
// 10 sits between the two with room on both sides.
const MAX_GROWTH = 10;
const CEILING_MS = 2000; // a backstop only: an absurd regression still fails outright
const MIN_SAMPLE_MS = 10;
type Convert = (html: string) => string;

// Mean time of one call, from repeating the call until MIN_SAMPLE_MS has passed, so a
// sample is never one sub-millisecond call.
function sampleMs(fn: Convert, input: string): number {
  let reps = 0;
  const t0 = performance.now();
  let t = t0;
  do { fn(input); reps++; t = performance.now(); } while (t - t0 < MIN_SAMPLE_MS);
  return (t - t0) / reps;
}
function growth(fn: Convert, build: (n: number) => string, n: number): { ratio: number; bigMs: number } {
  const small = build(n);
  const big = build(4 * n);
  fn(small.slice(0, 1000)); // warm the JIT
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 5; i++) { a.push(sampleMs(fn, small)); b.push(sampleMs(fn, big)); }
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[2];
  return { ratio: median(b) / median(a), bigMs: median(b) };
}

describe("htmlToText running time", () => {
  const shapes: Record<string, (n: number) => string> = {
    "open brackets": (n) => fill("<", n),
    "unclosed tags": (n) => fill("<a", n),
    "unclosed script tags": (n) => fill("<script>", n),
    "unclosed style tags": (n) => fill("<style ", n),
    "near-miss end tags": (n) => "<script>" + fill("</scriptx>", n),
    "line breaks with long padding": (n) => fill("<br" + " ".repeat(40), n),
    "ordinary markup": (n) => fill("<b>x</b>", n),
  };
  for (const [name, build] of Object.entries(shapes)) {
    it(`grows linearly on ${name} (40 KB to 160 KB)`, () => {
      const g = growth(htmlToText, build, SIZE / 4);
      expect(g.ratio, `t(4N)/t(N) = ${g.ratio.toFixed(2)}`).toBeLessThan(MAX_GROWTH);
      expect(g.bigMs).toBeLessThan(CEILING_MS);
    });
  }

  it("control: the measurement flags a quadratic converter", () => {
    // referenceHtmlToText is the previous, quadratic implementation (kept above for the
    // output tests). If this ratio did not exceed the bound, the bound would prove nothing.
    const g = growth(referenceHtmlToText, (n) => fill("<", n), 2000);
    expect(g.ratio, `reference t(4N)/t(N) = ${g.ratio.toFixed(2)}`).toBeGreaterThan(MAX_GROWTH);
  });

  it("converts at most the first 512,000 characters", () => {
    const tail = "<p>TAIL_MARKER</p>";
    const big = "a".repeat(512_000) + tail;
    expect(htmlToText(big)).not.toContain("TAIL_MARKER");
    expect(htmlToText("a".repeat(1000) + tail)).toContain("TAIL_MARKER");
  });

  it("stores an HTML-only message of that shape within the budget", async () => {
    const { env, ctx } = realEnv();
    const t = performance.now();
    const r = await ingest(env, { messageId: "html-only-large@example.net", from: "a@example.net", to: "alice@skyphusion.org", html: fill("<") }, ctx);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(await store.get(env, r.messageId, ["alice@skyphusion.org"])).not.toBeNull();
  });
});

// Ordinary mail HTML: newsletters, replies, receipts, and the cases the existing
// htmlToText tests pin. Each must convert exactly as the reference does.
const CORPUS: string[] = [
  "<html><head><style>p{color:red}</style><title>Hi</title></head><body><p>Hello</p><script>alert(1)</script></body></html>",
  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><STYLE type=\"text/css\">\n.a { x: 1 }\n</STYLE></head><body><table><tr><td>Order #12</td><td>&pound;5</td></tr></table></body></html>",
  "<div dir=\"ltr\">Thanks,<br>Sam<br/><br />-- <br>Sam Jones</div><div class=\"gmail_quote\">On Tue wrote:<blockquote>quoted &gt; text</blockquote></div>",
  "<p>Line one</p><p>Line two</P >\n<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#39; a&nbsp;b</p>",
  "a<script>evil()</script >b",
  "<Script type=\"module\">x()</SCRIPT><style media=\"x\">s</style \t>c",
  "<a href=\"https://example.com/?a=1&amp;b=2\">link</a> and <img src=\"cid:1\" alt=\"logo\">",
  "5 &amp;lt; 6",
  "<!-- comment --> visible <!-- another -->",
  "if a < b and c > d then <b>bold</b>",
  "<scripts>not a script tag</scripts> and <styles>nor this</styles>",
  "<script-x>kept text</script-x>",
  "<ul><li>one</li><li>two</li></ul><hr><h1>Title</h1>",
  "unicode é中\u{1F600} <i>İstanbul</i> <b>K</b>",
  "<br><br>   leading and trailing   <br>",
  "<>empty<> brackets <<b>>",
  "x<scr<script>ipt>alert(1)y",
  "<<style>>z",
  "<style>a</style><style>b</style>c<script>d</script>",
  "<p>unterminated <b",
  "",
];

describe("htmlToText output", () => {
  CORPUS.forEach((html, i) => {
    it(`matches the reference on corpus case ${i}`, () => {
      expect(htmlToText(html)).toBe(referenceHtmlToText(html));
    });
  });

  it("matches the reference on generated markup without script or style blocks", () => {
    // Deterministic generator (LCG), so a failure reproduces.
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const parts = ["<", ">", "a", " ", "/", "<br>", "<BR/>", "</p>", "</p >", "<b>", "</b>", "&lt;", "&gt;", "&amp;", "&amp;lt;", "&nbsp;", "\n", "é", "<!--", "-->", "\""];
    for (let n = 0; n < 3000; n++) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 24);
      for (let k = 0; k < len; k++) s += parts[Math.floor(rnd() * parts.length)];
      expect(htmlToText(s), JSON.stringify(s)).toBe(referenceHtmlToText(s));
    }
  });

  it("matches the reference on generated markup with well-formed script and style blocks", () => {
    let seed = 7654321;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const text = ["a", " ", "<b>", "</b>", "<br>", "</p>", "&amp;", "\n", "x > y"];
    const blocks = ["<script>s()</script>", "<style>.c{}</style>", "<SCRIPT src=\"x\"></script >", "<style\tmedia=\"m\">q</STYLE>"];
    for (let n = 0; n < 2000; n++) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 16);
      for (let k = 0; k < len; k++) s += rnd() < 0.25 ? blocks[Math.floor(rnd() * blocks.length)] : text[Math.floor(rnd() * text.length)];
      expect(htmlToText(s), JSON.stringify(s)).toBe(referenceHtmlToText(s));
    }
  });

  // A tag is "<", at least one character that is not ">", then ">". Checked by one
  // backward pass: a regex test of the same shape is slow on exactly these inputs.
  const hasTag = (s: string): boolean => {
    let nextGt = -1;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === ">") nextGt = i;
      else if (s[i] === "<" && nextGt > i + 1) return true;
    }
    return false;
  };

  it("the tag check finds a tag", () => {
    expect(hasTag("a<b>c")).toBe(true);
    expect(hasTag("a<<>")).toBe(true);
    expect(hasTag("a<>b")).toBe(false);
    expect(hasTag("a<b")).toBe(false);
    expect(hasTag("a>b<")).toBe(false);
  });

  it("leaves no tag in the output", () => {
    for (const html of [...CORPUS, fill("<a"), "<scr<script>ipt>x</script>ipt>y", "<sty<style>le>z</style>"]) {
      expect(hasTag(htmlToText(html.replace(/&[a-z#0-9]+;/gi, "")))).toBe(false);
    }
  });
});
