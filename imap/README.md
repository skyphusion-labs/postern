# postern-imap

An **IMAP proxy frontend for [Postern](../README.md)**: it serves the one Postern
mailbox over plain IMAP so a human (Thunderbird, mutt, iOS Mail, ...) or an
IMAP-speaking agent can read mail that arrived through Postern, without ever
touching D1/R2 directly.

Stack map: [docs/architecture.md](../docs/architecture.md).

**Production image:** `imap/Dockerfile` builds `ghcr.io/skyphusion-labs/postern-imap`
on **Python 3.14 slim** (stay current; do not pin back without cause). Fleet deploy
record: `fleet-chezmoi/system/postern-imap/README.md`.

```mermaid
flowchart LR
    mua[Thunderbird / iOS Mail] --> imap[postern-imap]
    imap -->|GET /api/*| api[Postern Mailbox API]
```

Postern is "one mailbox reachable two ways: by agents (the structured API) and by
humans (IMAP/webmail, which are *clients* of that same API)" (see
[`docs/CONTRACT.md`](../docs/CONTRACT.md)). This proxy is exactly that human door:
it is a **client of the Postern mailbox read API** (`/api/messages`,
`/api/messages/{id}`, `/api/threads/{id}`, `/api/search`), and it renders each
stored message back into RFC822 for IMAP FETCH.

It is built on Twisted's `twisted.mail.imap4` server, per the shape Conrad sketched
in #12.

## What it does (v1)

- **Read-only store, with ONE exception: the `\Seen` (read/unread) flag.** `LOGIN`,
  `LIST`/`LSUB`, `SELECT`/`EXAMINE`, `STATUS`, `FETCH`, `SEARCH`, `LOGOUT`. You read
  mail here; you **send** through the structured API (`POST /api/send` / `/api/reply`)
  or the submission server, not by IMAP. Read state IS persisted: a `STORE +/-FLAGS
  (\Seen)` round-trips to `POST /api/messages/seen`, so marking a message read/unread
  sticks across clients and sessions and a human can tell new mail from mail they have
  already read. Inbound mail arrives **unread**; the mailbox's own sent copies are
  stored **read**. The real views (INBOX/Sent/All) SELECT as `READ-WRITE` with
  `PERMANENTFLAGS (\Seen \Deleted)`. `STORE +/-FLAGS (\Deleted)` is session-local
  until `EXPUNGE`, which hard-deletes via `DELETE /api/messages/{id}` (requires
  **POSTERN_API_TOKEN_DELETE**, a `both`-scoped member on the worker, separate from
  the read token). **Apple Mail** deletes by COPY/MOVE to Trash instead; COPY to
  Trash is handled as the same hard-delete (Trash is not a second store; staged
  summaries are shared across IMAP connections until EXPUNGE or reconnect). Archive
  is an empty placeholder and is never used for deletes. Attachment parts include
  Content-Type `name=` for BODYSTRUCTURE so MUAs recognize PDFs without an Open With
  prompt. IMAP FETCH serves base64 wire bytes (never cte=binary, which strips CR from
  PDFs). Every other write -- any other flag,
  mailbox create/rename/delete -- is refused cleanly (tagged `NO`).
- **`APPEND` is accepted as a no-op for Sent and Drafts.** A mail client copies its own sent message
  into `Sent` after submission; the Postern submission path already records the
  outbound message in the store, so the proxy acknowledges the `APPEND` (it never
  fails the client) and does NOT double-store. The sent mail appears once, via the
  store, on the next `SELECT`. Apple Mail auto-saves mid-compose into `Drafts`;
  Postern acknowledges that APPEND so the client keeps its local draft without an
  error dialog. Drafts has no server-side store and remains empty after reconnect.
  `SUBSCRIBE`/`UNSUBSCRIBE` are likewise accepted.
- **Mailboxes with RFC 6154 special-use attributes**, so a real client
  (Thunderbird) auto-maps its folders and never tries to CREATE them. `INBOX`,
  `Sent`, and `All` are direction-filtered views over the one store; the rest are
  present-but-empty placeholders (no backing state in v1, no API hit):
  - `INBOX` -> inbound mail
  - `Sent` (`\Sent`) -> outbound mail (the stored sent copies)
  - `All` (`\All`) -> both directions
  - `Drafts` (`\Drafts`), `Trash` (`\Trash`), `Junk` (`\Junk`), `Archive` (`\Archive`) -> empty placeholders
- **Zero new state.** The proxy owns no database; it reads the live API per
  session with the caller's own token.

