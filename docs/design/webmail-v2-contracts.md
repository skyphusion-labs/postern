# Webmail v2: account/session, durable state, and IMAP consistency contracts

Status: **design of record for epic #338, phase 1**. Design only; ZERO implementation
ships in this PR. This document is the contract the phase 2-6 implementation PRs read
from, so a binding, a column, or a UID rule never gets invented per-component. It is
reproducible from the doc alone (ICD discipline). Field names map to the code they will
touch (`inbound/src/api.ts`, `inbound/src/store.ts`, `inbound/schema.sql`,
`imap/posternimap/`) so the implementation diff stays traceable.

It inherits the Fable product-gap review (`docs/reviews/fable-product-gap-review-2026-07-17.md`,
PR #340) and closes the finding class it names: D5/D6 (APPEND silent discard + Trash
hard-delete masquerading as recovery), D10 (seen-state divergence between doors), C4
(no delete scope), C2 (no idempotency), D7 (Trash staging keyed on free-text username).

Read first: `docs/CONTRACT.md` (the store + API), `docs/AUTH-CONTRACT.md` (the auth
seams), `docs/SEND-IDENTITIES.md` (per-identity send). This document EXTENDS them; where
it and they disagree on a v2 surface, this wins; on everything else they remain
authoritative.

## 0. Principles this design does not violate

Carried verbatim from the epic and the house rules, so every proposal below is checked
against them:

1. **One store, one account contract.** Webmail is a client of the one mailbox API,
   never a second store; the account model reuses the EXISTING auth seams and does NOT
   stand up a second identity store.
2. **Server is authoritative.** The bound From, the folder placement, the delete, the
   HTML sanitization all resolve server-side; the browser is never trusted.
3. **Additive migrations.** Every schema change flows through the #112 deploy gate as
   `CREATE TABLE` / `ALTER ... ADD COLUMN` only, auto-applies, no backfill UPDATE, no
   supervised window. Old rows render exactly as today.
4. **RFC 3501 is the source of truth.** The IMAP projection stays conformant; UID
   never-reuse and UIDVALIDITY discipline are non-negotiable.
5. **Vanilla stays.** This is a contract/schema document; it crosses no framework
   threshold. If phase 2-6 produces evidence the vanilla-JS/no-build-step default must
   change, that is a separate escalation to the lead, not a decision made here.
6. **Minimal deps, no secrets in tracked files, no tokens in URLs, no unsafe render.**

---

## 1. Account and session contract

### 1.1 The problem, and the one-store constraint

Today a hosted webmail user pastes an API origin, a `read` token, and an optional `send`
token into a gate; the tokens live in `sessionStorage` and ride as `Authorization:
Bearer` (`webmail/COMPOSE.md` section 1). That is a fine OPERATOR path and it is
preserved (section 1.7). It is not an acceptable NORMAL-USER path: a long-lived bearer
token in JS is exfiltratable by any XSS that ever lands, and webmail renders untrusted
HTML email, which is the single richest XSS surface in the product (epic security
requirements).

The constraint that shapes everything: **do not build a second identity store.** Postern
already has account identity in three places, and the session contract must derive from
them, not duplicate them:

