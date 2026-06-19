# postern

Email, for humans and agents, introducing Postern, emails sent through
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/).

Three components in one repo:

- **`worker/`**: a Cloudflare Worker that actually sends mail (from
  `@skyphusion.org`). It exposes an RPC entrypoint for same-account Workers and
  a token-gated public `POST /send` endpoint for everything else. It also has an
  `email()` handler that forwards inbound Email Routing mail to `FORWARD_TO`.
- **`relay/`**: a small Go SMTP daemon for `dischord`. Local services that
  can only speak SMTP hand it a message; it parses the MIME and relays it to the
  worker's public endpoint over HTTPS.
- **`inbound/`**: a separate Cloudflare Worker that ingests inbound mail via
  Email Routing: it forwards to `FORWARD_TO`, then parses and stores the message
  in D1 (full-text search), R2 (attachments), and Vectorize (embeddings for RAG).

```
skyphusion-llm-public ──(service binding RPC: env.EMAIL.send)──┐
                                                               ├──► worker ──► CF Email Sending ──► inbox
dischord services ──SMTP──► relay ──(HTTPS + Bearer token)────┘
   (cron, scripts,           (127.0.0.1:2525,
    backups, etc.)            systemd on the box)
```

Why the split: same-account Workers get a typed, tokenless, no-network-hop RPC
call. Anything that can't be a Worker (cron jobs, shell scripts, backup tooling
on dischord) speaks plain SMTP to a localhost relay and never has to learn the
HTTP API.

## Worker

### Prerequisites (once)

The sending domain must be onboarded to Email Sending (SPF/DKIM/bounce records
in Cloudflare DNS). Both `skyphusion.org` and `skyphusion.net` are already
onboarded (`enabled = yes`). To onboard another domain, use the Dashboard
(Compute & AI > Email Service > Email Sending > Onboard Domain), then confirm:

```bash
cd worker
npx wrangler email sending list                 # confirm enabled=yes
```

### Deploy

```bash
cd worker
npm install
npx wrangler secret put RELAY_TOKEN     # shared secret for the public endpoint
npm run deploy
```

`DEFAULT_FROM`, `DEFAULT_FROM_NAME`, and `ALLOWED_FROM_DOMAIN` are plain vars in
`wrangler.jsonc`. `RELAY_TOKEN` is a secret and is never committed.

Generate a strong token with `openssl rand -hex 32`. The same value goes into
the relay's `EMAIL_RELAY_TOKEN` (see below).

### Endpoints

- `GET /` or `/health`: liveness, no auth.
- `POST /send`: send mail. Requires `Authorization: Bearer <RELAY_TOKEN>`.

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the service binding setup,
the request schema, and response/error codes.

## Relay (dischord)

Go is not on the laptop; build on `dischord` (or any box with Go >= 1.22):

```bash
cd relay
go mod tidy          # resolves go.sum on first build
go build -o skyphusion-email-relay .
```

Install:

```bash
sudo install -m 0755 skyphusion-email-relay /usr/local/bin/
sudo install -m 0600 skyphusion-email-relay.env.example /etc/skyphusion-email-relay.env
sudoedit /etc/skyphusion-email-relay.env        # set EMAIL_WORKER_URL + EMAIL_RELAY_TOKEN
sudo install -m 0644 systemd/skyphusion-email-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skyphusion-email-relay
```

Point local services at `127.0.0.1:2525` (no auth, loopback only). Examples:

```bash
# msmtp / sendmail-style tools: set host=127.0.0.1 port=2525, no TLS, no auth.
# Quick test with swaks:
swaks --server 127.0.0.1:2525 --from cron@skyphusion.org \
      --to you@example.com --header "Subject: relay test" --body "hello from dischord"
```

The relay uses the envelope `RCPT TO` for recipients. If a message's `From`
isn't on `skyphusion.org` (e.g. `root@dischord`), the relay rewrites it to
`DEFAULT_FROM` and preserves the original as `Reply-To`, because the worker only
accepts senders on the allowed domain.

## Layout

```
worker/
  src/index.ts   RPC entrypoint (EmailService) + public fetch handler
  src/email.ts   validation + the actual env.EMAIL.send() call
  src/env.d.ts   binding/var types
  wrangler.jsonc send_email binding + vars
relay/
  main.go        entrypoint
  config.go      env-driven config
  smtp.go        go-smtp backend, MIME parse, payload build
  client.go      HTTPS POST to the worker
  systemd/       service unit
inbound/
  src/index.ts   Email Routing handler: forward + parse + store (D1/R2/Vectorize)
  schema.sql     D1 schema (messages, attachments, FTS5)
  wrangler.jsonc bindings (DB, ATTACHMENTS, VECTORIZE, AI) + vars
docs/
  INTEGRATION.md caller setup (service binding + REST)
```

## CI / deploy

A Jenkins multibranch job (`skyphusion-email` on dischord, mirroring
`skyphusion-ci`) builds every branch and PR: it typechecks the worker and
`go vet` + builds the relay. Every green build on `main` auto-deploys the
worker via `wrangler deploy` (using the `CLOUDFLARE_API_TOKEN` Jenkins
credential; the worker holds no in-tree secrets, and `RELAY_TOKEN` is a Worker
secret untouched by deploy). So a plain `git push origin main` ships the worker,
no manual deploy needed. A GitHub push webhook triggers builds immediately, with
a 4h periodic scan as fallback.

The relay is **not** auto-deployed; rebuild and reinstall it on dischord when
`relay/` changes (see the Relay section above).

## Conventions

Account handle is `skyphusion`. No em/en-dashes in source, commits, or docs.
Commits use conventional-commits (`feat(worker): ...`, `fix(relay): ...`).
