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
  systemd/            hardened service unit
```
