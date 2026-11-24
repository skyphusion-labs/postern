# Postern

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

Postern is a self-hostable mailbox on Cloudflare.
It sends and receives mail.
It stores every message in one searchable store.
Agents and human clients use one mailbox API.
Each human and each agent sends as itself, with its own credential.
Cloudflare Email is the default transport.
It is not a hard dependency.
From a fresh clone you can deploy, send, and read mail on your own domain.
The clean-install steps are in [DEPLOY.md](DEPLOY.md).

The Worker version is `inbound/package.json`.
Do not copy a version into this file.
A release is a `v*` tag.
See the latest `v*` tag.

## Public demo

The public demo is [https://demo.posternonline.com](https://demo.posternonline.com).
The project site is [https://posternonline.com](https://posternonline.com).
The demo Worker name is `postern`.
Its config is the committed `wrangler.jsonc` in [postern-demo](https://github.com/skyphusion-labs/postern-demo).
That repo deploys the demo from CI when `main` changes.
Do not deploy the demo by hand from this repo.
`inbound/wrangler.demo.jsonc` is gitignored.
It is not the demo deploy path.
Email Routing on the demo zone delivers mail to the demo Worker.
The public read token is in [README.md](README.md).
That token can read.
Send, reply, and delete are refused.
Mail to any `@posternonline.com` address lands in the shared demo mailbox.

## Read these first

Read these before you change behavior.

- [docs/CONTRACT.md](docs/CONTRACT.md) is the data model and the transport seams.
- [docs/AUTH-CONTRACT.md](docs/AUTH-CONTRACT.md) is the auth model.
- [docs/SEND-IDENTITIES.md](docs/SEND-IDENTITIES.md) is per-identity send.
- [docs/architecture.md](docs/architecture.md) is the stack map.
- [docs/INTEGRATION.md](docs/INTEGRATION.md) is caller setup.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) is backup, restore, and monitoring for a self-hosted mailbox.
- [docs/MTA-STS.md](docs/MTA-STS.md) is the inbound TLS policy.
- [docs/IMAP-APPLE-MAIL.md](docs/IMAP-APPLE-MAIL.md) is the Apple Mail IMAP handoff.

## Components

`inbound/` is the Cloudflare Worker.
It takes mail from Email Routing.
It stores messages in D1 with FTS5 search.
It stores attachment bytes in R2.
It can store embeddings in Vectorize.
It serves the mailbox API.
It also sends, so the sent copy is written in the same isolate.
Self-host receiving is Email Routing to this Worker.
It is not a host mail transfer agent.

`relay/` is a small Go SMTP daemon.
Local services that speak only SMTP use it.
Unauthenticated intake is loopback only.
The default is `127.0.0.1:2525`.
That listener refuses `0.0.0.0`.
Authenticated submission on 587 or 465 is a separate door.
See [relay/README.md](relay/README.md) and `relay/config.go`.
The relay is optional.
It is not the receiving path.

`mcp/` is the MCP server.
The npm package is `@skyphusion/postern-mcp`.
Each caller sends under its own identity.
`serverInfo.version` must match `mcp/package.json`.
See `mcp/src/version.ts`.

`webmail/` is one HTML page.
The Worker serves it at `/webmail`.
There is no build step.
The token stays in `sessionStorage`.
Message HTML renders in a sandboxed iframe.
The page sets a locked-down content security policy.

`imap/` is a Twisted IMAP proxy in front of the API.
The container image is the supported door.
The image is `ghcr.io/skyphusion-labs/postern-imap`.
A host Python install is for local development.
Receiving stays on Email Routing to the inbound Worker.

`clients/python/` is the Python client and CLI.
The PyPI package is `postern-client`.

Webmail and IMAP are clients of the API.
They are not a second store.
Sending always uses the structured API.

## How to work

Run commands in the component you change.

```bash
cd inbound && npx wrangler dev --config wrangler.dev.jsonc
cd inbound && npm run typecheck
cd inbound && npm test
cd inbound && npm run routes:emit
cd mcp && npm run typecheck && npx vitest run
cd relay && go vet ./... && go build .
```

IMAP tests are in [imap/README.md](imap/README.md).
Apply local D1 migrations with the Wrangler command in [DEPLOY.md](DEPLOY.md).

`npm run typecheck` in `inbound/` is a CI gate.
Tests do not run it.
Run it before you push.

The route contract is generated from `inbound/src/routes.ts`.
`npm run routes:emit` writes `contracts/api-routes.json` and `contracts/api-params.json`.
Edit the TypeScript source.
Re-emit in the same commit.
Do not edit the JSON by hand.

CI is [.github/workflows/ci.yml](.github/workflows/ci.yml).
It covers inbound, relay, imap, the Python client, mcp, and webmail.
The scripted acceptance smoke is `inbound/smoke.mjs`.

## Load-bearing rules

All sends go through `inbound/src/mailbox.ts`.
`POST /send` is an alias of `/api/send`.
Keep the bearer-token compare constant-time.
Do not use `===`.

`ALLOWED_FROM_DOMAIN` has no product default.
If it is unset, send is refused.
See `inbound/src/fromdomain.ts`.
Relay defaults are `example.com` and `noreply@example.com` (`relay/config.go`).

The store is D1, R2, and optional Vectorize.

Do not bind unauthenticated SMTP intake to `0.0.0.0`.
That listener has no AUTH verdict.
A public bind is an open relay.

The recipient cap is 50.
The count includes to, cc, and bcc.
`mailbox.ts` and `smtp.go` both enforce it.
Keep the two caps the same.

There is no queue.
A Worker failure makes the relay return SMTP 451.
The sender can retry.
Nothing is buffered on disk.

Do not put message HTML in `innerHTML`.
Use the sandboxed iframe.

## Release

A merge to `main` runs CI.
It does not deploy.
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs on a `v*` tag.

Land the version pins in a release pull request first.
Then tag that merge commit.
The pins include the changelog section, the Python package, `inbound/package.json`, and `inbound/src/version.ts`.
`.github/scripts/tag-preflight.sh` checks them.
Every tag workflow needs that preflight.
The workflow applies D1 migrations, then deploys.

A `v*` tag does not publish the MCP package.
The MCP tag is `postern-mcp-v*`.
See `.github/workflows/npm-mcp.yml`.
PyPI publish uses the same `v*` track.
See `.github/workflows/publish-pypi.yml`.

After the tag is live, update the demo pin.
Follow "Upgrade the demo" in the postern-demo README.
The postern-site repo updates its postern links in its own pull request.

Confirm the live Worker version after a release.
A green workflow is not the live version.
The deploy reads the live deployment back after upload.

The relay image is `ghcr.io/skyphusion-labs/postern-relay`.
`.github/workflows/relay-image.yml` publishes it.
This repo does not install that image on a host.

## Versions

A version changes only in a release pull request.
Feature and fix pull requests do not bump it.
Put the tag on that pull request's merge commit.
Read the version in `inbound/package.json` and the Python package.
Do not copy a frozen version into this file.
The Worker tag shape is `v*`.
If that version already has a tag, the cycle is closed.
The next release pull request bumps.
If the manifest version has no tag, stop.
Find why before you bump again.

## Docs

Write Simplified Technical English.
Use short sentences.
Use one idea per sentence.
Use the active present tense.
Use plain words.
Use the same word every time.

Do not use an em dash (U+2014) or an en dash (U+2013).
Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability.
Do not turn a measured result into a promise.
Honest limits are in [README.md](README.md).

Use Conventional Commits.
The body says why.

## Safety

Do not put a secret in a tracked file.
Do not put a secret in a log.
Do not put a secret in an issue.
Read [DEPLOY.md](DEPLOY.md) before you attach a domain.
A trial deploy uses your own Worker name.
