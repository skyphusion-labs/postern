#!/usr/bin/env node
// Regenerate inbound/src/webmail.ts from the canonical webmail/index.html.
// The worker embeds the page at deploy time (no filesystem read at runtime).
// webmail.test.ts asserts byte-identical sync; run this after editing the HTML.
//
// Usage (from inbound/): npm run sync-webmail

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inboundDir = resolve(here, "..");
const htmlPath = resolve(inboundDir, "../webmail/index.html");
const outPath = resolve(inboundDir, "src/webmail.ts");

const html = readFileSync(htmlPath, "utf8");
if (html.includes("`") || html.includes("${")) {
  console.error("sync-webmail: webmail/index.html contains backticks or ${; cannot embed in a template literal");
  process.exit(1);
}

function escapeForTemplateLiteral(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const embedded = escapeForTemplateLiteral(html);

const header = `// Self-contained read-only Postern webmail (the human browser door, complementing
// the IMAP proxy). A single vanilla HTML/CSS/JS page, no framework and no build
// step. It is a CLIENT of the read API (#24): the operator supplies the API
// origin + their Postern API token in the browser; the token lives in
// sessionStorage only and rides as a Bearer header, never a cookie or URL.
//
// Served same-origin by the inbound worker (so the page and the API it calls
// share an origin, avoiding CORS and keeping the token in one security context).
// The canonical, editable source is webmail/index.html at the repo root; this
// embedded copy is generated from it by scripts/sync-webmail.mjs and checked by
// webmail.test.ts (the worker runtime cannot read a file at request time).
//
// After editing webmail/index.html: cd inbound && npm run sync-webmail
//
// Security: all message-derived content is inserted via text nodes / setAttribute
// in the page script, never innerHTML, so stored message bytes cannot inject
// markup or script. See webmail/index.html.

export const WEBMAIL_HTML = \``;

const footer = `\`;

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  // Lock the page down: it loads no third-party anything and only talks to the
  // same origin (its own API). connect-src 'self' means a hijacked page cannot
  // exfiltrate the pasted token to another host.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    // frame-src 'self' permits the sandboxed srcdoc iframe the reading pane uses
    // to render message bodies in an isolated context (sandbox="" = no scripts,
    // no same-origin), so stored body content can never execute or reach the API.
    "connect-src 'self'; img-src 'self' data:; frame-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Serve the webmail page. Public (no token gate): the page itself carries no
// secret; the token is entered client-side and only used for API calls.
export function serveWebmail(): Response {
  return new Response(WEBMAIL_HTML, { status: 200, headers: SECURITY_HEADERS });
}
`;

writeFileSync(outPath, header + embedded + footer);
console.log(`sync-webmail: wrote ${outPath}`);
