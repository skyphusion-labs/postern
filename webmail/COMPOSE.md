# Postern webmail: compose / reply (as-shipped contract)

What the compose and reply surface in [`webmail/index.html`](index.html) actually
does, as shipped by **#285** (the surface) and **#307** (the honest capability
probe), both closing **#277**. This documents behavior in the tree, not a plan.

House rules it inherits from the read client ([`README.md`](README.md)): vanilla
HTML/CSS/JS, no framework, no build step, CSP-locked, tokens header-only and never
in a URL. The canonical source is `webmail/index.html`; the worker serves an
embedded copy from `inbound/src/webmail.ts` (`npm run sync-webmail` after editing).

Wire contracts for the endpoints themselves: [`docs/CONTRACT.md`](../docs/CONTRACT.md)
(sections 3 and 4). Identity binding: [`docs/SEND-IDENTITIES.md`](../docs/SEND-IDENTITIES.md).

## 1. Two tokens, two scopes, two storage keys

The webmail is a read client that can *additionally* hold a send credential. Under
the `#85` scope split, a `send`-scope token gets `403` on every GET, and the
per-identity registry tokens are `send` scope only. So one token cannot drive both
halves, and the page never pretends it can.

| | Read token | Send token |
|---|---|---|
| Scope | `read` (or `both`) | `send` (or `both`) |
| Drives | list / read / thread / search / attachment GETs | `POST /api/send`, `POST /api/reply` |
| Required | Yes; without it there is no session | No; absent it the session is read-only |
| Storage key | `postern_token` | `postern_send_token` |
| Lifetime | `sessionStorage`, this tab only | `sessionStorage`, this tab only |
| Cleared on | Sign out, tab close | Sign out, tab close |

Two separate `sessionStorage` entries, never merged. Both ride as
`Authorization: Bearer` with `credentials: omit` and `referrer-policy: no-referrer`;
neither is written to a cookie, put in a URL, or logged.

**Both tokens are supplied together, up front, at the connect gate.** The gate has
three fields: API origin, read token, and an optional send token. There is no
separate later "enable sending" gesture; leaving the send field empty yields a
read-only session, and `postern_send_token` is actively removed from storage on a
connect with an empty send field (so it cannot outlive its session).

## 2. The honest capability probe (the central mechanism)

**Compose and Reply gate on a probed fact, never on token presence.** This is the
#277 requirement #307 exists to satisfy: a read-only token must never be offered a
compose UI that can only fail later.

The probe learns the token's scope **without sending mail**. It relies on one
invariant of the worker: **the scope gate runs before body validation**, and
`POST /api/send` with an empty body fails validation (`400`) before any dispatch.
So an empty-body `POST /api/send` reveals scope with zero mail sent:

| Probe response | Meaning | `state.sendCapable` | `state.sendReason` |
|---|---|---|---|
| `403` | token is not send-scoped | `false` | `readonly` |
| `401` | token is unknown / rejected | `false` | `invalid` |
| anything else (in practice `400`) | cleared the scope gate, so send-capable | `true` | `""` |
| network / fetch threw | unknown; never assume capable | `false` | `unreachable` |

`sendCapable` is a **tri-state**: `null` (not yet probed) is distinct from `false`
(probed, not capable). Compose entry points require `sendCapable === true`, so the
un-probed state shows nothing rather than flashing a control it may have to retract.

The probe runs from `showApp()`, which covers **both** a fresh connect and a session
restore from `sessionStorage`. A session restored into a revoked token re-probes and
degrades on its own.

**That worker invariant is load-bearing and is pinned by a test.** `inbound/webmail.test.ts`
asserts a read token gets `403`, a send token with an empty body gets `400`, and
**zero mail is dispatched** (`sent.length === 0`). If the worker ever validated the
body before the scope, the probe would still be truthful but the test is what stops
it from silently becoming a mail-sending probe.

### Reactive degrade

A `403` from a **real** send also flips `sendCapable` to `false` and hides the entry
points (`apiWrite`). Capability is never assumed to persist just because it was true
once; a token revoked mid-session stops offering compose rather than inviting a
doomed retry.

### The note is truthful about *why*

When a send token is present but not capable, a header note states the reason:

| `sendReason` | Note |
|---|---|
| `readonly` | "Send token is read-only; compose disabled." |
| `invalid` | "Send token was rejected; compose disabled." |
| `unreachable` | "Could not verify the send token; compose disabled." |

