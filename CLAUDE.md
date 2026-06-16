# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The transactional email service for the skyphusion stack: it sends mail from `@skyphusion.org`
through **Cloudflare Email Sending**. This is the skyphusion-specific deployment of the design
that also lives, generically, in the sibling `cf-email-relay` repo. Two components:

- `worker/` -- a Cloudflare Worker (TypeScript) that sends the mail via the `send_email`
  binding. Two front doors into the same `sendEmail()` core:
  - **RPC**: same-account Workers (notably `skyphusion-llm-public`) call `env.EMAIL.send({...})`
    through a service binding (typed, no token, no network hop). Class is
    `EmailService extends WorkerEntrypoint<Env>`.
  - **Public HTTPS**: `POST /send`, gated by a `RELAY_TOKEN` Bearer secret.
- `relay/` -- a Go SMTP daemon (`go-smtp` + `enmime`) that runs on **mindcrime** for services
  that can only speak SMTP (cron, scripts, backups, Jenkins failure mail). It accepts MIME on
  `127.0.0.1:2525`, parses it, and POSTs it to the worker over HTTPS.

```
skyphusion-llm-public ──(service binding RPC: env.EMAIL.send)──┐
                                                               ├──► worker ──► CF Email Sending ──► inbox
mindcrime services ──SMTP──► relay ──(HTTPS + Bearer token)────┘
   (cron, backups, CI mail)   (127.0.0.1:2525, systemd)
```

## Commands

### Worker (`worker/`, Node 22)
```bash
npm run dev          # wrangler dev (local)
npm run deploy       # wrangler deploy
npm run typecheck    # tsc --noEmit -- the CI gate; run before pushing
npm run cf-typegen   # wrangler types (regenerate Env types from wrangler.jsonc)
```
First-time secret: `npx wrangler secret put RELAY_TOKEN`. Both `skyphusion.org` and
`skyphusion.net` are already onboarded to Cloudflare Email Sending (SPF/DKIM in place).

### Relay (`relay/`, Go 1.22+)
```bash
go vet ./...                              # lint (runs in CI)
go build -o skyphusion-email-relay .      # build (runs in CI)
```
Install on mindcrime: binary to `/usr/local/bin/`, env to `/etc/skyphusion-email-relay.env`
(mode 0600, set `EMAIL_WORKER_URL` + `EMAIL_RELAY_TOKEN`), unit to `/etc/systemd/system/`, then
`systemctl enable --now skyphusion-email-relay`. See `README.md`.

There is **no automated test suite**. Verify the worker with `npm run dev` / `curl .../send`,
the relay on the box with `swaks --server 127.0.0.1:2525 ...`.

## Architecture

Both front doors funnel through one function so behavior can't drift:

- `worker/src/index.ts` -- dual entry: `EmailService` (RPC) + the `fetch` handler
  (`GET /` + `/health`, `POST /send`). `/send` does a **constant-time** Bearer-token compare
  before parsing the body. Keep it constant-time; do not replace with `===`.
- `worker/src/email.ts` -- the shared core: `EmailRequest`, `sendEmail(env, req)`, `EmailError`
  (`.code` + `.status`). Validates fields/recipients, enforces the sender domain, builds the
  `SendEmailMessage`, calls `env.EMAIL.send()`, maps upstream failures (retryable -> 502,
  caller-fixable -> 400/403).
- `worker/src/env.d.ts` -- hand-authored `Env`, `SendEmailMessage`, `EmailSendBinding` types.
- `relay/config.go` -- env-driven config (no flags/files; built for a systemd `EnvironmentFile`).
- `relay/smtp.go` -- `go-smtp` Backend/Session, MIME parse (`enmime`), payload build,
  multi-listen. Recipients come from the **envelope** (RCPT TO), not headers.
- `relay/client.go` -- the HTTPS POST to the worker's `/send` with the Bearer token.

### Sender-domain rewriting (load-bearing)
The worker only accepts `from` on `ALLOWED_FROM_DOMAIN` (`skyphusion.org`). The relay's
`FROM_DOMAIN` rewrites off-domain senders (e.g. `root@mindcrime`) to `DEFAULT_FROM` and moves
the original into `Reply-To`, so CI/cron mail does not get rejected.

## Bindings, vars, secrets

**Worker** (`worker/wrangler.jsonc`, `compatibility_date 2025-05-05`):
- Binding `send_email` -> `EMAIL` (Cloudflare Email Sending).
- Vars: `DEFAULT_FROM` = `noreply@skyphusion.org`, `DEFAULT_FROM_NAME` = `Skyphusion`,
  `ALLOWED_FROM_DOMAIN` = `skyphusion.org`.
- Secret: `RELAY_TOKEN` (`wrangler secret put`; generate with `openssl rand -hex 32`). The same
  value goes in the relay's env file.
- No D1/R2/KV -- stateless, zero runtime deps.

**Relay** (`/etc/skyphusion-email-relay.env`): `EMAIL_WORKER_URL` (required), `EMAIL_RELAY_TOKEN`
(required; must match the worker's `RELAY_TOKEN`), `SMTP_LISTEN` (default `127.0.0.1:2525`),
`DEFAULT_FROM` (default `noreply@skyphusion.org`), `FROM_DOMAIN` (default `skyphusion.org`),
`HTTP_TIMEOUT_SECONDS` (default 30), `MAX_MESSAGE_BYTES` (default 25 MiB).

## Gotchas
- **Never bind the relay to `0.0.0.0`.** It sends as `@skyphusion.org`, so an internet-reachable
  SMTP port is an open spam relay. Loopback / private bridge IP only.
- **Max 50 recipients** (to + cc + bcc), enforced in both `email.ts` (`MAX_RECIPIENTS`) and
  `smtp.go` (`MaxRecipients`). Keep them in sync.
- **No queue.** Synchronous sends; on worker failure the relay returns SMTP 451 (transient) so
  the MTA can retry, but nothing is durably buffered.
- The relay is also what Jenkins uses to email build failures (to `conrad@rockenhaus.net` via
  `127.0.0.1:2525`), so breaking the relay can silence CI alerts.

## CI / deploy
Jenkins multibranch pipeline (`Jenkinsfile`, host **mindcrime**), all stages in Docker:
- Worker typecheck (`node:22`): `cd worker && npm ci && npm run typecheck` -- all branches.
- Relay vet + build (`golang:1.23`): `cd relay && go vet ./... && go build` -- all branches.
- Deploy worker (`node:22`): `npx wrangler deploy` -- **main only** (needs the
  `CLOUDFLARE_API_TOKEN` Jenkins credential).

**Only the worker auto-deploys on green `main`.** The relay must be rebuilt and reinstalled on
mindcrime by hand (`go build` + `systemctl`); the pipeline does not ship the binary.

## Conventions (SkyPhusion house style)
- Default handle/username for any service is `skyphusion`.
- No em-dashes (U+2014) or en-dashes (U+2013) in source, comments, or docs; use commas,
  semicolons, or parentheses.
- `npm run typecheck` must pass before pushing (it is not part of any test run).
- Conventional Commits: `feat(worker): ...`, `fix(relay): ...`, `ci: ...`, `docs(readme): ...`.
  Body is the why; footer lists files touched.
- Keep both components dependency-light (worker: zero runtime deps; relay: only `go-smtp` +
  `enmime`). New deps need justification.
