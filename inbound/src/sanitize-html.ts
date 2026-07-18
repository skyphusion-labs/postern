// D-HTML-1 (docs/design/webmail-v2-contracts.md section 5): hand-rolled,
// zero-dependency server-side allowlist sanitizer for caller-authored HTML
// compose bodies. Authoritative at SEND: the browser's contenteditable output
// is UNTRUSTED until this has run, so mailbox.ts calls it on every outbound
// HTML body (send + reply + forward) before dispatch AND before persisting
// the sent copy's body_html. A browser-side sanitizer is UX only and is never
// trusted (the contract's central rule); this is the one place that decides.
//
// There is no DOMParser in the Workers runtime, so this is a small hand-rolled
// tokenizer: walk the HTML linearly with a well-formedness stack, and
// re-serialize ONLY allow-listed tags/attributes. A disallowed tag is unwrapped
// (dropped, but its text kept) UNLESS it is in DROP_CONTENT_TAGS (script/style/
// iframe/...), whose entire subtree -- markup AND text -- is discarded. That
// split matters: an unwrap must not leak a <script>'s payload text into the
// output as if it were prose.
//
// Never throws: malformed/adversarial input degrades to escaped text rather
// than a 500 (compose bodies are fully attacker-controlled). Idempotent:
// sanitizing already-sanitized output is a no-op, so re-sanitizing a resend or
// a draft round-trip is safe.

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike",
  "p", "br", "div", "span",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "hr",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
]);

// Entire subtree (markup + text) discarded, never merely unwrapped -- this is
// where an attacker would smuggle a payload as "just text" once the tag itself
// is stripped. Covers script/style execution, embeds, and form/UI spoofing.
const DROP_CONTENT_TAGS = new Set([
  "script", "style", "head", "title", "iframe", "object", "embed", "applet",
  "form", "button", "input", "textarea", "select", "option", "svg", "math",
  "noscript", "template", "link", "meta", "base", "frame", "frameset",
]);

// Void elements: no matching close tag expected; emitted without one.
const VOID_TAGS = new Set(["br", "hr"]);

// HTML5 void elements that can appear among DROP_CONTENT_TAGS (link, meta,
// base, embed, input, ...): real HTML never closes these with a matching end
// tag, so if we pushed them onto the drop-subtree stack on every open (the
// naive rule) an un-slashed `<link href=...>` with no `</link>` in the wild
// would swallow the REST OF THE DOCUMENT waiting for a close tag that will
// never arrive. Treat these as always self-terminating, regardless of whether
// the author wrote a trailing `/>`.
const VOID_LIKE = new Set([
  "link", "meta", "base", "embed", "input", "source", "track", "param",
  "area", "col", "wbr", "img", "br", "hr", "frame",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

// Deliberately empty: no style="" / class="" (CSS is a live XSS/tracking
// vector -- url(), @import, expression()), no id= (anchor/DOM hijacking). No
// compose affordance needs any of them.
const GLOBAL_ATTRS: Set<string> = new Set();

const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isSafeUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  // Control chars (incl. tab/newline) are a classic scheme-obfuscation vector
  // ("java\tscript:") and are rejected outright, belt-and-braces with the
  // scheme regex below (which already fails to match across one).
  if (/[\u0000-\u001f]/.test(value)) return false;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!m) return false; // no scheme (incl. a relative/fragment link): unsafe by default
  return SAFE_URL_SCHEMES.has(m[1].toLowerCase() + ":");
}

// Single-pass decode, named + numeric, mirroring ingest.ts htmlToText's order
// (named entities first, &amp; LAST) so a literal "&amp;lt;" decodes to the
// single-decode-correct "&lt;", not "<". Numeric refs (&#60; / &#x3c;) are
// decoded too: leaving them raw would let a browser re-decode them into a live
// "<" the NEXT time this same string is rendered as HTML, a numeric-entity
// sanitizer bypass. Decoding here is safe because every decoded text node is
// immediately re-escaped by encodeText before being written back out.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function encodeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function encodeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Parse a tag's raw attribute string into name -> decoded value. Linear scan
// (no nested/overlapping quantifiers), tolerant of malformed input: an
// unmatched quote or a bare name just yields an empty/short attribute list
// rather than throwing.
function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    let value = m[2] ?? "";
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (!out.has(name)) out.set(name, decodeEntities(value));
  }
  return out;
}

