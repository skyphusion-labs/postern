# postern-imap

An **IMAP proxy frontend for [Postern](../README.md)**: it serves the one Postern
mailbox over plain IMAP so a human (Thunderbird, mutt, iOS Mail, ...) or an
IMAP-speaking agent can read mail that arrived through Postern, without ever
touching D1/R2 directly.

Postern is "one mailbox reachable two ways: by agents (the structured API) and by
humans (IMAP/webmail, which are *clients* of that same API)" (see
[`docs/CONTRACT.md`](../docs/CONTRACT.md)). This proxy is exactly that human door:
it is a **client of the Postern mailbox read API** (`/api/messages`,
`/api/messages/{id}`, `/api/threads/{id}`, `/api/search`), and it renders each
stored message back into RFC822 for IMAP FETCH.

It is built on Twisted's `twisted.mail.imap4` server, per the shape Conrad sketched
in #12.

## What it does (v1)

- **Read-only store.** `LOGIN`, `LIST`/`LSUB`, `SELECT`/`EXAMINE`, `STATUS`,
  `FETCH`, `SEARCH`, `LOGOUT`. You read mail here; you **send** through the
  structured API (`POST /api/send` / `/api/reply`) or the submission server, not by
  IMAP. Destructive write ops (`STORE`/`EXPUNGE`/mailbox create/rename/delete) are
  refused cleanly rather than silently dropping data.
- **`APPEND` is accepted as a no-op.** A mail client copies its own sent message
  into `Sent` after submission; the Postern submission path already records the
  outbound message in the store, so the proxy acknowledges the `APPEND` (it never
  fails the client) and does NOT double-store. The sent mail appears once, via the
  store, on the next `SELECT`. `SUBSCRIBE`/`UNSUBSCRIBE` are likewise accepted.
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
| `ldap` | the directory login | the directory password | a per-function service token + (optional) LDAP service-account creds | `AUTH_BACKEND=ldap` |
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
  See [`DEPLOY.md`](DEPLOY.md) for exactly what secret is held in each mode, by
  function, and where it is stored.

`native` is stdlib-only (urllib). `ldap` needs the pure-Python `ldap3`
(`pip install -e '.[ldap]'`) and `system` needs `python-pam`
(`pip install -e '.[pam]'`); both are imported lazily, so the default install
stays dependency-light. No token or password is ever logged.

Run the proxy **behind TLS or on loopback** (the password is a real credential):
set `POSTERN_IMAP_TLS_CERT`/`POSTERN_IMAP_TLS_KEY`, or front a loopback listener
with stunnel. By default it binds `127.0.0.1:1143`. Exposing **993 (IMAPS)** is
gated -- see [`DEPLOY.md`](DEPLOY.md).

## Configuration

All config is environment-driven (no flags), so it drops into a systemd
`EnvironmentFile` or a container. See [`.env.example`](.env.example).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `POSTERN_API_URL` | yes | -- | Postern mailbox API origin, e.g. `https://postern.example` |
| `POSTERN_IMAP_AUTH_MODE` | no | `token` | `token`, `fixed`, `native`, `ldap`, or `system` (`pam` aliases `system`) |
| `POSTERN_API_TOKEN` | in `fixed`/`native`/`ldap`/`system` | -- | the token the proxy presents: the login token in `fixed`, the per-function **service** token in `native`/`ldap`/`system` |
| `POSTERN_IMAP_USERNAME` | in `fixed` | -- | the login username in `fixed` mode |
| `POSTERN_TRANSPORT_TOKEN` | in `native` | -- | transport-seam bearer for `POST /api/smtp-auth` (mirrors the relay) |
| `POSTERN_SMTP_AUTH_URL` | no | `${POSTERN_API_URL}/api/smtp-auth` | the `native` auth endpoint |
| `LDAP_URL` | in `ldap` | -- | `ldaps://host:636` (preferred) or `ldap://host:389` |
| `LDAP_STARTTLS` | no | `false` | upgrade an `ldap://` connection before binding |
| `LDAP_BIND_DN_TEMPLATE` | `ldap` (simple bind) | -- | e.g. `uid=%s,ou=people,dc=ex,dc=com` |
| `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD` | `ldap` (search+bind) | -- | service-account DN + password |
| `LDAP_SEARCH_BASE` / `LDAP_SEARCH_FILTER` | `ldap` (search+bind) | -- | e.g. `ou=people,dc=ex,dc=com` / `(uid=%s)` |
| `LDAP_MAIL_ATTR` | no | `mail` | directory attribute carrying the mail address |
| `AUTH_SYSTEM_PAM_SERVICE` | no | `postern` | PAM service name for `system` mode |
| `AUTH_SYSTEM_DOMAIN` | no | -- | optional display suffix for `system` logins |
| `POSTERN_IMAP_HOST` | no | `127.0.0.1` | listen interface |
| `POSTERN_IMAP_PORT` | no | `1143` | listen port |
| `POSTERN_IMAP_TLS_CERT` | no | -- | PEM cert path (set with key for IMAPS) |
| `POSTERN_IMAP_TLS_KEY` | no | -- | PEM key path |
| `POSTERN_API_TIMEOUT` | no | `15` | per-request timeout to the API, seconds |

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
| `mailbox.py` | yes | read-only `IMailbox` (snapshot, fetch, status) |
| `account.py` | yes | `IAccount`: the special-use mailbox set (INBOX/Sent/All + empty Drafts/Trash/Junk/Archive), APPEND no-op |
| `server.py` | yes | the `IMAP4Server` factory + reactor wiring |
| `__main__.py` | -- | `python -m posternimap` entrypoint |

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

- **Read-only.** Sending is the structured API's job.
- **UIDs are per-snapshot.** They are stable within a `SELECT` (the spec's hard
  requirement) but a client should resync rather than rely on them across
  reconnects. A durable `message_id -> int` map is a post-v1 enhancement.
- **Attachments are referenced, not inlined.** A FETCH body notes the attachments;
  their bytes live behind `GET /api/messages/{id}/attachments/{i}`. Inlining MIME
  parts over IMAP is a follow-up.
- **No server-pushed updates** (no `IDLE` payload / `\Recent` tracking): re-SELECT
  to see new mail.

## Production deploy (dischord)

For the self-hosted install on dischord (hardened systemd unit, loopback-only v1,
EnvironmentFile, smoke, and the gated path to public IMAPS), see
[`DEPLOY.md`](DEPLOY.md). The unit ships at
[`systemd/postern-imap.service`](systemd/postern-imap.service).
