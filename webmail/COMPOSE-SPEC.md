# Postern webmail: compose / reply surface (design spec)

> Design document, not yet built. Written spec only; no code lands from this file.
> It answers the read-token vs send-token split in the browser and how a compose /
> reply surface wires onto `POST /api/send` and `POST /api/reply` under the
> per-identity send model (`docs/SEND-IDENTITIES.md`). House style: vanilla
> HTML/CSS/JS, no framework, no build step, CSP-locked, token never in a URL.

## 0. Why this needs a deliberate answer

The webmail v1 (`webmail/index.html`) is a **read client**: every browse call
(`GET /api/messages`, `/api/messages/{id}`, `/api/threads/{id}`, `/api/search`,
attachment bytes) is a GET. Under the `#85` scope split a **`send`-scope token gets
`403` on every GET**, and the per-identity registry tokens (`docs/SEND-IDENTITIES.md`
section 8) are `send` scope ONLY. So:

- The token that drives the app today is, and must remain, a **read-capable** token
  (`read` or `both`). A pure send token cannot list, open, or search anything.
- Adding compose does NOT mean "give the webmail a send token." It means the webmail
  may hold a **second, separate** credential, the per-identity **send** token,
  supplied only when the user opts into composing, and used only on `POST` writes.

This mirrors the gap we just found one layer down: the MCP read path was riding a
both-scope god token instead of a dedicated read token. The browser answer and the
read-token migration must agree: **one credential per function, never a both-token
standing in for two.**

## 1. The two-token model in the browser

| | Read token | Send token (per-identity) |
|---|---|---|
| Scope | `read` (or `both`) | `send` only |
| Drives | list / read / thread / search / attachment GETs | `POST /api/send`, `POST /api/reply` only |
| Required to use webmail at all | Yes | No (read-only without it) |
| From-binding | n/a | worker binds From to the token's identity, authoritatively |
| Storage key | `postern_token` (existing) | `postern_send_token` (new, separate) |
| Lifetime | sessionStorage, this tab only | sessionStorage, this tab only |
| Cleared on | Sign out, tab close | Sign out, tab close, **and** an explicit "Disable sending" |

Two **separate** `sessionStorage` entries, never merged into one. Same hard posture
for both: kept in this tab only, sent only to the named API origin, never written to
a cookie, never put in a URL, never logged, validated before persist, cleared on sign
out / tab close. The send token gets one extra control the read token does not: it can
be dropped on its own (section 4).

### Why not just let a `both` token do everything

A `both` token CAN read and send, and a user who connects with one (e.g. a legacy
god-token deployment) technically could compose. The spec still treats send as a
**separate opt-in** even for a `both` token, because:

- the end state retires the shared `both` god-token in favour of per-identity send
  (`#28`); designing the UX around a both-token would re-enshrine exactly what we are
  removing;
- a read-only browsing session should not silently carry send capability just because
  the operator happened to hand it a wide token.

So: the read session uses whatever read-capable token the user supplies; compose is a
distinct gesture that asks for (or confirms) a send-scoped credential. A both-token
user is asked to confirm "use this token for sending too?" rather than having it
assumed.

## 2. From is the server's to bind, never the browser's

Per `docs/SEND-IDENTITIES.md` section 4: when `POST /api/send` or `/api/reply` is
authorized by a registry token, the worker **overrides** the outbound `From` to the
bound identity and discards any caller-supplied `from`. The browser does not get a
`From` field. UX consequences:

- **No editable From input anywhere in compose.** The compose form has a recipient,
  subject (send only), and body. It never has a From field.
- The header reads **"Sending as `<identity>`"**, derived from the token, presented as
  fixed fact, not an input.
- For a static `both` / static-`send` token (un-bound), From falls back to the
  server's `DEFAULT_FROM`; the UX shows that same "Sending as `<DEFAULT_FROM>`" line.
  Still server-derived, still not editable.

### Deriving the identity string to display (one backend dependency)

The browser cannot read its own send identity today: a send token gets `403` on every
GET, so there is no introspection door. Three ways to get the "Sending as ..." string,
in order of preference:

