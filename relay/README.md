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

## Submission: 587/465 + AUTH -> `POST /api/send` (#68)

The third seam: authenticated SMTP **submission** so a normal IMAP client
(Thunderbird / Apple Mail / mobile) can send AS `@skyphusion.org`. Workers cannot
listen on 587/465, so it lives here. Enable it with at least one of
`POSTERN_SUBMISSION_STARTTLS_LISTEN` (`:587`, STARTTLS) /
`POSTERN_SUBMISSION_TLS_LISTEN` (`:465`, implicit TLS).

```
 IMAP client ──587 STARTTLS / 465 TLS──► relay submission daemon
   │ AUTH PLAIN/LOGIN (only after TLS)            │
   │                          POST /api/smtp-auth (transport token)
   │                                              ▼
   │                       worker: smtp_credentials (PBKDF2) ─► {ok, from}
   │ MAIL/RCPT/DATA (MIME)                        │
   ▼ enforce From == bound identity               ▼
 relay ──POST /api/send (mailbox API token)──► worker: DKIM-sign + send + store ─► MX
```

- **AUTH only over TLS.** The go-smtp server runs with a `TLSConfig` and
  `AllowInsecureAuth=false`, so AUTH is advertised/accepted only after STARTTLS
  (587) or on the implicit-TLS connection (465); a cleartext `AUTH` is answered
  `523`. PLAIN + LOGIN are offered (LOGIN for older clients).
- **Postern-native auth, not LDAP.** Each login is validated via
  `POST /api/smtp-auth` (the **transport** token), which checks the worker's
  `smtp_credentials` table (secret stored as a PBKDF2 hash) and returns the bound
  `from`. The relay stays dependency-free; `go-sasl` is go-smtp's own AUTH API
  surface (already in `go.sum`).
- **From-enforcement.** The message `From` must equal the bound identity
  (case-insensitive); a missing or mismatched `From` is rejected `550`.
- **Bridge to the send seam.** The parsed MIME is mapped to a `SendRequest` and
  POSTed to `/api/send` (the **mailbox API** token, carried as
  `POSTERN_SEND_TOKEN`), which DKIM-signs and stores the sent copy. `to`/`cc` come
  from the headers intersected with the envelope; `bcc` is the envelope remainder
  (kept envelope-only); `In-Reply-To` / `References` ride along for threading.
- **v1 limits (honest, not silent):** a message with **attachments** is rejected
  `554` (the field-based `/api/send` carries none), and a **Bcc-only** message is
  rejected `550` (the worker requires a `To`). Both are documented follow-ups.

Unlike the loopback-only intake listener, the submission listeners are
AUTH-required, so binding them publicly (`:587` / `:465`) is correct. They need a
real TLS cert (`POSTERN_SUBMISSION_TLS_CERT` / `_KEY`) and, under the hardened
systemd unit, `CAP_NET_BIND_SERVICE` to bind the privileged ports (already set).

Provision a user credential (operator action, mailbox API token):

```bash
curl -sS -X POST https://postern.<account>.workers.dev/api/admin/smtp-credentials \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice@skyphusion.org"}'
# -> { "ok": true, "username": "...", "from": "...", "secret": "<give this to the user once>" }
```

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
  submission.go       #68  587/465 AUTH-over-TLS submission -> /api/send bridge
  submit_client.go    #68  HTTPS client for /api/smtp-auth + /api/send
  systemd/            hardened service unit
```
