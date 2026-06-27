# postern relay

The Go transport bridge for Postern. It is **dependency-free** by contract
(`go-smtp` + `enmime` only, plus the standard library) and implements the two
transport seams from [`docs/CONTRACT.md`](../docs/CONTRACT.md): inbound `ingest`
(section 2) and outbound `dispatch` (section 3). Cloudflare Email is the default
transport on each seam; this relay is the bring-your-own-SMTP alternative that
plugs into the same shapes without touching the store or the API.

```
                              INBOUND  (CONTRACT section 2)
 local services ──SMTP──► relay ──ParsedInbound (HTTPS + transport token)──► core POST /ingest
 (cron, backups, Kuma)         (builds ParsedInbound from the parsed MIME;
                                attachments base64 over JSON)

                              OUTBOUND (CONTRACT section 3)
 core RelayTransport ──OutboundMessage (HTTPS + transport token)──► relay POST /dispatch
                                                                       │
                                                          BYO upstream SMTP (STARTTLS + PLAIN)
                                                                       ▼
                                                                  recipient MX
```

Both seams are gated by `POSTERN_TRANSPORT_TOKEN`, the **transport** token, never
the mailbox API token (`POSTERN_API_TOKEN`). Transports are infrastructure, not
API clients: a leak of one credential cannot compromise the other (CONTRACT
sections 5 and 8). The bearer compare on `/dispatch` is constant-time.

## Inbound: SMTP -> `ParsedInbound` -> `POST /ingest`

The SMTP `DATA` handler parses the MIME with `enmime`, normalizes it into a
`ParsedInbound` (`ingest.go`), and POSTs it to `POSTERN_INGEST_URL`:

- recipient (`to`) is the **first envelope RCPT TO** (the real delivered-to), not
  a header;
- `from` prefers the header From, falling back to the envelope MAIL FROM;
- `messageId`, `inReplyTo`, `references` are angle-stripped; `date` is normalized
  to ISO 8601 (empty when missing, so core defaults to now);
- attachment bytes are **base64-encoded** into `attachments[].content` (the
  locked v1 decision: bytes over JSON);
- the relay supplies **no** auth verdicts (`auth` is omitted), because plain SMTP
  carries none; core applies its allowlist-only trust path for stripped intake.

Forwarding (`FORWARD_TO` / `FORWARD_FOR`) is **not** the relay's job: that lives
in the in-Worker `email()` driver, which has the live `message.forward()`.

### Legacy fallback

If `POSTERN_INGEST_URL` is unset, the relay falls back to the pre-M3 behavior:
post an `EmailPayload` to the worker `/send` endpoint with `EMAIL_RELAY_TOKEN`,
rewriting off-domain `From` to `DEFAULT_FROM` (the worker only accepts
`FROM_DOMAIN`). Existing deployments keep working through the rename.

## Outbound: `POST /dispatch` -> BYO-SMTP

Enable the bridge by setting `POSTERN_RELAY_HTTP_LISTEN` (+ `SMTP_OUT_HOST`).
Core's `RelayTransport` (selected by `OUTBOUND_TRANSPORT=relay`) POSTs an
`OutboundMessage` to `/dispatch`; the relay renders it to RFC 5322 and sends it
through the configured upstream SMTP server (`smtp_transport.go`):

- `to + cc + bcc` become the envelope RCPT TO (de-duplicated, order preserved);
- **BCC is envelope-only**, never written as a header;
- text-only -> `text/plain`; html-only -> `text/html`; both ->
  `multipart/alternative`; bodies are quoted-printable;
- reply threading headers (`In-Reply-To` / `References`) ride in `headers`;
- all header values are **CR/LF-sanitized** (no header injection), and any
  caller header that collides with a reserved name is dropped.

Leave `POSTERN_RELAY_HTTP_LISTEN` unset to run inbound-only.

## Submission: authenticated SMTP for clients -> `POST /api/send` (#68)