1. **(Recommended, backend ask) a tiny send-scoped echo**, e.g. `POST /api/whoami`
   (send-scoped, body-less), returning `{ ok, from, displayName? }` resolved by the
   SAME `resolveToken` path. The webmail calls it once when the send token is supplied
   and shows the authoritative identity **before** the first send. This pairs cleanly
   with the read-token migration and is the right home for "validate the send token
   before persisting it" (section 3). One small, send-scoped, read-nothing endpoint.
2. **Post-hoc from the send response.** `POST /api/send` / `/api/reply` already store
   a sent copy whose `From` is the bound identity; if the response (or a follow-up
   `GET` of the stored sent message, available to the read token) carries the bound
   `from`, the webmail learns and displays the identity AFTER the first successful
   send. Works with zero new endpoints but cannot show the identity pre-send.
3. **Unverified hint, clearly labelled.** Absent any server signal, show "Sending as
   the identity bound to this token (set by the server)" with no name. Never a free
   editable field that implies the browser chooses From.

Recommendation: ship option 1 (the `whoami` echo) as the backend dependency of this
lane; fall back to option 2's post-send display if the echo is not yet available. Do
NOT build option 3's worst case (an editable hint) at all.

## 3. Validating each token before persisting it

The gate already validates the read token by hitting `GET /api/messages?limit=1` and
refusing to persist on `401`. Extend, do not weaken:

- **Read token:** unchanged. Validated by the existing authed GET.
- **Send token:** must NOT be validated with a GET (it would `403` a perfectly good
  send token and reject it). Validate it with the send-scoped `whoami` echo (section
  2, option 1): a `200 { from }` persists the token and yields the "Sending as" line;
  a `401` means an unknown token; a `403` means the token is not send-scoped (e.g. a
  read token pasted into the send slot). Until the echo exists, the send token is
  accepted optimistically and the FIRST `POST /api/send` / `/api/reply` is its real
  validation, with `401` / `403` surfaced as below and the token dropped on `401`.

## 4. Opt-in to compose, and dropping send capability

Default state after connecting with a read token: **read-only**, no send token in
storage, no compose controls armed. Compose is an explicit opt-in:

- A **Reply** button on a read view and a **Compose** button in the toolbar are
  visible but, with no send token present, their first click opens a small
  **"Enable sending"** panel: one password input for the per-identity send token
  (plus, for a `both`-token session, a "use my current token for sending" confirm),
  validated per section 3, then stored under `postern_send_token`.
- Once a send token is present, Reply / Compose go straight to the editor and the
  header shows the persistent "Sending as `<identity>`" line plus a **"Disable
  sending"** control.
- **"Disable sending"** clears ONLY `postern_send_token` (the read session and
  browsing continue), so a user can shed send capability without a full sign out.
- **Sign out** clears both tokens, as today.

This keeps the blast radius honest: a session is read-only until the user deliberately
arms sending, and can return to read-only at will. The send-capable credential is
never acquired as a side effect of browsing.

## 5. Wiring the two write endpoints

Reply is the smaller, safer surface and should be compose **v1**; new-message send is
**v2**.

### 5a. Reply (v1)  ->  `POST /api/reply`

From a read view of message `X`, **Reply** posts `{ messageId: X, text }` (or
`{ messageId, html }` later, section 6). Core fills `to` / `subject` / `In-Reply-To` /
`References` / `thread` from **stored state, not caller input** (`docs/CONTRACT.md`
section 3.x), so the browser supplies only the body. This is ideal for a frontend:

- no recipient entry (no spoofing a thread, no address typo),
- no subject entry (core derives `Re:` and collapses an existing prefix),
- the reply is guaranteed to thread to the message the user is reading.

Request body the webmail sends: `{ "messageId": "<id>", "text": "<body>" }`. From is
bound by the token. Nothing else.

### 5b. New message (v2)  ->  `POST /api/send`

A **Compose** editor posts a `SendRequest` (`docs/CONTRACT.md` section 4): `to`
(required), `cc?`, `bcc?`, `subject`, and `text` (and/or `html`, section 6). The
browser **omits `from` entirely** (the worker would discard it anyway; omitting it
makes the contract honest). `bcc` is envelope-only on the API side, so the webmail can
offer a Bcc field without it leaking into headers.

Recipient input is plain text address entry with light client-side shape validation
(display only; the worker is authoritative on address validity and domain policy).