| Existing seam | Where | What it proves |
|---|---|---|
| `smtp_credentials` (native backend) | worker D1, `POST /api/smtp-auth` (PBKDF2) | a local account username + secret -> a bound `from` address |
| directory (ldap / system-PAM backends) | the relay + IMAP door processes | a directory login -> a bound identity, gated on `mail-users` |
| per-identity send registry (#28) | worker secret `POSTERN_SEND_IDENTITIES` | a send token -> an authoritative bound From |

### 1.2 The model: a session is a short-lived, derived capability, not a new identity

A webmail session is **exactly a per-identity capability grant with a short lifetime, an
HttpOnly custody, and instant revocation.** It carries the SAME two things the existing
authorization model already resolves for a Bearer token:

- a **scope set** (the existing `read` / `send` / `delete` vocabulary, section 4), and
- a **bound identity** (the authoritative From, exactly as a registry token binds it).

This is the reconciliation: the worker already has `resolveToken` (`inbound/src/api.ts`)
that maps a presented Bearer to `{ scope, identity }` (static tokens -> scope, no
identity; registry tokens -> `send` + bound identity). **A session cookie resolves
through the SAME function to the SAME `{ scope, identity }` shape.** Downstream code
(`/api/send` From-binding, the scope gate) does not learn a new concept; a session is
just a third way to arrive at `{ scope, identity }`, alongside static tokens and the
registry. No parallel authorization path, no second store.

### 1.3 Credential verification: pluggable, mirrors the doors

A session is minted by verifying a credential. The verifier mirrors the door
`AUTH_BACKEND` selector so the account model is ONE model across webmail / IMAP / SMTP:

| `WEBMAIL_AUTH_BACKEND` | verifies against | phase |
|---|---|---|
| `native` (default) | `smtp_credentials` (the same PBKDF2 the relay `POST /api/smtp-auth` uses) | **phase 2** |
| `ldap` / `system` | the directory, via a verifier the fleet doors already run | **phase 2+ (gated, see 1.9)** |
| `off` | no session endpoint; BYO-token only (self-host operator posture) | always available |

`native` is the fresh-clone default and the one this phase specifies end to end: the
SAME username+secret a user configures for SMTP submission (native mode) logs into
webmail. One credential, all doors, no new store; `smtp_credentials` becomes the local
**account** table for the native backend, its role widened, its schema not forked.

The `ldap`/`system` webmail login on a directory-backed deployment (the skyphusion
fleet) is designed here but **gated to a later phase** because a Cloudflare Worker cannot
bind the directory itself (section 1.9); until then, directory deployments use BYO-token
webmail, which works today. This limitation is stated, never silently papered over.

### 1.4 Custody decision: HttpOnly same-origin session cookie (hosted) vs bearer-in-JS (BYO)

**Decision: the hosted path uses an HttpOnly, Secure, SameSite, same-origin session
cookie holding an opaque server-side session id. Bearer-in-JS is retained ONLY for the
BYO-token operator path.** Rationale:

- The dominant threat is token exfiltration via XSS through rendered HTML email. An
  HttpOnly cookie is unreadable by JS, so an XSS that lands cannot steal the session
  credential; a `sessionStorage` bearer can be read and posted out in one line.
- The cost of the cookie is CSRF exposure, which is a SOLVED problem (section 1.6):
  SameSite + a required custom header + a synchronizer token. XSS token theft against a
  JS-held bearer is not comparably containable.
- The opaque id is a handle to server-side state, so **revocation is instant** (delete
  the row), which the epic requires (sign out, revocation). A self-contained JWT would
  trade that away.

The cookie name is `__Host-postern_session` (the `__Host-` prefix forces `Secure`,
`Path=/`, no `Domain`, so it cannot be scoped up to a parent domain or set over plaintext).

### 1.5 The session endpoints

New routes on the inbound worker (`inbound/src/api.ts`). All are same-origin only; the
session cookie is never honored cross-origin (CORS never reflects credentials for these).

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/session` | sign in: `{ username, password }` -> mint session, `Set-Cookie`, return identity + caps + CSRF token |
| GET | `/api/session` | whoami / restore: current `{ identity, capabilities, expiresAt }` or `401` |
| DELETE | `/api/session` | sign out: revoke this session, clear the cookie |
| POST | `/api/session/refresh` | optional explicit extend; sliding refresh also happens on any authed request (1.5.3) |

#### 1.5.1 `POST /api/session`

```
POST /api/session          (same-origin; no Authorization header)
  { "username": "conrad", "password": "..." }

200 Set-Cookie: __Host-postern_session=<opaque-32-byte-base64url>;
                HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<idle-window>
  {
    "identity":     { "from": "conrad@skyphusion.org", "displayName": "Conrad" },
    "capabilities": ["read", "send", "delete"],
    "expiresAt":    "2026-07-18T12:00:00Z",
    "csrfToken":    "<per-session synchronizer token>"
  }

401  { "ok": false, "error": "E_AUTH_FAILED" }
429  { "ok": false, "error": "E_RATE_LIMITED", "retryAfter": <seconds> }
```

- `SameSite=Lax` (not `Strict`) so a top-level navigation to `/webmail` still carries the
  cookie (Strict would drop it on the first cross-site link click into the app); state
  change is protected by the CSRF token + custom header regardless (1.6).
- The bound `from` and `displayName` come from the verified account (native:
  `smtp_credentials.from_addr`). The browser can finally show **Sending as ...**
  (closes the D12 / #338 known gap): `GET /api/session` echoes the identity, which a
  send token could never do (a send token gets `403` on every GET).

#### 1.5.2 The session record (server-side, D1)

```sql
-- migration 0009 (additive: CREATE TABLE only; auto-applies through the #112 gate)
CREATE TABLE IF NOT EXISTS webmail_sessions (
  id_hash      TEXT PRIMARY KEY,   -- sha256hex of the opaque cookie value; RAW id never stored
  identity     TEXT NOT NULL,      -- bound From address (authoritative sender for this session)
  display_name TEXT,
  caps         TEXT NOT NULL,      -- comma-set of scopes granted: e.g. "read,send,delete"
  csrf_hash    TEXT NOT NULL,      -- sha256hex of the synchronizer token
  issued_at    TEXT NOT NULL,      -- absolute-cap anchor
  last_seen_at TEXT NOT NULL,      -- sliding-window anchor
  expires_at   TEXT NOT NULL,      -- min(last_seen + idle, issued + absolute)
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_identity ON webmail_sessions(identity);
```

We store the **hash** of the cookie value, never the raw id (same discipline as the send
registry storing token hashes, `SEND-IDENTITIES.md` section 5): a read of the sessions
table yields no usable cookie. Resolution hashes the presented cookie and looks up
`id_hash`.

#### 1.5.3 Expiry, sliding refresh, revocation

- **Idle window** (e.g. 30 min) and an **absolute cap** (e.g. 12 h). `expires_at =
  min(last_seen_at + idle, issued_at + absolute)`.
- **Sliding refresh** on any authed request: bump `last_seen_at` / `expires_at`. To bound
  D1 write amplification (one write per request is unacceptable, ties to C8), the update
  is **throttled**: only written when `last_seen_at` is more than a threshold (e.g. 60 s)
  stale. So a burst of requests writes the row at most once a minute.
- **Revocation is instant**: `DELETE /api/session` sets `revoked = 1` (or deletes the
  row) for this session; a sign-out-everywhere (later phase) deletes all rows for the
  identity via `idx_sessions_identity`. A revoked/expired cookie resolves to `401` and
  the client is bounced to sign-in.
- Expired/revoked rows are swept by the same kind of gated maintenance the store already
  uses (a cron-triggerable prune); until swept they are inert (resolution checks
  `revoked` and `expires_at`).

### 1.6 Threat model (each briefly, per the epic)

| Threat | Mitigation |
|---|---|
| **XSS token theft** | HttpOnly cookie; JS cannot read the session credential. The rendered-email XSS surface stays sandboxed (existing srcdoc iframe + CSP); the session cannot leak even if a top-frame XSS ever landed, because it is not in JS-reachable storage. |
| **CSRF** | (1) SameSite=Lax cookie; (2) every state-changing route (POST/DELETE, send, reply, flag, move, delete, draft) REQUIRES an `X-Postern-CSRF` header equal to the session synchronizer token, which a cross-site form or simple request cannot set (it forces a preflight the attacker origin fails); (3) the token is bound to the session server-side (`csrf_hash`). Reads are cookie+SameSite protected; writes need the header too. |
| **Session fixation** | A fresh opaque id is minted on every successful `POST /api/session`; a client-supplied session id is never accepted or adopted. Re-auth mints a new id and revokes the old. |
| **Credential stuffing / brute force** | Per-username AND per-IP throttle on `POST /api/session` with exponential backoff + temporary lockout (the auth-path slice of C8 rate-limiting gap). Counters keyed server-side; lockout returns `429` with `Retry-After`. |
| **Account enumeration** | Constant-time verify with a dummy-hash path for an unknown username (the pattern `POST /api/smtp-auth` already uses); identical error (`E_AUTH_FAILED`) and indistinguishable timing for bad-user vs bad-password. No user-not-found signal. |
| **Cookie theft in transit** | `Secure` (enforced by `__Host-` prefix); TLS-only; not set on plaintext. |
| **Clickjacking** | Served CSP keeps `frame-ancestors 'none'` (already the webmail posture, COMPOSE.md section 6). |
| **Privilege via tampered cookie** | The cookie is an opaque random handle, not a claims blob; capabilities live only in the server-side row, so there is nothing in the cookie to tamper. |

### 1.7 BYO-token mode preserved (the operator / self-host path)

The existing connect gate (API origin + read token + optional send token, in
`sessionStorage`, header-only) stays exactly as shipped (`webmail/COMPOSE.md`). It is the
advanced/self-host path and the fallback for directory deployments before 1.9 lands. The
session path is **additive and default for the hosted account experience**; nothing about
BYO-token changes, and a deployment with `WEBMAIL_AUTH_BACKEND=off` exposes no session
endpoint at all. This honors the epic non-goal against forcing public-account
infrastructure on every self-hoster.

### 1.8 How a session authorizes an API call (the resolveToken unification)

```
request arrives
  -> has __Host-postern_session cookie?  --yes--> hash -> webmail_sessions lookup
        -> valid + not revoked + not expired?  --yes--> { scope = caps, identity }
        (state-changing method also requires matching X-Postern-CSRF)
  -> else has Authorization: Bearer?     --yes--> existing resolveToken
        (static scope tokens, then per-identity registry)
  -> else 401
```

The cookie branch produces the identical `{ scope, identity }` the Bearer branch does, so
`/api/send` and `/api/reply` bind the From to `identity.from` for a session EXACTLY as
they do for a registry token (`SEND-IDENTITIES.md` section 4), and the scope gate treats
`caps` as it treats a token scope. One authorization model, three credential sources.

### 1.9 Directory (ldap/system) webmail login: the seam, and why it is gated

A Cloudflare Worker cannot open an LDAP/PAM bind to the fleet directory (it is not on the
VLAN and has no socket path to `nslcd`). So worker-native session mint can verify only the
`native` backend. To reconcile directory identity WITHOUT a second store, the design is a
**session-verifier seam**: `POST /api/session` with `WEBMAIL_AUTH_BACKEND=ldap|system`
delegates the credential check to a configured `WEBMAIL_SESSION_VERIFIER_URL` that a fleet
door (the relay or a small verifier) already runs, using the SAME direct-bind + self-read
+ `mail-users` gate the doors enforce (`AUTH-CONTRACT.md` section 5b). The verifier
returns the bound `mail` identity; the worker mints the session from it. This is
explicitly **phase 2+ and gated for lead/Conrad signoff** (it touches the fleet exposure
posture, section 5 decision D-AUTH-2); it is designed now so the account contract is ONE
contract, not invented later. Until it lands, directory deployments use BYO-token webmail.

---

## 2. Durable folders, flags, and drafts schema

### 2.1 What is a placeholder today, and what must become durable

Per the review (D5/D6/D10) and `imap/posternimap/account.py`:

- INBOX / Sent / All are real, direction-derived views over `messages` (`direction`
  column). They stay.
- Drafts / Trash / Junk / Archive are **empty placeholders** with no backing state.
  Drafts APPEND is a silent no-op (D5); Trash COPY hard-deletes and cannot recover (D6).
- Flags: only `\Seen` is durable (`messages.seen`, #seen). `\Flagged` (star),
  `\Answered`, `\Draft` are not.
- Read state is durable but webmail neither shows nor sets it (D10).

Full webmail needs durable **folder placement**, **flags beyond \Seen**, and
**server-side drafts**, all in core, projected consistently to webmail and IMAP.

### 2.2 Flags beyond \Seen (additive columns)

```sql
-- migration 0009 (additive ALTER ADD COLUMN; auto-applies, no backfill, DEFAULT carries old rows)
ALTER TABLE messages ADD COLUMN flagged  INTEGER NOT NULL DEFAULT 0;  -- \Flagged / starred
ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;  -- \Answered
```

`\Seen` stays `messages.seen`. `\Draft` is NOT a flag on `messages` (a draft is not a
stored message; see 2.4). `\Deleted` stays session-local until EXPUNGE (RFC 3501), it is
not a durable column. Old rows default to not-flagged/not-answered, rendering as today
(the #seen `DEFAULT` precedent). These back the webmail star/answered UI and the IMAP
`PERMANENTFLAGS` set, kept in one store so the two doors cannot diverge (retires D10 for
the new flags the same way #seen did for read state).

`POST /api/messages/flags` (new, `read`-scoped, mirroring `POST /api/messages/seen`):
body `{ ids: string[], set: { flagged?: boolean, answered?: boolean } }` -> `{ updated }`.
Flag mutation is a side effect of organizing mail, so it is `read`-scoped, consistent with
the standing decision that marking `\Seen` is `read`-scoped (`CONTRACT.md` section 4).

### 2.3 Folder placement: the mutually-exclusive system boxes

A message has ONE mutable system-box placement. INBOX/Sent are the arrival-default views;
Archive/Trash/Junk are placements a message MOVES into.

```sql
-- migration 0009 (additive)
ALTER TABLE messages ADD COLUMN mailbox    TEXT;  -- NULL | 'archive' | 'trash' | 'junk'
ALTER TABLE messages ADD COLUMN trashed_at TEXT;  -- soft-delete timestamp; drives Trash recovery window + purge
```

- `mailbox IS NULL` -> the message shows in its **direction-default** view (inbound ->
  INBOX, outbound -> Sent); this is every existing row, so old data renders exactly as
  today (additive, no backfill).
- `mailbox = 'archive' | 'junk'` -> removed from INBOX/Sent, shown in that box. `All`
  stays the union of both directions REGARDLESS of `mailbox` (archive/junk/trash still
  live in All, matching Gmail All Mail and the existing `\All` semantics).
- `mailbox = 'trash'` with `trashed_at` set -> **soft delete** (2.5). This is the D6 fix:
  Trash is a recoverable state, not a hard delete.

Move is `UPDATE messages SET mailbox = ? WHERE message_id = ?` at RUNTIME (not a
migration; the #112 gate governs migration files, not app writes). Restore = set `mailbox
= NULL`. This is a per-message single-placement model (Gmail-like), chosen over a
labels/junction table because (a) it is additive columns, no new join on every read, and
(b) user-created folders/labels are deferred for the first release (decision D-FOLDER-1),
so a many-to-many is not yet needed. The placement/UID table in 2.6 is where the
many-to-many extension point lives when user folders arrive.

### 2.4 Server-side drafts (new table)

A draft is not a `messages` row: it has no Message-ID identity, no direction, no thread
resolution, and it is rewritten on every autosave. It gets its own table so a draft
churn never touches the message store, its FTS, or its Vectorize index (C-class amplifiers
stay off the mail store).

```sql
-- migration 0009 (additive: CREATE TABLE only)
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,   -- server-minted uuid; the draft handle
  identity     TEXT NOT NULL,      -- owning account (bound From); IDOR boundary
  to_addr      TEXT,
  cc_addr      TEXT,
  bcc_addr     TEXT,
  subject      TEXT,
  body_text    TEXT,
  body_html    TEXT,               -- stored as authored; sanitized at SEND, section 3-adjacent
  in_reply_to  TEXT,               -- set when the draft is a reply/forward
  thread_id    TEXT,               -- for reply drafts, so the composed reply threads
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_identity ON drafts(identity, updated_at);
```

Draft attachments: staged bytes go to R2 under a `drafts/<id>/<n>` key with a
`draft_attachments` metadata table (same additive shape as `attachments`); deferred to the
compose-parity phase (4) with the schema reserved here. For phase 1 the contract is the
`drafts` table above.

Draft API (new, capability = `send`, because a draft is composed outbound mail owned by
the sending identity):

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/drafts` | create; body = draft fields; returns `{ id }` |
| PUT | `/api/drafts/{id}` | autosave/replace (idempotent upsert by id) |
| GET | `/api/drafts` / `/api/drafts/{id}` | list / read own drafts (scoped to `identity`) |
| DELETE | `/api/drafts/{id}` | discard |
| POST | `/api/drafts/{id}/send` | send the draft via the one send core, then delete the row |

Send-from-draft funnels through the SAME `mailbox.send()` (CONTRACT section 3), so the
sent copy stores once and threads correctly (no double-store). Draft state is server-side,
so it **syncs across sessions and devices** by construction (epic requirement). IDOR: every
draft route filters on the session `identity`; one account cannot read/edit another draft
(the mailbox is shared per-domain, but drafts are per-composing-identity).

### 2.5 Trash soft-delete and the recovery window (retires D6)

- Move-to-Trash (webmail button or IMAP COPY/MOVE to Trash): `mailbox='trash'`,
  `trashed_at=now`. The bytes stay. Nothing is destroyed.
- Restore: `mailbox=NULL` (back to its direction-default view). A real undo, because the
  message was never deleted.
- **Empty Trash / expunge**: the ONLY hard-delete path, via the existing `DELETE
  /api/messages/{id}` (Vectorize tombstone + ledger + R2 + D1, CONTRACT section 4), now
  `delete`-scoped (section 4). Webmail Empty Trash and IMAP `EXPUNGE` on Trash call it.
- **Retention purge**: a gated maintenance job hard-deletes messages with
  `trashed_at` older than `TRASH_RETENTION_DAYS` (operator-configured, default e.g. 30).
  This is app logic over the existing delete path, announced, never silent.

This makes the D6 trap impossible: an undo from Trash restores real bytes; permanent
loss happens only on an explicit Empty Trash or after the announced retention window.

### 2.6 The per-folder UID problem (RFC 3501, load-bearing)

Today every folder shares one config `UIDVALIDITY` and INBOX/Sent/All expose
`messages.id` (the global AUTOINCREMENT rowid) as the IMAP UID
(`imap/posternimap/mailbox.py`). That is conformant ONLY because those views are
**append-only at arrival**: a message membership begins when it arrives, so ordering by
`messages.id` is ordering by folder-add order, and UIDs are strictly ascending and
never-reused.

Durable Archive/Trash/Junk break that invariant. A message MOVES into Trash today whose
`messages.id` may be LOWER than a message trashed yesterday, so exposing `messages.id` as
the Trash UID would insert a lower UID AFTER a higher one, corrupting every client cached
UID -> message map. This is precisely the F9 mid-order-shift the arrival-order design
eliminated for INBOX, reintroduced for any re-populated folder.

**The RFC-correct, minimally-invasive rule:**

| Folder class | Folders | UID source | UIDVALIDITY |
|---|---|---|---|
| Append-only-at-arrival | INBOX, Sent, All | `messages.id` (unchanged) | **unchanged** (do NOT bump; bumping forces every existing client to resync) |
| Re-populated (gain messages out of arrival order) | Archive, Trash, Junk, future user folders | a **per-folder placement UID**, assigned monotonically when the message ENTERS the folder | its own value, minted once when the folder first goes durable |

Moving a message OUT of INBOX/Sent only removes it from that view (a UID gap, which
EXPUNGE already produces and RFC 3501 allows); it does NOT shift or reuse any remaining
UID, so INBOX/Sent stay conformant with `messages.id` and their existing UIDVALIDITY is
preserved. Only the folders that gain messages out of order need the placement UID.

```sql
-- migration 0009 (additive: CREATE TABLE only). Backs per-folder UID assignment for
-- the re-populated folders. INBOX/Sent/All do NOT use this (they keep messages.id).
CREATE TABLE IF NOT EXISTS mailbox_placement (
  message_id  TEXT NOT NULL,
  folder      TEXT NOT NULL,       -- 'archive' | 'trash' | 'junk' | (later) user folder id
  folder_uid  INTEGER NOT NULL,    -- per-folder monotonic, assigned on placement, NEVER reused
  added_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, folder)
);
CREATE TABLE IF NOT EXISTS mailbox_uid_counter (
  folder      TEXT PRIMARY KEY,    -- one row per re-populated folder
  next_uid    INTEGER NOT NULL,    -- high-water mark; hand out then increment, never reuse
  uidvalidity INTEGER NOT NULL     -- minted once for the folder; bump only on a semantics change
);
```

Placement UID assignment is an atomic `next_uid` read-and-increment per folder (a small
`UPDATE ... RETURNING` or a transaction), so concurrent placements never collide and a UID
is never reused even after the message is moved out and back (moving back mints a NEW
`folder_uid`, correct RFC semantics: re-adding is a new UID). `mailbox` (2.3) is the fast
single-placement read for webmail; `mailbox_placement` is the per-folder UID ledger the
IMAP door reads. They are kept consistent by the same write (move = update `mailbox` +
insert/update the placement row).

### 2.7 Migration ordering and the #112 gate

Everything in section 2 is `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ... ADD COLUMN`
with a `DEFAULT`. That is the ADDITIVE class the `d1-migration-gate.mjs` auto-applies
(section 0 principle 3). There is **no** `UPDATE`/backfill: old rows carry NULL `mailbox`
(render in their direction-default view), `0` flags, no placement rows, and behave exactly
as today. So migration `0009` needs no `postern:allow-destructive` marker and no
supervised window; it ships with the code and applies online safely, the same discipline
0006 and 0007 followed. `schema.sql` gains the same columns/tables for a fresh DB.

If the implementation later needs to seed `mailbox_placement` for INBOX/Sent to unify the
model, note that INBOX/Sent deliberately do NOT use the placement table (they keep
`messages.id`), so no seed and no backfill is required, which keeps 0009 additive.

---

## 3. IMAP consistency plan (RFC 3501 conformance)

The new durable state MUST project through the IMAP door without lying and without
breaking a standards client. The RFC is the source of truth
(`postern-rfc-compliance-source-of-truth`).

### 3.1 Folder LIST

The advertised set is unchanged (INBOX, Sent, All, Drafts, Trash, Junk, Archive, Notes),
so a client that already auto-mapped folders is undisturbed. What changes is that
Drafts/Trash/Junk/Archive **stop being empty placeholders** and become real views:

- Drafts -> the `drafts` table (2.4), projected as messages.
- Trash -> `messages WHERE mailbox='trash'`.
- Junk -> `messages WHERE mailbox='junk'`.
- Archive -> `messages WHERE mailbox='archive'`.

User-created folders are NOT advertised in the first release (decision D-FOLDER-1); LIST
stays the fixed set, so the placement table `folder` domain is closed for now.

### 3.2 APPEND: stop the silent discard (retires D5)

The current `append_noop` acknowledges an APPEND with a tagged OK and discards the
message. That is silent data loss for a genuine APPEND (drag from another account, a
non-Postern-SMTP Sent copy). New semantics per target:

| APPEND target | New behavior |
|---|---|
| Drafts | **Store a durable draft** (`POST /api/drafts` equivalent): a genuine draft APPEND now persists. Apple Mail mid-compose autosave finally survives a reconnect. |
| Trash / Junk / Archive | If the appended message already exists in the store (same Message-ID), set its `mailbox` placement; if it is genuinely new, store it as an inbound-class record placed in that folder. Either way the bytes are kept, never discarded. |
| INBOX / Sent / All | A genuine new-message APPEND here has no honest home (these are direction-derived, not arbitrary sinks). **Refuse with a tagged `NO`** (RFC-compliant explicit refusal), NOT a silent OK. The one exception stays the post-submission Sent copy, which is already in the store by Message-ID and dedups (no discard, no double-store). |

The principle: an APPEND either PERSISTS honestly or is REFUSED loudly; it never returns
OK while dropping the message. This retires the D5 silent-loss class for real views.

### 3.3 Trash with a real recovery window (retires D6)

Per 2.5: IMAP COPY/MOVE to Trash sets `mailbox='trash'` + `trashed_at` (soft), it does NOT
hard-delete. MOVE back out of Trash restores (`mailbox=NULL`). `EXPUNGE` on Trash (or
empty) is the hard delete via the `delete`-scoped `DELETE /api/messages/{id}`. This
kills the D6 trap where moving back from Trash hit the APPEND no-op with the body already
gone. Trash staging (the D7 process-wide, username-keyed, unbounded map) is RETIRED: Trash
is now backed by durable `mailbox='trash'` state in the one store, so there is no in-memory
staging to key on a free-text username or to leak across labels; every connection reads the
same durable Trash. This also closes D7.

### 3.4 UIDVALIDITY discipline on projection changes

The load-bearing rule from 2.6, stated for the door:

- INBOX / Sent / All keep `messages.id` as the UID and their **existing UIDVALIDITY**.
  Introducing durable folders does NOT change their UID semantics, so their UIDVALIDITY
  MUST NOT bump (a bump force-resyncs every existing client for no reason).
- Archive / Trash / Junk expose their **per-folder `folder_uid`** (2.6) under a UIDVALIDITY
  minted once when the folder goes durable. Because these folders had no durable state
  before (they were empty placeholders), no client holds a cached UID for them, so
  assigning them a fresh UIDVALIDITY is free and correct.
- A future change to how a folder assigns UIDs (e.g. a re-keying) MUST bump that folder
  UIDVALIDITY (RFC 3501), signaling clients to drop their cache. The `mailbox_uid_counter`
  row carries the value so a bump is a single, deliberate, per-folder act.
- UID never-reuse holds per folder: `next_uid` is a monotonic high-water mark, never
  decremented, never reused, even across move-out-and-back (a re-add mints a new
  `folder_uid`). This mirrors the AUTOINCREMENT never-reuse guarantee `messages.id` gives
  the arrival-order folders (migration 0005 rationale).

### 3.5 Flags projection

`\Seen` (existing), `\Flagged`, `\Answered` are durable (2.2) and project to
`PERMANENTFLAGS` on the real folders; a `STORE` round-trips to `POST /api/messages/seen`
(existing) and `POST /api/messages/flags` (new). `\Deleted` stays session-local until
EXPUNGE (RFC 3501), unchanged. `\Draft` is presented on Drafts-folder messages (they are
drafts) but is not a durable flag on `messages`. Webmail displays and sets `\Seen` and
`\Flagged` (retires D10: the two doors now agree on read state AND star state because both
are the one store columns).

---

## 4. The delete scope, folded into the capability model (retires C4)

Today `RouteScope = read | send | admin`; DELETE requires `admin`, satisfied only by a
`both` token (`inbound/src/api.ts`), so the IMAP door dedicated delete token is forced to
be a full-admin `both` token, breaking least privilege exactly at the one network-facing
credential (C4).

**Add a real `delete` scope.** The vocabulary becomes: `read`, `send`, `delete`, `both`
(where `both` = read + send + delete + credential-admin, the egalitarian single-key
default, unchanged).

| Capability | Grants | Held by |
|---|---|---|
| `read` | GET messages/search/threads/attachments; AND the organize mutations that are side effects of reading: `POST /api/messages/seen`, `POST /api/messages/flags`, move-to-folder, soft-delete-to-Trash | read door, webmail read |
| `send` | `POST /api/send` / `/api/reply`; drafts CRUD (own identity) | send door, webmail compose, registry tokens |
| `delete` | hard delete / empty Trash: `DELETE /api/messages/{id}` | IMAP EXPUNGE credential, webmail Empty Trash |
| `both` | all of the above + credential-admin + reindex/reconcile | operator/crew minter tier only |

Mapping to worker secrets: `POSTERN_API_TOKEN_DELETE` (the env name the IMAP door already
reads for EXPUNGE, `imap/README.md`) becomes a real `delete`-scoped worker slot instead of
being forced to hold a `both` value. `DELETE /api/messages/{id}` accepts `delete` OR
`both`. The IMAP door delete credential drops from full-admin to delete-only (the C4
fix). The static slot follows the comma-set multi-token format (#154) like the others.

**Why organize-mutations stay `read`-scoped, not a new scope:** consistency with the
standing decision that marking `\Seen` is `read`-scoped (a side effect of reading), and
because move/flag/soft-delete are recoverable (the Trash window makes soft-delete
non-destructive). Only the IRREVERSIBLE hard delete gets its own scope. This is a judgment
call flagged for signoff (decision D-DELETE-1): the alternative is a distinct `organize`
scope, at the cost of a fourth token most deployments would never split out.

The webmail session `caps` (section 1.5.2) draws from this same vocabulary: a normal
hosted account gets `read,send,delete` (delete meaning empty-its-own-Trash within the one
shared mailbox). No new authorization concept; the session reuses the scope words.

### 4.1 Idempotency note (C2, adjacent)

Not a phase-1 deliverable, but the session/draft-send path should carry it forward:
`POST /api/drafts/{id}/send` is naturally more idempotent than a raw `/api/send` (the
draft id is a natural idempotency handle: once sent, the draft row is deleted, so a
retry finds no draft and does not re-send). The general `/api/send` idempotency-key
(C2) stays tracked separately; the draft-send path SHOULD document at-least-once and use
the draft id to avoid the double-send window. Flagged as an explicit phase-2 carry.

---

## 5. Explicit decisions list (for Conrad / lead signoff)

Each has a recommendation; none is unilaterally settled in this doc.

| id | Decision | Recommendation | Rationale |
|---|---|---|---|
| **D-FOLDER-1** | User-created folders/labels in the FIRST full release? | **No, defer.** Ship durable SYSTEM folders (Archive/Trash/Junk/Drafts) first. | The placement/UID model (2.6) is designed to admit user folders later (open the `folder` domain + advertise in LIST + a `folders` table) with no migration churn or UIDVALIDITY break for existing folders. Shipping system folders first delivers the D5/D6/D10 fixes without the labels many-to-many and the per-user-folder UID bookkeeping. |
| **D-CONTACTS-1** | Contacts / autocomplete for the first release? | **Recent-recipients MVP only.** A read-only autocomplete derived by querying existing outbound `to/cc/bcc` from `messages` (most-recent, deduped). NO durable address book, no new PII store. | Meets the normal-client expectation cheaply and additively (it is a query over data we already store), and avoids standing up a contacts store (a second store) in phase 1. A full address book is a scoped later phase. |
| **D-HTML-1** | HTML compose sanitization approach? | **Server-side allowlist sanitize at SEND** (authoritative), plus the existing sandboxed-iframe render on read. Browser-side sanitization is treated as UX only, never trusted. | The worker is authoritative and must not trust browser-sanitized HTML (bypassable). Open sub-question for signoff: hand-rolled allowlist serializer (zero-dep, house-preferred) vs one vetted sanitizer dep. Recommend hand-rolled allowlist (strip scripts/styles/event-handlers/remote refs/`cid` abuse; permit a small safe tag/attr set) to hold the minimal-dep line; escalate if the safe-HTML surface proves too large to hand-roll safely. |
| **D-AUTH-1** | Session custody: HttpOnly cookie vs bearer-in-JS? | **HttpOnly same-origin session cookie for hosted; bearer-in-JS retained for BYO/operator.** (Section 1.4.) | XSS token-theft resistance + instant server-side revocation outweigh the CSRF cost, which is mitigated (1.6). BYO-token stays for self-host. |
| **D-AUTH-2** | Directory (ldap/system) webmail login now or later? | **Later, gated.** Phase 1 specifies `native` (smtp_credentials) end to end; directory login uses the verifier seam (1.9) in a later, signoff-gated phase (it touches fleet exposure). BYO-token covers directory deployments meanwhile. | A CF Worker cannot bind the directory; the verifier-URL seam keeps the account contract ONE contract without inventing a parallel store, but it is a fleet-topology change that needs supervision. |
| **D-DELETE-1** | Organize mutations (move / flag / soft-delete-to-Trash): `read`-scoped or a new `organize` scope? | **`read`-scoped** (only hard delete gets the new `delete` scope). | Consistent with the standing `\Seen`-is-read-scoped decision; soft-delete is recoverable (Trash window), so it is non-destructive. A separate `organize` scope adds a fourth token most deployments never split. Flagged because it is a posture call. |
| **D-SESSION-STORE-1** | Session state: server-side D1 rows vs stateless signed token? | **Server-side D1 rows** (1.5.2). | Instant revocation is an epic hard requirement; D1 write amplification is bounded by the throttled sliding-refresh (1.5.3). A stateless JWT trades away revocation. |

---

## 6. Deliberately left for phase 2+ (not in this contract)

- The login/session UI, identity display, and the a11y/responsive shell (phase 2).
- Draft attachment staging bytes/table (schema reserved in 2.4; wired in the
  compose-parity phase 4).
- Rich/HTML compose editor and the sanitizer implementation (the CONTRACT is D-HTML-1;
  the code is phase 4).
- The `WEBMAIL_SESSION_VERIFIER_URL` directory-login seam implementation (1.9, D-AUTH-2).
- Full address book beyond recent-recipients (D-CONTACTS-1 later phase).
- General `/api/send` idempotency-key (C2) beyond the draft-send natural idempotency (4.1).
- Signatures, scheduled send, sign-out-everywhere UI (later phases per the epic).
- The IMAP hydration/SIZE cost-cliff fixes (D1/D2) are a SEPARATE review-blocker track
  (top-10 item 3), not part of this webmail-state contract; noted so they are not lost.

---

## 7. What this contract does NOT do (guardrails restated)

- No second store: sessions, drafts, folders, flags all live in the one core store; the
  account model derives from the existing auth seams.
- No non-additive migration: 0009 is `CREATE`/`ALTER ADD` only, gate-clean, no marker.
- No UIDVALIDITY bump on INBOX/Sent/All: existing clients are not force-resynced.
- No framework/build-step decision: this is contract + schema; vanilla stays until a
  separate, evidence-backed escalation to the lead says otherwise.
- No secrets in tracked files, no tokens in URLs, no trust of browser-sanitized HTML.
