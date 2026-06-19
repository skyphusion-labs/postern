# Postern webmail

A minimal, **read-only** browser frontend for [Postern](../README.md): the human
door, complementing the [IMAP proxy](../imap/README.md). It is a **client of the
Postern read API** (`/api/messages`, `/api/messages/{id}`, `/api/threads/{id}`,
`/api/search`, see [`docs/CONTRACT.md`](../docs/CONTRACT.md) section 4) that lets
a person browse and read the one Postern mailbox in a web browser.

One self-contained `index.html`: vanilla HTML/CSS/JS, **no framework and no build
step**, zero runtime dependencies.

## Screenshots

An HTML email rendered safely in the sandboxed iframe (no scripts, no remote
trackers; author colors on a white background, like any mail client):

![HTML email render](screenshots/webmail-html-email.png)

The inbox list, a single message (headers, trust verdict, body, attachments), and
the thread view:

![Webmail: list + read + thread](screenshots/webmail-inbox.png)

Reading a message with an attachment listing, and search:

| Read view | Search |
|---|---|
| ![Read view](screenshots/webmail-message.png) | ![Search](screenshots/webmail-search.png) |

(Synthetic example data; no real mail.)

The shots are captured against a real local `wrangler dev` instance of the inbound
worker, seeded with the synthetic messages in `inbound/seed.dev.sql` via
`inbound/wrangler.dev.jsonc` (a local D1, no remote bindings). To regenerate:
apply `schema.sql` then `seed.dev.sql` to a local D1, `wrangler dev`, open
`/webmail`, and point it at the dev origin with the dev `POSTERN_API_TOKEN`.

## What it does (v1)

- **Message list** with an Inbox / Sent / All folder filter (the API's
  `direction` filter).
- **Read view** for a single message: headers, trust verdict (spf/dkim/dmarc),
  the body (HTML or plain text, rendered in a sandboxed iframe), and attachments
  with a **Download** button each.
- **Thread view**: sibling messages in the same thread, click to jump.
- **Search** over the mailbox (the `/api/search` endpoint).
- **Read-only.** No compose / send / reply. Sending stays the structured API's
  job, the same boundary as the IMAP proxy. (Compose is a deferred follow-up,
  see below.)

## Auth (#32): bring your own token

Same single-token model as Postern and the IMAP proxy. You supply two things in
the browser:

- the **API origin** (e.g. `https://postern.example`), and
- your **Postern API token**.

The token is the `Authorization: Bearer` for the read-API calls. It is kept in
`sessionStorage` for that browser tab **only**: never sent anywhere but the API
origin you name, never written to a cookie, never put in a URL, never logged, and
cleared on **Sign out** or when the tab closes. The page validates the token
against the API before persisting it.

There are **zero skyphusion-specific assumptions**: the API origin is whatever you
type, no account, domain, or resource name is hardcoded.

## Run it

The page is served by the inbound (core) worker at **`/webmail`** on the same
origin as the API, so the page and the API it calls share an origin (no CORS, and
the token stays in one security context):

```
https://<your-postern-origin>/webmail
```

Open that, paste your API origin + token, and connect.

You can also host `webmail/index.html` as a static file anywhere (or open it
locally) and point it at a remote API origin; in that cross-origin case the API
must send permissive CORS headers (the same-origin `/webmail` path needs none).

## Security posture

The token lives in the browser and the page renders stored message content, so
XSS is the main surface. The page is built to neutralize it:

- **No `innerHTML` of message content.** Every message-derived value (subject,
  from/to, body, attachment names, search results) is inserted via DOM **text
  nodes** / `setAttribute`, never parsed as HTML. Stored bytes cannot inject
  markup or script. A test (`inbound/webmail.test.ts`) fails the build if
  `innerHTML =` ever appears in the page.
- **Body in a sandboxed iframe.** The message body is rendered inside an
  `<iframe sandbox="">` (empty sandbox = no scripts, no same-origin, no forms)
  via `srcdoc`, so even a malicious HTML email cannot execute script or reach the
  token / API. When the message has an HTML body (`bodyHtml`) it is rendered
  there; otherwise the plain text is escaped and bare URLs linkified. The
  `<script>`, `onerror`, `onload`, etc. in an HTML body are inert under the
  sandbox.
- **Locked-down CSP** on the served page: `default-src 'none'`,
  `connect-src 'self'` (a hijacked page cannot exfiltrate the token to another
  host), `frame-src 'self'` (only the sandboxed srcdoc body frame), no
  third-party resources, `frame-ancestors 'none'`, plus `nosniff` and
  `no-referrer`.
- **Attachment download via a Bearer fetch.** The API is token-gated, so a
  download fetches the bytes with the `Authorization` header and saves them from
  an object URL; the token is never placed in a URL. The endpoint returns the
  bytes with `Content-Disposition: attachment`, a sanitized filename, and
  `nosniff`, so attachments are never rendered inline.
- The token rides as a header, with `credentials: omit` (no ambient cookies) and
  `referrer-policy: no-referrer`.

These were verified end to end in a headless browser against a real `wrangler dev`
worker: an HTML body carrying `<script>`, `<img onerror>`, `<svg onload>`, and a
`javascript:` link renders its benign markup while NONE of the payloads execute
(the sandbox blocks them, and a click on the `javascript:` link does nothing); the
body iframe is `sandbox=""`; and the attachment download carries the token as a
header (never in the URL).

## Tests

The serving + sync + safety guards live in the inbound worker's vitest suite:

```bash
cd inbound && npm test     # includes webmail.test.ts
```

`webmail.test.ts` asserts: the `/webmail` route serves the HTML (no token
required for the page itself), the health and `/api` token gating are unchanged,
the locked-down CSP/headers are present, the page never uses `innerHTML`, and the
**embedded copy stays byte-identical to `webmail/index.html`** (the worker embeds
the page because it cannot read a file at request time; the source of truth is
`webmail/index.html`).

## Editing

`webmail/index.html` is the canonical, editable source. After changing it, mirror
it into the embedded copy in `inbound/src/webmail.ts` (the `WEBMAIL_HTML`
constant); the sync test enforces they match.

## Deferred (follow-ups)

- **Compose / reply / send.** Read-only by design for v1; sending is the
  structured API's job. A compose surface (calling `POST /api/send` / `/api/reply`)
  is the natural next step.
- **Keyset pagination polish** and richer search (mode selector for
  fts/semantic/hybrid).