## Auth model (#32, expanded for #77)

A normal mail client uses ONE username+password for BOTH doors: IMAP to receive
and SMTP to send. The SMTP relay (`relay/`) authenticates that credential three
ways via a pluggable `AuthProvider`; the IMAP proxy mirrors the same backends so
**one credential opens both doors**. Pick the backend with
`POSTERN_IMAP_AUTH_MODE`:

| mode | IMAP username | IMAP password | what the proxy holds | mirrors relay |
|---|---|---|---|---|
| `token` (default) | a free label (use the mailbox address) | **the Postern API token** | nothing | -- |
| `fixed` | a configured username | a configured password | the API token (`POSTERN_API_TOKEN`) | -- |
| `native` | the mailbox address | the user's SMTP secret | a per-function service token + the transport token | `AUTH_BACKEND=native` |
| `ldap` | the directory login | the directory password | a per-function service token (direct-bind: NO directory secret) | `AUTH_BACKEND=ldap` |
| `system` | a local Unix user | the Unix password | a per-function service token | `AUTH_BACKEND=system` |

- **`token` mode** stores no secret in the proxy and validates the token *live*
  against the API at login. BYO-token / no-lock-in default; the user pastes the
  64-char token as their "password", which some mail clients dislike.
- **`fixed` mode** is the convenience path for a one-person self-host: put the API
  token in the proxy env, pick a normal password. Comparisons are constant-time.
- **`native` / `ldap` / `system`** authenticate the **user** (against the worker
  `POST /api/smtp-auth`, an LDAP bind over TLS, or local PAM), then the proxy reads
  the store with a **per-function service token** it holds (`POSTERN_API_TOKEN`).
  These two steps are deliberately separate: authenticate-the-user, then
  act-on-the-store-with-the-service-token. This is a **posture shift** -- in
  `token` mode the proxy holds no secret; in these modes it holds a service token.
  See the operator deploy runbook (maintained out-of-tree) for exactly what
  secret is held in each mode, by function, and where it is stored.

`native` is stdlib-only (urllib). `ldap` needs the pure-Python `ldap3`
(`pip install -e '.[ldap]'`) and `system` needs `python-pam`
(`pip install -e '.[pam]'`); both are imported lazily, so the default install
stays dependency-light. No token or password is ever logged.