interface Token {
  type: "open" | "close" | "text";
  name?: string;
  attrs?: Map<string, string>;
  selfClosing?: boolean;
  text?: string;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
    if (i > textStart) tokens.push({ type: "text", text: html.slice(textStart, i) });
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      textStart = i;
      continue;
    }
    if (html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      i = end < 0 ? html.length : end + 3;
      textStart = i;
      continue;
    }

    // Find the closing > without treating one inside a quoted attribute value as
    // the end of the tag. This also makes a hostile href containing literal
    // "<script>...</script>" one attribute value, never executable markup.
    let quote = "";
    let end = i + 1;
    for (; end < html.length; end++) {
      const ch = html[end];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
    }
    if (end >= html.length) {
      tokens.push({ type: "text", text: html.slice(i) });
      return tokens;
    }
    const inside = html.slice(i + 1, end);
    const close = /^\s*\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*$/.exec(inside);
    const open = /^\s*([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(inside);
    if (close) {
      tokens.push({ type: "close", name: close[1].toLowerCase() });
    } else if (open) {
      const tail = open[2] || "";
      const selfClosing = /\/\s*$/.test(tail);
      tokens.push({
        type: "open",
        name: open[1].toLowerCase(),
        attrs: parseAttrs(selfClosing ? tail.replace(/\/\s*$/, "") : tail),
        selfClosing,
      });
    } else {
      tokens.push({ type: "text", text: html.slice(i, end + 1) });
    }
    i = end + 1;
    textStart = i;
  }
  if (textStart < html.length) tokens.push({ type: "text", text: html.slice(textStart) });
  return tokens;
}

function sanitizeAttrs(tag: string, attrs: Map<string, string>): string[] {
  const allowed = ALLOWED_ATTRS[tag];
  const out: string[] = [];
  for (const [name, rawValue] of attrs) {
    if (name.startsWith("on")) continue; // event handlers: always dropped, any tag
    const permitted = (allowed && allowed.has(name)) || GLOBAL_ATTRS.has(name);
    if (!permitted) continue;
    if (name === "href") {
      if (!isSafeUrl(rawValue)) continue;
      // Force safe link semantics regardless of any caller-supplied rel/target
      // (both are otherwise unwrapped anyway, since neither is in ALLOWED_ATTRS).
      out.push(`href="${encodeAttr(rawValue)}" rel="noopener noreferrer nofollow" target="_blank"`);
      continue;
    }
    out.push(`${name}="${encodeAttr(rawValue)}"`);
  }
  return out;
}

/**
 * D-HTML-1: sanitize a caller-authored HTML body down to a small safe
 * allowlist before it is ever dispatched or persisted. Strips scripts, styles,
 * event handlers, `javascript:`/`data:`/obfuscated-scheme references, and any
 * tag/attribute outside the allowlist. See module header for the design.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  const tokens = tokenize(html);
  const out: string[] = [];
  const dropStack: string[] = [];
  const openStack: string[] = [];

  for (const t of tokens) {
    if (dropStack.length > 0) {
      if (t.type === "open" && t.name && DROP_CONTENT_TAGS.has(t.name) && !t.selfClosing && !VOID_LIKE.has(t.name)) {
        dropStack.push(t.name);
      } else if (t.type === "close" && t.name === dropStack[dropStack.length - 1]) {
        dropStack.pop();
      }
      continue;
    }
    if (t.type === "text") {
      out.push(encodeText(decodeEntities(t.text ?? "")));
      continue;
    }
    if (t.type === "open" && t.name) {
      if (DROP_CONTENT_TAGS.has(t.name)) {
        if (!t.selfClosing && !VOID_LIKE.has(t.name)) dropStack.push(t.name);
        continue;
      }
      if (!ALLOWED_TAGS.has(t.name)) continue; // unwrap: drop the tag, keep surrounding text
      const attrs = sanitizeAttrs(t.name, t.attrs ?? new Map());
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      out.push(`<${t.name}${attrStr}>`);
      if (!VOID_TAGS.has(t.name) && !t.selfClosing) openStack.push(t.name);
      continue;
    }
    if (t.type === "close" && t.name) {
      if (!ALLOWED_TAGS.has(t.name) || VOID_TAGS.has(t.name)) continue;
      // Close back to (and including) the nearest matching open tag, so
      // malformed overlap (e.g. <b><i></b></i>) cannot desync the stack from
      // what was actually emitted.
      const idx = openStack.lastIndexOf(t.name);
      if (idx === -1) continue;
      for (let i = openStack.length - 1; i >= idx; i--) out.push(`</${openStack[i]}>`);
      openStack.length = idx;
    }
  }
  for (let i = openStack.length - 1; i >= 0; i--) out.push(`</${openStack[i]}>`);
  return out.join("");
}
