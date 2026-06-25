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

- **Read-only.** `LOGIN`, `LIST`, `SELECT`/`EXAMINE`, `FETCH`, `SEARCH`, `LOGOUT`.
  You read mail here; you **send** through the structured API (`POST /api/send` /
  `/api/reply`) or a future webmail, not by IMAP `APPEND`. Every write op
  (`STORE`/`EXPUNGE`/`APPEND`/mailbox create/delete) is refused cleanly rather
  than silently dropping data.
- **Three mailboxes over the one store**, all direction-filtered views:
  - `INBOX` -> inbound mail
  - `Sent` -> outbound mail (the stored sent copies)
  - `All` -> both directions
- **Zero new state.** The proxy owns no database; it reads the live API per
  session with the caller's own token.

## Auth model (#32)

Postern is gated by a single high-entropy Bearer token (`POSTERN_API_TOKEN`);
scoped / multi-tokens are explicitly post-v1. So an IMAP login has to resolve to a
Postern API token. Two modes (`POSTERN_IMAP_AUTH_MODE`):

| mode | IMAP username | IMAP password | who holds the token |
|---|---|---|---|
| `token` (default) | a free label (use the mailbox address) | **the Postern API token** | nobody; each session carries the user's own token |
| `fixed` | a configured username | a configured password | the proxy (`POSTERN_API_TOKEN` in its env) |

- **`token` mode** stores no secret in the proxy and validates the token *live*
  against the API at login (a bad token fails). It is the BYO-token / no-lock-in
  default and the honest mapping onto Postern's single-token reality. The downside
  is that the user pastes a 64-char token as their "password", which some mail
  clients dislike.
- **`fixed` mode** is the convenience path for a one-person self-host: put the API
  token in the proxy env, pick a normal password, and Thunderbird/mutt log in with
  username + password. Comparisons are constant-time.

The token is never logged. Run the proxy **behind TLS or on loopback** (the
password is a real credential): set `POSTERN_IMAP_TLS_CERT`/`POSTERN_IMAP_TLS_KEY`,
or front a loopback listener with stunnel. By default it binds `127.0.0.1:1143`.

## Configuration

All config is environment-driven (no flags), so it drops into a systemd
`EnvironmentFile` or a container. See [`.env.example`](.env.example).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `POSTERN_API_URL` | yes | -- | Postern mailbox API origin, e.g. `https://postern.example` |
| `POSTERN_IMAP_AUTH_MODE` | no | `token` | `token` or `fixed` |
| `POSTERN_API_TOKEN` | in `fixed` | -- | the Postern API token (secret) the proxy presents in `fixed` mode |
| `POSTERN_IMAP_USERNAME` | in `fixed` | -- | the login username in `fixed` mode |
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
| `auth.py` | core no / portal yes | `resolve_token` (#32) + the Twisted cred portal |
| `message.py` | yes | `IMessage`/`IMessagePart` over a rendered message |
| `mailbox.py` | yes | read-only `IMailbox` (snapshot, fetch, status) |
| `account.py` | yes | `IAccount` exposing INBOX / Sent / All |
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