The third seam: authenticated SMTP **submission** so a normal IMAP client
(Thunderbird / Apple Mail / mobile) can send AS your own domain. Workers cannot
listen on submission ports, so it lives here. It is fully domain-agnostic and
self-hostable from a fresh clone.

```
 IMAP client ──TLS (STARTTLS or implicit)──► relay submission daemon
   │ AUTH PLAIN/LOGIN (only after TLS)            │
   │                                   AuthProvider backend (native | ldap | system)
   │                                              ▼
   │                                  resolve the bound identity (your address)
   │ MAIL/RCPT/DATA (MIME)                        │
   ▼ enforce From == bound identity               ▼
 relay ──POST /api/send (mailbox API token)──► worker: DKIM-sign + send + store ─► MX
```

### Listeners (arbitrary, configurable)

Set `SUBMISSION_LISTENERS` to a comma-separated list of `<addr>:<mode>` entries,
where mode is `starttls` or `implicit` and a bare port means all interfaces. This
is a LIST, not a fixed 587/465: ISPs/providers often block 25/587, so an operator
can add alternate ports (2525, 8025, anything) to route around the block.

```
SUBMISSION_LISTENERS=587:starttls,465:implicit            # canonical
SUBMISSION_LISTENERS=587:starttls,465:implicit,2525:starttls   # plus an alternate
SUBMISSION_LISTENERS=0.0.0.0:587:starttls,127.0.0.1:8025:implicit
```

AUTH is offered ONLY over TLS: the go-smtp server runs with a `TLSConfig` and
`AllowInsecureAuth=false`, so AUTH is advertised/accepted only after STARTTLS or
on an implicit-TLS connection; a cleartext `AUTH` is answered `523`. PLAIN + LOGIN
are offered (LOGIN for older clients).

### TLS cert (operator-provisioned, hot-reloaded)

`SUBMISSION_TLS_CERT` / `SUBMISSION_TLS_KEY` are PEM paths. The daemon
**hot-reloads** the cert when the file changes on disk, so a renewal takes effect
without a restart. How you OBTAIN and renew the cert is your choice; a few recipes:

- **certbot (HTTP-01)**: `certbot certonly --standalone -d smtp.your-domain`, point
  the paths at `/etc/letsencrypt/live/smtp.your-domain/{fullchain,privkey}.pem`.
- **certbot / acme.sh (DNS-01)**: useful when 80/443 are not reachable; issue via
  your DNS provider's API, same file paths.
- **commercial cert**: drop the PEM files at the configured paths.
- **self-signed** (testing only): `openssl req -x509 -newkey rsa:2048 -nodes
  -keyout key.pem -out cert.pem -days 365 -subj /CN=localhost`.

The files must be readable by the relay's user (the hardened systemd unit runs
`DynamicUser`, so world-read the PEMs or grant an ACL).

### Auth backend (`AUTH_BACKEND`: native | ldap | system)

A pluggable `AuthProvider` verifies the login and returns the bound identity; the
same From-enforcement applies to all three. Pick by `AUTH_BACKEND` (default
`native`).

- **native** (default, zero extra deps): validate at the worker `POST /api/smtp-auth`
  (the **transport** token), which checks the D1 `smtp_credentials` table (secret
  stored as a PBKDF2 hash). This is the fresh-clone quickstart; no LDAP/PAM needed.
  Set `POSTERN_SMTP_AUTH_URL` + `POSTERN_TRANSPORT_TOKEN`.
- **ldap**: simple-bind (`LDAP_BIND_DN_TEMPLATE`) or search+bind (`LDAP_BIND_DN` +
  `LDAP_SEARCH_BASE` + `LDAP_SEARCH_FILTER`) over TLS (`ldaps://` or
  `LDAP_STARTTLS=true`). Bound identity = the `LDAP_MAIL_ATTR` attribute (default
  `mail`). Pure-Go (`go-ldap`), no cgo.
- **system**: local Unix accounts via PAM. Bound identity = `<user>@AUTH_SYSTEM_DOMAIN`.
  PAM needs cgo, so this backend is **build-tagged**: the default binary is
  cgo-free and rejects `AUTH_BACKEND=system` with a clear "rebuild with -tags pam"
  error. Build it with `go build -tags pam` (needs libpam headers) and add a PAM
  service file (default `/etc/pam.d/postern`).