Run the proxy **behind TLS or on loopback** (the password is a real credential):
set `POSTERN_IMAP_TLS_CERT`/`POSTERN_IMAP_TLS_KEY`, or front a loopback listener
with stunnel. When TLS is enabled the listener enforces a **TLS 1.2 minimum** (the
deprecated TLS 1.0/1.1 are never offered, mirroring the SMTP relay; #106). By
default it binds `127.0.0.1:1143`. Exposing **993 (IMAPS)** is gated -- see the
operator deploy runbook (out-of-tree).

## Configuration

All config is environment-driven (no flags), so it drops into a systemd
`EnvironmentFile` or a container. See [`.env.example`](.env.example).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `POSTERN_API_URL` | yes | -- | Postern mailbox API origin, e.g. `https://postern.example` |
| `POSTERN_IMAP_AUTH_MODE` | no | `token` | `token`, `fixed`, `native`, `ldap`, or `system` (`pam` aliases `system`) |
| `POSTERN_API_TOKEN` | in `fixed`/`native`/`ldap`/`system` | -- | the token the proxy presents: the login token in `fixed`, the per-function **service** token in `native`/`ldap`/`system` |
| `POSTERN_API_TOKEN_DELETE` | no | -- | optional `both`-scoped member for EXPUNGE only (#278); separate from the read token |
| `POSTERN_API_TOKEN_IMAP` | in `per_account` with role queues | -- | `imap`-scoped service token (#352) for durable Drafts / APPEND import AND the role-membership read (#438); own worker slot, unset = those writes refuse and NO role queue is served |
| `POSTERN_IMAP_USERNAME` | in `fixed` | -- | the login username in `fixed` mode |
| `POSTERN_TRANSPORT_TOKEN` | in `native` | -- | transport-seam bearer for `POST /api/smtp-auth` (mirrors the relay) |
| `POSTERN_SMTP_AUTH_URL` | no | `${POSTERN_API_URL}/api/smtp-auth` | the `native` auth endpoint |
| `LDAP_URL` | in `ldap` | -- | `ldaps://host:636` (preferred) or `ldap://host:389` |
| `LDAP_STARTTLS` | no | `false` | upgrade an `ldap://` connection before binding |
| `LDAP_BIND_DN_TEMPLATE` | in `ldap` | -- | direct-bind DN template, e.g. `cn=%s,ou=users,dc=ex,dc=com`. Direct-bind + self-read is the ONLY bind mode (#182, byte-symmetric with the relay); the search+bind vars (`LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_SEARCH_*`) are retired and refuse startup |
| `LDAP_REQUIRE_GROUP` | no | -- | group DN the bound user must carry in `LDAP_GROUP_ATTR` on a self-read of their own entry (the mail-users authz gate; FAIL-CLOSED). Empty = no gate |
| `LDAP_GROUP_ATTR` | no | `memberOf` | the attribute listing the user's groups for the gate |
| `LDAP_TLS_CA` | no | -- | PEM CA path: full verification with this as the ONLY trust anchor (#153). Mutually exclusive with the pin |
| `LDAP_TLS_SERVER_NAME` | no | -- | extra accepted certificate name when `LDAP_URL` dials an IP (CA mode) |
| `LDAP_TLS_PIN_SHA256` | no | -- | exact-leaf SHA-256 pin (hex, colons optional; non-secret), checked BEFORE any credential flows (#153). Neither trust knob set = the directory channel is encrypted but UNAUTHENTICATED and the proxy logs a loud startup warning |
| `LDAP_TIMEOUT` | no | `10` | seconds bounding LDAP connect + bind/search (0 = none); matches the Go relay knob 1:1 |
| `AUTH_SYSTEM_PAM_SERVICE` | no | `postern` | PAM service name for `system` mode |
| `AUTH_SYSTEM_DOMAIN` | no | -- | optional display suffix for `system` logins |
| `POSTERN_IMAP_HOST` | no | `127.0.0.1` | listen interface |
| `POSTERN_IMAP_PORT` | no | `1143` | listen port |
| `POSTERN_IMAP_TLS_CERT` | no | -- | PEM cert path (set with key for IMAPS; listener enforces TLS 1.2+) |
| `POSTERN_IMAP_TLS_KEY` | no | -- | PEM key path |
| `POSTERN_API_TIMEOUT` | no | `5` | per-request timeout to the API, seconds. Lowered from 15 on MEASUREMENT (#458, numbers below); must be `> 0` (a `0` makes every socket non-blocking, so the door refuses to start with it) |
| `POSTERN_API_BREAKER_ENABLED` | no | `true` | master switch for the Worker circuit breaker (#458) |
| `POSTERN_API_BREAKER_THRESHOLD` | no | `5` | CONSECUTIVE transport failures (timeouts / refused / reset -- never an HTTP status) before the circuit opens. `0` disables the breaker |
| `POSTERN_API_BREAKER_COOLDOWN_SECONDS` | no | `30` | how long an open circuit fails fast before admitting ONE probe call. `0` disables the breaker |
| `POSTERN_IMAP_POOL_LOG_SECONDS` | no | `60` | minimum seconds between "reactor threadpool saturated" log lines (#458). Log rate only; never changes dispatch |
| `AUTH_THROTTLE_ENABLED` | no | `true` | master switch for the auth brute-force throttle (#105) |
| `AUTH_THROTTLE_MAX_FAILURES` | no | `5` | consecutive failures per key before lockout. Key = the account in `native`/`ldap`/`system`; in `token`/`fixed` the key is the client SOURCE IP (the username there is attacker-chosen free text, #183) |
| `AUTH_THROTTLE_LOCKOUT_SECONDS` | no | `60` | base lockout; doubles per failure past the threshold |
| `AUTH_THROTTLE_MAX_LOCKOUT_SECONDS` | no | `900` | per-account backoff cap |
| `AUTH_THROTTLE_GLOBAL_MAX_FAILURES` | no | `100` | aggregate failures/window before a global cooldown (0 = off) |
| `AUTH_THROTTLE_GLOBAL_WINDOW_SECONDS` | no | `60` | aggregate window + global cooldown |
| `POSTERN_IMAP_WINDOW` | no | `500` | cap INBOX/Sent to the most-recent N at SELECT (0 = unlimited; All is always unbounded) |
| `POSTERN_IMAP_POLL_SECONDS` | no | `30` | live-refresh interval while selected: re-poll the store and push EXISTS for new mail (0 = disable) |
| `POSTERN_IMAP_MEASURE` | no | `false` | emit additive, structured `@measure` read-path diagnostics to the log (journald); behaviour-neutral, off by default (see `MEASUREMENT.md`) |
| `POSTERN_IMAP_WIRE_TRACE` | no | `false` | log each received command line + sent response line for protocol diagnosis; LOGIN/AUTHENTICATE args redacted at capture; off by default (zero behaviour change) -- diagnostic-window use only, not a steady-state setting |
| `POSTERN_IMAP_VIEWER_MODE` | no | `estate` | `estate` = the whole shared mailbox (historical door, byte-identical). `per_account` = scope every real folder to the login's viewer address V (see below). A **view** tier, not a credential boundary (#357) |
| `POSTERN_IMAP_VIEWER_DOMAIN` | in `per_account` | -- | the mail domain V is built on: `V = localpart(login)@THIS`. REQUIRED when `per_account` (startup fails loud without it, never a silent fall-back to the estate view) |
| `POSTERN_IMAP_VIEWER_MAP` | no | -- | optional `login=addr,login2=addr2` overrides for directories where the login id is NOT the mail local part (e.g. `crockenhaus=conrad@example.org`). An override wins over the rule |
| `POSTERN_IMAP_ROLES_TTL_SECONDS` | no | `300` | how long a fetched role map is reused before the door re-reads it (#438). A REVOCATION bound, not a tuning knob: an operator removing a member from a queue waits at most this long. `0` = read once per login |
| `POSTERN_IMAP_VIEWER_ROLES` | **RETIRED** | -- | membership moved to the Worker (#438). Still set? The door REFUSES TO START and names the migration; it is never ignored |

**Role membership is configured on the WORKER, once** (`POSTERN_VIEWER_ROLES`, #438). It used to be configured here too, verbatim, and one fact configured twice drifts: whichever side was broader showed a queue to someone the other did not, which is the exact divergence #425 exists to close. The door reads the map from `GET /api/imap/roles` with its `imap`-scoped token, on the first LIST or SELECT of a session, cached for `POSTERN_IMAP_ROLES_TTL_SECONDS`.

Migrating a door that still sets `POSTERN_IMAP_VIEWER_ROLES`: move the SAME value to the Worker var, provision `POSTERN_API_TOKEN_IMAP` if it is unset, **deploy the Worker first**, then roll the door with the old var UNSET. A door still carrying it will not start, loudly and with those steps in the error, because a var that looks applied and silently does nothing is how a queue goes dark. A door rolled BEFORE the Worker gets a 404 for the map, which is fail-closed: no role folders, a loud log, mail untouched.

### Per-account view scoping (#357)

By default (`estate`) the door is one shared mailbox: every login sees the whole
estate, exactly as it always has. Set `POSTERN_IMAP_VIEWER_MODE=per_account` (with a
`POSTERN_IMAP_VIEWER_DOMAIN`) to make each login see only its own lens:

- **INBOX** = mail delivered to you that you did not send (this now includes
  same-domain sends from other people on the domain, which the estate INBOX was blind
  to, per CONTRACT 10.9).
- **Sent** = mail you sent.
- **All** = everything delivered to you, both directions, unwindowed. Your own
  external-only sends live under **Sent**, not here.
- **\Seen** is per-recipient: marking a shared message read in your INBOX does not
  mark it read for anyone else.

**This is a VIEW tier, a deterrent, NOT mail privacy.** The door still reads the store
with one estate-wide service token, so a determined login can still reach other mail
through the raw API. Per-user credential enforcement (a real privacy boundary) is
separate, later work (#351 / D-AUTH-2). It also only has teeth in the directory auth
modes (`ldap`/`native`/`system`): in `token`/`fixed` mode the username is
attacker-chosen free text, so V there is cosmetic.

Flipping a live door from `estate` to `per_account` is an operator window: folder
membership changes, so **bump `POSTERN_IMAP_UIDVALIDITY`** (RFC 3501) on the same roll
so clients discard their cached estate view and resync into the per-account view.

Projection changes that alter BODY[] bytes (including the #342 deterministic MIME
boundary renderer, and any `PROJECTION_VERSION` bump such as v2 Unicode header
encoding) also require a **UIDVALIDITY bump** on the fleet IMAP image roll so
clients drop SIZE/BODY caches that would disagree with the new projection.
Stale `messages.projected_size` rows (older `projection_version`) are ignored by
IMAP and fall back to a one-shot metadata hydrate.

### Role queues (#404)

A role address (`abuse@`, `security@`, `support@`) belongs to a FUNCTION, not a person,
so under per-account scoping it is nobody viewer address and its mail lands in NO view:
delivered, stored, searchable through the API, and invisible to every human. Conrad
ruling (2026-07-25): role mail gets its OWN FOLDER per role address, never merged into
anyone INBOX.

```
# On the DOOR: the view mode, plus the token the membership read needs (#438).
POSTERN_IMAP_VIEWER_MODE=per_account
POSTERN_IMAP_VIEWER_DOMAIN=example.org
POSTERN_API_TOKEN_IMAP=...

# On the WORKER (inbound/wrangler.jsonc vars): the membership itself, configured ONCE.
POSTERN_VIEWER_ROLES="abuse@example.org=ada@example.org+ben@example.org,security@example.org=ada@example.org"
```

Ada then sees `Roles/abuse` and `Roles/security` beside her own INBOX; Ben sees
`Roles/abuse` only; anyone else sees neither, and a SELECT of one answers exactly as it
would for a mailbox that does not exist. `Roles` itself is a `\Noselect` parent node,
so a client that discovers folders with `LIST "" "%"` still finds the hierarchy.

**The ownership model.** A viewer resolves to a SET of addresses: V (personal, from
`POSTERN_IMAP_VIEWER_DOMAIN` / `POSTERN_IMAP_VIEWER_MAP`) plus every role V is a member
of. `POSTERN_IMAP_VIEWER_MAP` stays exactly 1:1 -- one login, one personal address --
and role membership is keyed on the resolved ADDRESS, so the two compose by
construction: the login resolves to V first, then membership is looked up for V. A login
repointed by the map carries its roles with it.

- **INBOX stays personal**: `to=V`. Role mail is not merged into it.
- **`Roles/<role>`**: `to=<role address>` with `lens=inbox`, the same named
  viewer-relative view INBOX uses (CONTRACT 10.9, as amended by #403), windowed like
  INBOX. It asks for the LENS, never `direction=inbound`: `direction` is the stored
  wire fact, so filtering on it would drop the same-domain sends delivered to the
  queue (a colleague escalating to `abuse@` from inside the domain is stored
  outbound), which is the blindness class the recipient lenses exist to fix. A reply
  sent AS the queue is its own Sent copy and stays out of the folder.
- **Read state stays PER MEMBER**: a role read passes `seenFor=V`, and a `\Seen` STORE
  writes `for=V`, so "Ada read it" never renders as "the queue is handled". Shared-queue
  workflow (assignment, handled state) is deliberately NOT modeled yet.
- **A role folder is read plus `\Seen` only.** `PERMANENTFLAGS` is `\Seen`; APPEND,
  COPY/MOVE (in or out), EXPUNGE, `\Flagged` and `\Answered` are refused with a tagged
  NO, never a silent OK. Those would all write estate-wide state on behalf of every
  other member.

**Fail-closed, no exceptions.** The Worker refuses a malformed, duplicated,
self-referential or name-colliding map ENTIRE (`POSTERN_VIEWER_ROLES`: one bad entry
drops the whole map), so an unusable config reaches this door as an EMPTY map and no
queue is served -- the door inherits that refusal instead of re-deriving it. On top of
that the door refuses any response it will not build folders from (a shape it cannot
parse, or two roles colliding on one folder name), again whole-map. Every way the read
can fail -- unreachable Worker, timeout, wrong token, a Worker older than #438, an
unparseable body -- serves NO queue, says so in the log, and is retried on the next
login; a map that outlives its TTL is DROPPED rather than reused, so a removed member
loses the queue within the TTL. A login with no derivable V serves nothing at all,
roles included: membership is unanswerable without V. Estate mode never reads the map
(no viewer address to check it against); it still applies on the Worker, where webmail
reads it.

**Operator rules.**

- **Worker dependency + deploy ORDERING.** Two reasons now. Per-member read state
  needs the worker to accept `seenFor` on `GET /api/messages` and `GET /api/search`
  (it otherwise keys effective seen off `to`, i.e. the ROLE, and a member `\Seen`
  would not stick), and the worker ignores unknown query params, so an out-of-order
  deploy degrades SILENTLY to queue-level read state. Since #438 the door also READS
  membership from the worker, so a door rolled first finds no `/api/imap/roles` and
  serves no queue at all, loudly, with mail unaffected. Ship and verify the worker
  FIRST, then the door.
- **UIDVALIDITY.** Introducing role folders needs NO bump: the names are new, so no
  cached UID map can be invalidated, and existing folders are untouched. Repointing an
  existing role folder name at a different address (or renaming a local part) IS a
  bump-class change: bump `POSTERN_IMAP_UIDVALIDITY` on a stop-first roll.
- **`FILE_ALSO_UNDER` overlap.** That ingest map (CONTRACT 10.2b) adds an owner to the
  DELIVERED SET, so on a deployment running both, role mail appears in the owner INBOX
  as well as the role folder. Once a role has a folder, drop it from `FILE_ALSO_UNDER`.
- **Webmail** reads the same map from the same place (#425/#438), so the two human
  doors cannot disagree about what one person may see. `GET /api/roles` (operator
  `both` token) prints the parsed map when a membership question needs answering
  without shelling into a container.


## Run it

```bash
cd imap
python -m venv .venv && . .venv/bin/activate
pip install -e .                 # installs Twisted; pip install -e '.[dev]' adds mypy

export POSTERN_API_URL=https://postern.example
# token mode (default): no token in the proxy
python -m posternimap
```

Then point a mail client at it:

- Server: `127.0.0.1`, port `1143`, **no TLS** if loopback (or enable TLS above).
- Username: your mailbox address (any label in `token` mode).
- Password: your **Postern API token** (`token` mode), or your configured password
  (`fixed` mode).

Quick manual check with the stdlib client:

```python
import imaplib
c = imaplib.IMAP4("127.0.0.1", 1143)
c.login("agent@skyphusion.org", "<POSTERN_API_TOKEN>")
print(c.select("INBOX"))
print(c.search(None, "ALL"))
print(c.fetch(b"1", "(RFC822)"))
c.logout()
```

### Connecting an agent

An agent that already speaks the structured API does not need IMAP. The proxy
exists for IMAP-only clients; an agent points its IMAP library at the same
host/port and uses its Postern token as the password.

## Architecture

```
mail client / agent ──IMAP──► posternimap (Twisted IMAP4 server)
                                   │  reads via HTTP, Bearer token
                                   ▼
                          Postern mailbox API (/api/messages, /search, /threads)
                                   │
                          D1 + R2 + Vectorize   (proxy never touches these)
```

The code is layered so the IMAP-independent core is pure stdlib and testable
without Twisted:

| Module | Twisted? | Role |
|---|---|---|
| `client.py` | no (urllib) | HTTP client over the Postern read API |
| `rfc822.py` | no (email) | render a stored Message -> RFC822 bytes |
| `config.py` | no | env-driven `Config` |
| `auth.py` | core no / portal yes | `resolve_token` (#32/#77) + the native/ldap/pam backends + the Twisted cred portal |
| `message.py` | yes | `IMessage`/`IMessagePart` over a rendered message |
| `mailbox.py` | yes | `IMailbox` (snapshot, fetch, status, `\Seen`, delete/EXPUNGE) |
| `account.py` | yes | `IAccount`: the special-use mailbox set (INBOX/Sent/All + empty Drafts/Trash/Junk/Archive), Sent/Drafts APPEND no-op |
| `server.py` | yes | the `IMAP4Server` factory + reactor wiring |
| `__main__.py` | -- | `python -m posternimap` entrypoint |

## Concurrency (#416, #457, #458)

Worker calls run in the reactor threadpool, not on the reactor thread. Before this, one
slow worker call stalled EVERY connected client for the duration of the call, and
`api_timeout` defaults to 15s, so the worst case was a fifteen-second freeze of the whole
door. Numbers, method and the re-runnable scripts: `imap/bench/`.

- `threaded.py` holds the two Twisted-facing shells (`ThreadedAccount`, `ThreadedMailbox`).
  They are installed ONCE, in the realm; the account and mailbox stay plain synchronous
  objects that their own suites drive directly.
- Only the seams Twisted invokes through `maybeDeferred` can answer with a Deferred
  (select, listMailboxes, requestStatus, fetch, search, store, expunge, addMessage,
  authenticateLogin). The synchronous IMailbox accessors cannot, so `select` PRELOADS the
  mailbox inside the pool and they become memory reads.
- The transport keeps one keep-alive connection PER THREAD (`threading.local`). Sharing
  one connection across threads corrupts it; a mutex would have serialized every door
  call behind the slowest one. Both measured.
- The pool is bounded by the reactor threadpool default (10 threads), so a hung worker
  consumes at most ten threads.
- FETCH rendering was the last thing left on the reactor thread, and #457 closed it.
  Twisted renders a FETCH by calling `IMessage` accessors straight from the protocol,
  with no Deferred seam, so a body hydration inside it froze the door once per rendered
  message: a `FETCH 1:10` against a 200ms worker froze every other client for 2405ms of
  a 2399ms command, in ten separate stalls. `do_FETCH` now PRE-RUNS the accessor reads
  the render is about to make (`fetchwarm.fetch_reads` -> `PosternIMAPMessage.prehydrate`)
  inside the pool, so the render reads memory. Twisted's rendering path is untouched.
- Lazy hydration is preserved, not traded away. The warm derives its reads from the
  query and each message applies its OWN summary-versus-body rules to them, so a scan
  still fetches no body (#102) and `BODY[i]` still pulls one attachment, not all of them
  (#342). A query needing nothing from the worker (`FETCH UID FLAGS`) produces no reads
  and skips the pool hop entirely.
- The warm is invisible by construction: it can move where a wait happens, never what a
  FETCH answers. It swallows its own failures, and hydration errors are MEMOIZED on the
  message, so the render re-raises the identical error without a second worker call.
- The warm for one FETCH runs SERIALLY in ONE pool thread, for the whole message range,
  rather than fanning each message out across the pool. Deliberate: fanning out would
  make a single client fetching a large range consume most of the ten available threads
  and starve everyone else, which is the fairness problem #416 set out to fix, moved one
  level down. A client still waits for its own fetch, and only for its own.
- `test_reactor_nonblocking.py` asserts ZERO reactor-thread worker calls across every
  FETCH shape a real client sends, and pins #102 and #342 alongside, so a warm that
  bought its speed by over-fetching fails too.

### Timeout, circuit breaker, and the saturation signal (#458)

Moving the calls off the reactor thread removed the whole-door stall; it did not change
what a dead Worker COSTS. Each call still paid a full `api_timeout`, per command, from
every connected client, and each of those waits held one of the ten pool threads. Ten
stalled threads is the pool exhausted, and the eleventh command queued behind them with
nothing in the log saying why. Three changes, in that order:

**1. `POSTERN_API_TIMEOUT` is 5s, not 15s.** Chosen from 680 live calls against the
production Worker over a ten-minute window, made in the door's own call mix and through
the door's own transport shape (keep-alive `http.client`, same UA, Bearer auth):

| call | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `GET /api/messages?limit=50` (warm) | 200 | 372ms | 485ms | 598ms | 626ms |
| `GET /api/messages?limit=1` (warm) | 200 | 307ms | 350ms | 448ms | 1306ms |
| `GET /api/messages/{id}` | 80 | 317ms | 344ms | 424ms | 424ms |
| `GET /api/search` | 80 | 287ms | 320ms | 446ms | 446ms |
| `GET /api/folders` | 80 | 2222ms | 2358ms | 2697ms | 2697ms |
| `GET /api/messages?limit=50` (cold connection) | 40 | 415ms | 592ms | 673ms | 673ms |

`/api/folders` is the one class that sets the floor: it is an order of magnitude slower
than everything else the door calls, and very stable (max/p50 = 1.21, essentially no
tail). 5s is therefore about 2.2x its slowest observed call and about 8x the p99 of
every other class. A timeout that fires on a healthy-but-slow call is a self-inflicted
outage, so the margin is deliberate -- but a caller now waits five seconds for a dead
Worker, not fifteen.

**2. A circuit breaker on the Worker endpoint** (`breaker.py`). After
`POSTERN_API_BREAKER_THRESHOLD` CONSECUTIVE transport failures the door stops dialing
for `POSTERN_API_BREAKER_COOLDOWN_SECONDS`, then admits exactly ONE probe: success
closes the circuit, failure re-opens it. Open and close transitions are logged.

- It counts TRANSPORT failures only: timeouts, refused connections, reset sockets. An
  HTTP status is the Worker ANSWERING. A 4xx is a refusal (taking a mailbox offline
  because a token lost a scope would be absurd), and a 5xx -- including a Cloudflare
  edge 5xx while the Worker is down -- arrives in milliseconds, so there is no timeout
  to save. Any response at all resets the counter.
- It FAILS CLOSED. An open circuit makes the call raise, exactly like a timeout does, so
  the door answers the same honest tagged NO it already gives for an unreachable Worker.
  It never answers an empty mailbox: an empty INBOX because a breaker is open is the
  #404 / #416 failure class, and `test_breaker.py` pins it at the mailbox layer AND over
  the wire (SELECT INBOX with the circuit open answers `NO [UNAVAILABLE]` and dials
  nothing).
- The breaker is per ENDPOINT and process-wide, because the account mints a fresh client
  per mailbox and per session; a per-client breaker would count to N in each and never
  trip.
- The defaults are deliberately conservative. Five consecutive failures with not one
  successful call in between, each having burned a 5s timeout or failed to connect, is
  roughly 25 seconds of a door that cannot reach the Worker at all -- not jitter. A
  mis-tuned breaker that opens on normal variance is worse than no breaker, which is
  also why `POSTERN_API_BREAKER_THRESHOLD=0` (off) is a supported setting.

**3. Pool exhaustion is a log line, not an inference.** Every dispatch observes the
reactor threadpool, and the first dispatch that finds every thread busy logs
`reactor threadpool SATURATED: 10/10 threads busy`. Repeats are rate-limited to one line
per `POSTERN_IMAP_POOL_LOG_SECONDS` and carry the number of dispatches that queued in
between, and recovery logs once with what the episode cost. The watch never decides
anything: a failure inside it cannot stop a dispatch (pinned by a test).

## Tests

```bash
cd imap
python -m unittest discover -s posternimap/tests   # pure layers (no Twisted needed)
python -m twisted.trial posternimap.tests          # all of it, incl. the e2e server
python -m mypy                                      # the type gate (house style)
```

The pure tests (client, rfc822, config, auth) run on stdlib alone. The Twisted
tests (mailbox/account adapters and a full LOGIN->LIST->SELECT->FETCH->SEARCH
round-trip against the real `IMAP4Server` driven by Twisted's `IMAP4Client`) skip
cleanly if Twisted is not installed. The Postern API is faked via the client's
injectable transport, so no network is touched.

## Known limitations (v1, by design)

- **Read-only, except the `\Seen` flag.** Read/unread state is persisted (a `STORE`
  of `\Seen` round-trips to `POST /api/messages/seen`); every other write is refused.
  Sending is the structured API's job.
- **APPEND is accepted only where it is safe or required for client compatibility.** INBOX/Sent/All accept a client's
  APPEND as a no-op (the store is the source of truth; a post-send Sent copy is
  already persisted). Drafts also accepts APPEND as a no-op because Apple Mail
  auto-saves while composing; the draft stays client-local and is not available
  from another device. The remaining placeholder folders (Trash/Junk/Archive/Notes)
  have no backing store, so they REJECT APPEND with a tagged NO (#109).
- **UIDs are an interim ordinal over the date-ordered snapshot**, with a constant
  `UIDVALIDITY`. This preserves a client cache across reconnects in the common
  case, but per RFC 3501 it is NOT a true UID: it shifts (silently, under constant
  `UIDVALIDITY`) on a deletion OR a backdated arrival (a new message with an old
  `Date` inserts mid-order). The conformant fix is an arrival-order monotonic
  insertion key as the UID, exposed by #103 and consumed in a follow-up; if a shift
  is ever observed before then we bump `UIDVALIDITY` rather than let UIDs move
  silently.
- **Attachments are inlined over IMAP.** When a message is opened, the proxy fetches
  attachment bytes from `GET /api/messages/{id}/attachments/{i}` and projects them as
  MIME parts in a `multipart/mixed` message, so MUAs (Thunderbird, Apple Mail, etc.)
  can download attachments normally. If bytes cannot be fetched, the body falls back
  to a short note pointing at the Postern API.
- **Live refresh / IDLE.** While a mailbox is selected the proxy polls the store
  (`POSTERN_IMAP_POLL_SECONDS`, summary-only, recent end only) and pushes an
  untagged `EXISTS` when new mail arrives, so MUAs and `IDLE` see new mail
  mid-session. `\Recent` is still not tracked, but `\Seen` (read/unread) IS now
  persisted server-side (see "Read-only store" above), so new mail shows as unread
  and stays that way until read -- `\Recent` is no longer load-bearing for "what is
  new".
- **Windowing.** INBOX/Sent show the most-recent `POSTERN_IMAP_WINDOW` messages at
  `SELECT` (the `All` folder is unbounded for archival access). IMAP cannot grow a
  folder downward mid-session, so older mail is reached via `All` or a larger
  window rather than in-folder scroll-back.
- **ENVELOPE is served from the list response.** A header/ENVELOPE scan never
  fetches a body; the per-message body GET happens only when a message is opened
  (or `RFC822.SIZE` is requested), so a large shared mailbox stays snappy.

## Production deploy

The generic self-host path is covered above (Configuration + Run it) and the unit
ships at [`systemd/postern-imap.service`](systemd/postern-imap.service).
Internal/production deploy runbooks are maintained out-of-tree in the operator
private infrastructure repository; this README covers the generic self-host path.

**Apple Mail / operator handoff:** [`docs/IMAP-APPLE-MAIL.md`](../docs/IMAP-APPLE-MAIL.md).