`unreachable` exists specifically so a network failure never falsely claims the
token is read-only. With no send token configured at all, there is no note (nothing
was claimed, so nothing needs explaining).

## 3. From is the server's to bind

Per `docs/SEND-IDENTITIES.md` section 4, the worker overrides outbound `From` to the
token's bound identity and discards any caller-supplied `from`. The browser honors
that:

- **There is no From field anywhere in compose.** The form is To, Subject, Message.
- The send request **omits `from` entirely** rather than sending a value the worker
  would discard, so the request on the wire is honest about who decides.

**Known gap:** the page does not display which identity it sends as. The header
shows the API **origin**, not a "Sending as ..." line. The webmail cannot introspect
its own send identity (a send token gets `403` on every GET, so there is no read
door for it), and the probe learns *scope*, not *identity*. A user with several
per-identity tokens cannot tell from the UI which one is loaded. Closing this needs a
send-scoped identity echo on the worker side; it is deliberately not faked client-side.

## 4. The two write paths

Both go through `apiWrite`, which refuses to fire without a send token.

### Reply -> `POST /api/reply`

Body: `{ "messageId": "<id>", "text": "<body>" }`. **Nothing else.** Core fills
`to` / `subject` / `In-Reply-To` / `References` / `thread` from stored state, not
caller input, so a reply cannot be mis-threaded or mis-addressed by the browser.

The form prefills To and Subject (`Re:` collapsed if already present) and a quoted
body, but **both fields are `disabled` and are display only**: they are not read
back and not sent. They exist to show the user what core will do.

### Compose -> `POST /api/send`

Body: `{ to, subject, text }`, with `subject` defaulting to `"(no subject)"` when
left empty. Recipient entry is plain text; the worker is authoritative on address
validity and domain policy.

Not shipped, though the API supports them: `cc`, `bcc`, `attachments`, `html`
bodies, and drafts. Body is **plain text only** (`text`), which is the lowest surface
and needs no outbound sanitization.

### After a successful send

The view switches to the **Sent** folder (`direction=outbound`), clears any search,
reloads, and selects the new message when the response carries a `messageId`, so the
stored copy is visible immediately rather than taken on faith.

## 5. Error surfacing

| Condition | API | Behavior |
|---|---|---|
| Token unknown / rejected | `401` | Full **sign out** (both tokens cleared, back to the gate) |
| Not send-scoped | `403` | `sendCapable = false`, entry points hidden, Send stays disabled, inline: "This token is read-only; sending is disabled. Provide a send-scoped token to compose." |
| Validation / upstream / other | `400`, `502`, ... | The API's `message` / `error` shown inline; **the draft is kept** and Send re-enables so a retry is possible |
| Empty body | (client) | "Enter a message." No request is made |

Note the `401` path is deliberately blunter than the `403` path: an unknown token
invalidates the whole session, so it signs out rather than trying to keep a
half-valid session alive. A `403` is narrower (this token cannot *send*), so the read
session survives and only compose is withdrawn.

## 6. CSP and cross-origin

- **Same-origin `/webmail` (the supported path):** no CSP change was needed for
  compose. `connect-src 'self'` already covers `POST` to the same origin, and compose
  authors into a plain `<textarea>`, not an iframe. The served CSP remains
  `default-src 'none'`, `connect-src 'self'`, `frame-src 'self'` (the sandboxed body
  frame only), `frame-ancestors 'none'`.
- **Cross-origin static host:** the API must allow `POST` and the `Authorization`
  request header via CORS. Same requirement the read client's GETs already impose,
  widened by one method.

## 7. Safety invariants (unchanged by compose)

Compose adds an input surface, not a rendering surface, so the read client's posture
carries over intact: no `innerHTML` of message content (build-guarded by a test),
message bodies in a `sandbox=""` `srcdoc` iframe, tokens in `sessionStorage` and
header-only, locked CSP. Quoted reply text goes into a `textarea` `value`, which is
inert.

## 8. Tests

`inbound/webmail.test.ts` covers: compose gates on the probe and **not** on token
presence (the old presence-only gate is asserted gone), and the worker-contract test
of the invariant the probe rides on (read token `403`; send token, empty body `400`;
zero mail dispatched).