### Bridge to the send seam + From-enforcement

The message `From` MUST equal the bound identity (case-insensitive); a missing or
mismatched `From` is rejected `550`. The parsed MIME is mapped to a `SendRequest`
and POSTed to `/api/send` (the **mailbox API** token, carried as
`POSTERN_SEND_TOKEN`), which DKIM-signs and stores the sent copy. `to`/`cc` come
from the headers intersected with the envelope; `bcc` is the envelope remainder
(kept envelope-only); `In-Reply-To` / `References` ride along for threading.

### v1 limits (honest, not silent)

- A message with **attachments** (or inline parts) is supported (#70): the daemon
  maps the parsed MIME parts to `SendRequest.attachments` (base64 over JSON) and
  forwards them to `/api/send`, which hands them to the Cloudflare Email Sending
  binding (the binding builds the MIME, so the relay never hand-rolls one). Limits:
  20 parts and 25 MiB decoded total, else `552`. Every part is delivered with
  disposition `attachment` for v1 (rendering inline parts inline by cid is a tracked
  refinement, never a silent drop).
- A **Bcc-only** message is rejected `550` (the worker requires a `To`; the daemon
  does not rewrite the visible header). A normal client always sets a `To`.

### Provision a credential (native backend)

Operator action, gated by the mailbox API token:

```bash
curl -sS -X POST https://postern.<account>.workers.dev/api/admin/smtp-credentials \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice@your-domain"}'
# -> { "ok": true, "username": "...", "from": "...", "secret": "<give this to the user once>" }
```

The submission listeners need `CAP_NET_BIND_SERVICE` to bind privileged ports
under the hardened `DynamicUser` unit (already set in `systemd/`).

## Build, test

Go >= 1.22 (built/tested on 1.26). Dependency-free: `go mod tidy` adds nothing.

```bash
cd relay
go build -o skyphusion-email-relay .
go vet ./...
go test ./...
```

## Install (systemd)

```bash
sudo install -m 0755 skyphusion-email-relay /usr/local/bin/
sudo install -m 0600 skyphusion-email-relay.env.example /etc/skyphusion-email-relay.env
sudoedit /etc/skyphusion-email-relay.env        # set POSTERN_INGEST_URL + POSTERN_TRANSPORT_TOKEN
sudo install -m 0644 systemd/skyphusion-email-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skyphusion-email-relay
```

See `skyphusion-email-relay.env.example` for every variable. Quick inbound test:

```bash
swaks --server 127.0.0.1:2525 --from cron@skyphusion.org \
      --to you@example.com --header "Subject: relay test" --body "hello"
```

## Files

```
relay/
  main.go             entrypoint
  config.go           env-driven config + mode selection (ingest vs legacy)
  smtp.go             go-smtp backend: SMTP DATA -> ParsedInbound or legacy payload
  ingest.go           #22  ParsedInbound shape + builder (base64 attachments)
  client.go           HTTPS POST to core /ingest (or legacy worker /send)
  transport.go        #23  Transport interface + OutboundMessage + selector
  smtp_transport.go   #23  SMTPTransport: render RFC 5322 + BYO upstream SMTP send
  http.go             outbound /dispatch bridge (token-gated, constant-time)
  submission.go       #68  AUTH-over-TLS submission session -> /api/send bridge
  submit_client.go    #68  HTTPS client for /api/smtp-auth + /api/send (native)
  auth.go             #68  AuthProvider interface + backend selector
  auth_ldap.go        #68  ldap backend (go-ldap simple/search bind over TLS)
  auth_system.go      #68  system backend stub (default build; rejects without -tags pam)
  auth_system_pam.go  #68  system backend (PAM; build-tagged `pam`, cgo)
  cert.go             #68  TLS cert loader with hot-reload on renewal
  systemd/            hardened service unit
```
