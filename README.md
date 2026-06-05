# skyphusion-email

Transactional email for the Skyphusion / Vivijure stack, sent through
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/).

Two components in one repo:

- **`worker/`** — a Cloudflare Worker that actually sends mail (from
  `@skyphusion.org`). It exposes an RPC entrypoint for same-account Workers and
  a token-gated public `POST /send` endpoint for everything else.
- **`relay/`** — a small Go SMTP daemon for `mindcrime-ci`. Local services that
  can only speak SMTP hand it a message; it parses the MIME and relays it to the
  worker's public endpoint over HTTPS.

```
skyphusion-llm-public ──(service binding RPC: env.EMAIL.send)──┐
                                                               ├──► worker ──► CF Email Sending ──► inbox
mindcrime services ──SMTP──► relay ──(HTTPS + Bearer token)────┘
   (cron, scripts,           (127.0.0.1:2525,
    backups, etc.)            systemd on the box)
```

Why the split: same-account Workers get a typed, tokenless, no-network-hop RPC
call. Anything that can't be a Worker (cron jobs, shell scripts, backup tooling
on mindcrime) speaks plain SMTP to a localhost relay and never has to learn the
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

- `GET /` or `/health` — liveness, no auth.
- `POST /send` — send mail. Requires `Authorization: Bearer <RELAY_TOKEN>`.

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the service binding setup,
the request schema, and response/error codes.

## Relay (mindcrime-ci)

Go is not on the laptop; build on `mindcrime` (or any box with Go >= 1.22):

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
      --to you@example.com --header "Subject: relay test" --body "hello from mindcrime"
```

The relay uses the envelope `RCPT TO` for recipients. If a message's `From`
isn't on `skyphusion.org` (e.g. `root@mindcrime`), the relay rewrites it to
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
docs/
  INTEGRATION.md caller setup (service binding + REST)
```

## Conventions

Account handle is `skyphusion`. No em/en-dashes in source, commits, or docs.
Commits use conventional-commits (`feat(worker): ...`, `fix(relay): ...`).
