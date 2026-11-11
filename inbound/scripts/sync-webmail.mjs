#!/usr/bin/env node
// Regenerate inbound/src/webmail.ts from the canonical webmail/index.html.
// The worker embeds the page at deploy time (no filesystem read at runtime).
// webmail.test.ts asserts byte-identical sync; run this after editing the HTML.
//
// Usage (from inbound/): npm run sync-webmail

import { createHash } from "node:crypto";
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

// The page's one inline script is allowed by its hash, not by 'unsafe-inline', so a
// script that is not ours (an injected <script>, an inline event handler, a
// javascript: URL) does not run. Refuse any page shape the hash cannot cover: a
// second <script>, a script with attributes, an inline on*= handler, or a javascript:
// URL would be blocked by the CSP and break the page silently.
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
if (scripts.length !== 1 || scripts[0][1].trim() !== "") {
  console.error("sync-webmail: webmail/index.html must contain exactly one <script> with no attributes");
  process.exit(1);
}
if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html.replace(scripts[0][0], ""))) {
  console.error("sync-webmail: webmail/index.html has an inline on*= event handler; the script CSP would block it");
  process.exit(1);
}
if (/javascript:/i.test(html.replace(scripts[0][0], ""))) {
  console.error("sync-webmail: webmail/index.html has a javascript: URL; the script CSP would block it");
  process.exit(1);
}
// The browser hashes the script text after HTML input normalization (CR LF and CR
// become LF), so hash the same text.
const scriptText = scripts[0][2].replace(/\r\n?/g, "\n");
const scriptHash = "sha256-" + createHash("sha256").update(scriptText, "utf8").digest("base64");
const csp =
  "default-src 'none'; style-src 'unsafe-inline'; script-src '" + scriptHash + "'; " +
  "connect-src 'self'; img-src 'self' data:; frame-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeForTemplateLiteral(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const embedded = escapeForTemplateLiteral(html);

const header = `// Self-contained Postern webmail (the human browser door, complementing
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

// sha256 of the page's one inline <script>, computed by scripts/sync-webmail.mjs.
export const WEBMAIL_SCRIPT_HASH = "${scriptHash}";

// The page CSP. It loads no third-party anything and only talks to the same origin
// (its own API): connect-src 'self' means a hijacked page cannot send the pasted token
// to another host. script-src allows exactly the page's own script, by its hash, so an
// injected script does not run. frame-src 'self' permits the sandboxed srcdoc iframe
// the reading pane uses to render message bodies (sandbox="" = no scripts, no
// same-origin), so stored body content can never execute or reach the API.
// style-src keeps 'unsafe-inline' for the inline <style> and style attributes.
export const WEBMAIL_CSP = "${csp}";

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": WEBMAIL_CSP,
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