## 6. Body format: plain text first

The read view renders received HTML safely in a `sandbox=""` iframe. **Authoring** is
the inverse problem and should start minimal:

- **v1 / v2 first cut:** plain-text body only (`text` field on reply/send). No HTML
  authoring, no rich editor. Lowest surface, nothing for us to sanitize on the way
  out, and it matches how agents compose.
- **Follow-up:** optional HTML body (`html`), authored as plain markup or a minimal
  formatting toolbar, still no framework. Deferred, tracked separately.
- **Attachments:** `SendRequest.attachments[]` is base64 with a 20-part / 25 MiB cap
  and `E_PAYLOAD_TOO_LARGE` (413) on overflow (`docs/CONTRACT.md`). Deferred to a
  later cut; it adds a file-input surface and size-cap UX. Note: the relay outbound
  bridge does not yet carry attachments (#92), so attachment compose is gated on the
  default CF transport.

## 7. Error surfacing (reuse the `E_*` contract)

Map the API's existing `{ ok:false, error, message }` + `E_*` codes to human lines in
the compose panel, never a silent failure:

| Condition | API | Webmail message / action |
|---|---|---|
| Unknown / wrong send token | `401` | "Send token rejected." Drop `postern_send_token`, reopen the Enable-sending panel. |
| Token not send-scoped (read token in the send slot, or a registry From off-domain) | `403` `E_SENDER_NOT_ALLOWED` | "This token cannot send (it is not a send-scoped identity token)." Keep the read session; do not store it as the send token. |
| Body / address validation | `400` | Show the field error inline; keep the draft. |
| Attachment over cap (when attachments ship) | `413` `E_PAYLOAD_TOO_LARGE` | "Attachment too large (max 25 MiB total)." Keep the draft. |
| Transport / upstream failure | `502` | "Send failed upstream; nothing was sent. Try again." Keep the draft. |

A `403` on send with a token that READS fine is the signal that the user pasted their
read token into the send slot (or vice versa): the message names that explicitly so the
fix is obvious.

## 8. CSP and cross-origin

- **Same-origin `/webmail` (the supported path):** the existing CSP already allows it.
  `connect-src 'self'` covers `POST /api/send` and `/api/reply` to the same origin; no
  CSP change is needed to add compose. `frame-src 'self'` and the `sandbox=""` body
  frame are unchanged (compose authors plain text into a normal textarea, not an
  iframe).
- **Cross-origin static host (the "open index.html anywhere" path):** the API must
  send permissive CORS that allows `POST` and the `Authorization` request header (the
  read v1 already needs CORS for GET; send adds `POST` to the allowed methods). Flag
  for the infra/worker side; no webmail change beyond what GET already assumes.
- Both tokens ride as `Authorization` headers with `credentials: omit` and
  `referrer-policy: no-referrer`, exactly as the read client does. Neither token ever
  enters a URL or query string.

## 9. Backend dependencies (what this lane needs from the worker side)

1. **(Recommended) a send-scoped `POST /api/whoami` echo** returning the bound
   `{ from, displayName? }`, so the webmail can show "Sending as ..." and validate the
   send token before persisting it (section 2 / 3). Small, send-scoped, reads nothing.
2. **Confirmation that the send/reply response (or the stored sent copy) carries the
   bound `from`**, as the fallback identity-display path if the echo is not built
   (section 2, option 2).
3. **CORS allowing `POST` + `Authorization`** for the cross-origin static-host case
   (section 8); not needed for same-origin `/webmail`.

None of these block the read-token migration; they pair with it.

## 10. Build order (when this becomes the active lane)

1. Two-token storage + Enable-sending / Disable-sending opt-in (sections 1, 4).
2. Reply v1 over `POST /api/reply` (section 5a), plain-text body (section 6).
3. "Sending as `<identity>`" via the `whoami` echo, else post-send display
   (sections 2, 3).
4. Compose (new message) v2 over `POST /api/send` (section 5b).
5. Follow-ups: HTML body, attachments (section 6).

Every step stays vanilla, no build step, CSP-locked, header-only tokens, and keeps the
existing `webmail/index.html` <-> embedded-copy sync (`inbound/src/webmail.ts`) and the
no-`innerHTML` build guard intact.
