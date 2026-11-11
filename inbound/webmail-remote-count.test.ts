import { describe, it, expect } from "vitest";
import { WEBMAIL_HTML } from "./src/webmail";

// The remote-content counter reads CSS the way a CSS parser does: escapes are decoded in
// function names and arguments, @import takes a url() or a plain string, and image-set()
// takes strings. Each remote reference is counted once and neutralized; nothing else
// changes. The helpers are evaluated from the shipped page, as webmail-remote-content
// does.
function loadHelpers() {
  const start = WEBMAIL_HTML.indexOf("function isRemoteUrl");
  const end = WEBMAIL_HTML.indexOf("function neutralizeRemoteHtml");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // eslint-disable-next-line no-new-func
  return new Function(WEBMAIL_HTML.slice(start, end) + "\nreturn { stripRemoteCssUrls };")() as {
    stripRemoteCssUrls: (c: string) => { css: string; count: number };
  };
}
const { stripRemoteCssUrls: strip } = loadHelpers();
const REMOTE = /(?:https?:)?\/\/e\.example|\\68|\\0068/i;

describe("remote CSS references are counted and neutralized", () => {
  const cases: Array<[string, string, number]> = [
    ["a hex escape in the URL", "a{background:url(\\68ttps://e.example/x.png)}", 1],
    ["a padded hex escape with its space", "a{background:url(\\000068 ttps://e.example/x.png)}", 1],
    ["an escape in the function name", "a{background:u\\72l(https://e.example/x.png)}", 1],
    ["a character escape in the name", "a{background:\\url(https://e.example/x.png)}", 1],
    ["upper-case URL( with spaces and quotes", "a{background:URL(  'https://e.example/x.png'  )}", 1],
    ["an escaped quote inside a quoted URL", "a{background:url(\"https://e.example/x\\\".png\")}", 1],
    ["@import with a double-quoted string", "@import \"https://e.example/a.css\";\nb{color:red}", 1],
    ["@import with a single-quoted string and media", "@import 'https://e.example/a.css' screen;b{color:red}", 1],
    ["@import with url()", "@import url(https://e.example/a.css);b{color:red}", 1],
    ["an escaped @import", "@\\69mport \"https://e.example/a.css\";", 1],
    ["image-set strings", "a{background:image-set(\"https://e.example/1.png\" 1x, \"//e.example/2.png\" 2x)}", 2],
    ["-webkit-image-set mixing a string and url()", "a{background:-webkit-image-set(\"https://e.example/1.png\" 1x, url(https://e.example/2.png) 2x)}", 2],
    ["several declarations", "a{background:url(https://e.example/1)}b{border-image:url(//e.example/2) 30}c{cursor:url(\\68ttp://e.example/3),auto}", 3],
  ];
  for (const [name, css, count] of cases) {
    it(name, () => {
      const r = strip(css);
      expect(r.count).toBe(count);
      expect(r.css).not.toMatch(REMOTE);
    });
  }
});

describe("nothing that does not load is counted or changed", () => {
  const unchanged: Array<[string, string]> = [
    ["a data: URL", "a{background:url(data:image/png;base64,AAAA)}"],
    ["a cid: URL", "a{background:url(cid:part1@example)}"],
    ["a relative URL", "a{background:url(/img/x.png)}"],
    ["a string outside image-set", "a::before{content:\"https://e.example/\"}"],
    ["a URL inside a comment", "/* url(https://e.example/x) */ a{color:red}"],
    ["a function that is not url", "a{width:calc(100% - 2px);background:linear-gradient(red, blue)}"],
    ["an ident ending in url", "a{--myurl:1}"],
    ["@import of a relative string", "@import \"local.css\";"],
    ["plain CSS", "p{color:#171a21;margin:0 0 1em}"],
  ];
  for (const [name, css] of unchanged) {
    it(name, () => {
      const r = strip(css);
      expect(r.count).toBe(0);
      expect(r.css).toBe(css);
    });
  }
});

describe("the scan is linear", () => {
  const shapes: Record<string, string> = {
    "a long identifier": "a".repeat(200_000),
    "repeated escapes": "\\72".repeat(60_000),
    "unterminated url(": "url(".repeat(50_000),
    "unterminated strings": "\"".repeat(200_000),
    "repeated @import": "@import ".repeat(25_000),
    "an unterminated comment": "/*" + "a".repeat(200_000),
    "nested parentheses": "(".repeat(100_000) + ")".repeat(100_000),
    "image-set without close": "image-set(\"x\" ".repeat(15_000),
  };
  for (const [name, css] of Object.entries(shapes)) {
    it(`${name} (${Math.round(css.length / 1000)} KB) within 200 ms`, () => {
      strip(css.slice(0, 1000));
      const t = performance.now();
      strip(css);
      expect(performance.now() - t).toBeLessThan(200);
    });
  }
});
