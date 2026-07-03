# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Postern: email for humans AND agents.** A self-hostable mailbox on Cloudflare: it sends and
receives mail, stores every message in a searchable store (D1 full-text + R2 + optional Vectorize),
and exposes ONE structured mailbox API that agents and human clients (IMAP / webmail) both speak.
Cloudflare Email is the default transport on each seam, never a hard dependency. From a fresh clone,
with only your own domain, you can deploy it, send a message, and receive + read it back. Public, on
CF Email (formerly `skyphusion-email`). See **DEPLOY.md** for the clean-install quickstart.

Read **docs/CONTRACT.md** (authoritative data model + transport seams), **docs/AUTH-CONTRACT.md**, and
**docs/SEND-IDENTITIES.md** before changing behavior.

## Components (one repo)

- **`inbound/`** -- THE core Cloudflare Worker. Ingests inbound mail via Email Routing, stores it in
  D1 (FTS5 search), R2 (attachment bytes), and optionally Vectorize (chunked embeddings for crew RAG),
  and serves the one mailbox API (`/api/messages`, `/api/search`, `/api/send`, `/api/reply`,
  `/api/threads`) plus a same-account `MailboxService` RPC entrypoint. It also SENDS, so the sent copy
  is written in the same isolate as the store. This is the heart of postern.
- **`worker/`** -- the legacy standalone send-only Worker (`EmailService` RPC + token-gated
  `POST /send`). Kept for back-compat; folds into `inbound/` in a later release.
- **`relay/`** -- a small Go SMTP daemon (`go-smtp` + `enmime`) on the **directory host** for local services that
  can only speak SMTP (cron, backups, CI failure mail). Accepts MIME on `127.0.0.1:2525`, parses it,
  POSTs to the worker over HTTPS. Optional (bring-your-own-SMTP).
- **`mcp/`** -- the MCP server (TypeScript) so agents speak the mailbox over MCP. **Per-identity send**
  is first-class here: each human/agent sends under its OWN identity via per-identity creds
  (`mcp/PROOF-per-identity-send.md`).
- **`webmail/`** -- a single self-contained page (vanilla HTML/CSS/JS, no build step) served by the
  worker at **`/webmail`**. Read-only human door: list, read, threads, search. BYO-token in
  `sessionStorage` only, HTML rendered in a sandboxed iframe (no scripts/trackers), locked-down CSP.
- **`imap/`** -- a small Twisted server fronting the read API as **read-only IMAP**, so
  Thunderbird / mutt / iOS Mail can open the mailbox.
- **`clients/python/`** -- a Python client for the API.

Human doors (webmail, imap) are read-only **clients** of the API, never a second store. Sending always
goes through the structured API.

## Documentation map

When a change touches one of these areas, update the matching doc.

- `docs/CONTRACT.md` -- authoritative data model + the transport seams. Read FIRST.
- `docs/AUTH-CONTRACT.md` -- the auth model across the seams.
- `docs/SEND-IDENTITIES.md` -- per-identity send (every caller sends as itself).
- `docs/INTEGRATION.md` -- caller setup (service-binding RPC + REST).
- `docs/MTA-STS.md` -- inbound TLS policy (MTA-STS + TLSRPT); staged, Conrad-supervised deploy.
- Production cutover runbook: maintained out-of-tree in the operator private infrastructure repository (not in this product tree).
- `DEPLOY.md` -- clean-install quickstart from a fresh clone.

## Commands

```bash
# inbound/  (the core Worker, Node 22)
cd inbound && npm run dev          # wrangler dev (local)
npm run deploy                     # wrangler deploy
npm run typecheck                  # tsc --noEmit -- the CI gate; run before pushing
npm run cf-typegen                 # regenerate Env types from wrangler.jsonc
npx wrangler d1 migrations apply postern   # apply D1 migrations

# worker/  (legacy send Worker) -- same npm scripts as inbound/
# mcp/     (TypeScript)  -- npm run typecheck; npx vitest run
# relay/   (Go 1.22+)    -- go vet ./... ; go build -o skyphusion-email-relay .
# imap/    (Python/Twisted) -- see imap/README.md; trial-based tests
```

### Verifying changes

The workers have vitest suites; the scripted v1.0 acceptance smoke is `inbound/smoke.mjs` (issue #25).
End-to-end: verify against `npm run dev` + `curl` the mailbox API; verify the relay on the box with
`swaks --server 127.0.0.1:2525 ...`. Always `npm run typecheck` first (it is not part of any test run).

## Architecture (load-bearing)

- **One send core, two front doors.** Both `inbound/` and the legacy `worker/` funnel sends through one
  `sendEmail()` so behavior cannot drift. `POST /send` does a **constant-time** Bearer-token compare
  before parsing the body. Keep it constant-time; never replace with `===`.
- **Sender-domain rewriting.** The worker only accepts `from` on `ALLOWED_FROM_DOMAIN`
  (`skyphusion.org`); the relay rewrites off-domain senders (e.g. `root@directory-host`) to `DEFAULT_FROM`
  and moves the original into `Reply-To`, so CI/cron mail is not rejected.
- **Store:** D1 (`messages`/`attachments`, FTS5), R2 (attachment bytes), Vectorize (embeddings for RAG).

## Gotchas

- **Never bind the relay to `0.0.0.0`.** It sends as `@skyphusion.org`; an internet-reachable SMTP port
  is an open spam relay. Loopback / private bridge IP only.
- **Max 50 recipients** (to + cc + bcc), enforced in both `email.ts` (`MAX_RECIPIENTS`) and `smtp.go`
  (`MaxRecipients`). Keep them in sync.
- **No queue.** Synchronous sends; on worker failure the relay returns SMTP 451 (transient) so the MTA
  can retry, but nothing is durably buffered.
- **Webmail safety:** no `innerHTML` of message content, sandboxed iframe render, locked-down CSP, token
  in `sessionStorage` only.

## CI / deploy

**GitHub Actions**. On push to `main`, `deploy.yml` deploys the workers (the live
inbound worker stays named `skyphusion-email-inbound`; the send worker -> `postern-send`) and runs
`wrangler d1 migrations apply` first. Public repo -> GitHub-hosted `ubuntu-latest`. The relay is rebuilt
and reinstalled on the directory host by hand (`go build` + `systemctl`); the pipeline does not ship the binary.

## Conventions (SkyPhusion house style)

- Default handle/username is `skyphusion`.
- No em-dashes (U+2014) or en-dashes (U+2013) in source, comments, or docs; use commas, semicolons,
  parentheses, or `--`.
- `npm run typecheck` must pass before pushing (it is not part of any test run).
- Keep components dependency-light (workers: near-zero runtime deps; relay: only `go-smtp` + `enmime`).
  New deps need justification.
- Conventional Commits: `feat(inbound): ...`, `fix(relay): ...`, `ci: ...`, `docs(claude): ...`. Body is
  the why; footer lists files touched.

## Crew + identity

- Crew work as their own identity: FIRST command in any op is `sudo -u <member> bash -lc '<ops>'` (own
  `$HOME`, own clone, own creds); commits/PRs land under `skyphusion-<member>`. **SEND is first-class for
  everyone via per-identity creds** -- a crew member sends as itself, never as a shared mailbox.
- Operating memory for this repo: `~/.claude/projects/-home-conrad-dev-postern/memory/` (load before acting).
