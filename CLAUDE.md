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
  `/api/threads`) plus a same-account `MailboxService` RPC entrypoint (legacy `EmailService` alias
  for send-only bindings). It also SENDS, so the sent copy is written in the same isolate as the store.
  This is the heart of postern.
- **`relay/`** -- a small Go SMTP daemon (`go-smtp` + `enmime`) on the **directory host** for local services that
  can only speak SMTP (cron, backups, CI failure mail). Accepts MIME on `127.0.0.1:2525`, parses it,
  POSTs to the worker over HTTPS. Optional (bring-your-own-SMTP).
- **`mcp/`** -- the MCP server (TypeScript) so agents speak the mailbox over MCP. Published on npm
  as **`@skyphusion/postern-mcp`** (`npx -y @skyphusion/postern-mcp`). **Per-identity send** is first-class here: each
  human/agent sends under its OWN identity via per-identity creds (`docs/SEND-IDENTITIES.md`).
- **`webmail/`** -- a single self-contained page (vanilla HTML/CSS/JS, no build step) served by the
  worker at **`/webmail`**. Compose, reply, and read: list, read, threads, search, session
  login, drafts, delete. BYO-token in `sessionStorage` only, HTML rendered in a sandboxed
  iframe (no scripts/trackers), locked-down CSP.
- **`imap/`** -- a small Twisted server fronting the API as IMAP: read, the
  `\Seen` flag, delete (EXPUNGE, via a `both`-scoped `POSTERN_API_TOKEN_DELETE`), drafts, and
  soft-move to Trash/Junk/Archive; sending still only through the structured API.
  Thunderbird / mutt / iOS Mail can open the mailbox.
- **`clients/python/`** -- a Python client + CLI for the API. Published on PyPI as
  **`postern-client`** (`pip install postern-client`).

Human doors (webmail, imap) are **clients** of the API, never a second store: webmail composes,
replies, and manages its own drafts/delete through the API; imap adds `\Seen`, delete, drafts,
and soft-move to Trash/Junk/Archive, all persisted through the API (not a local store).
Sending always goes through the structured API.

## Documentation map

When a change touches one of these areas, update the matching doc.

- `docs/architecture.md` -- visual stack map (mermaid); start here for orientation.
- `docs/CONTRACT.md` -- authoritative data model + the transport seams. Read FIRST.
- `docs/AUTH-CONTRACT.md` -- the auth model across the seams.
- `docs/SEND-IDENTITIES.md` -- per-identity send (every caller sends as itself).
- `docs/INTEGRATION.md` -- caller setup (service-binding RPC + REST).
- `docs/MTA-STS.md` -- inbound TLS policy (MTA-STS + TLSRPT); staged, Conrad-supervised deploy.
- `docs/IMAP-APPLE-MAIL.md` -- Apple Mail IMAP handoff (delete token, Trash, attachments).
- `docs/OPERATIONS.md` -- backup, restore, and monitoring for a self-hosted mailbox (D1 export/Time Travel, R2, restore drill, health/logs, failure modes).
- Production cutover runbook: maintained out-of-tree in the operator private infrastructure repository (not in this product tree).
- `DEPLOY.md` -- clean-install quickstart from a fresh clone.

## Commands

```bash
# inbound/  (the core Worker, Node 22; no `npm run dev` script -- use wrangler dev directly)
cd inbound && npx wrangler dev --config wrangler.dev.jsonc   # local dev (local D1 + R2, no remote bindings)
npm run deploy                     # wrangler deploy
npm run typecheck                  # tsc --noEmit -- the CI gate; run before pushing
npm run cf-typegen                 # regenerate Env types from wrangler.jsonc
npx wrangler d1 migrations apply postern   # apply D1 migrations

# mcp/     (TypeScript)  -- npm run typecheck; npx vitest run
# relay/   (Go 1.22+)    -- go vet ./... ; go build -o skyphusion-email-relay .
# imap/    (Python/Twisted) -- see imap/README.md; trial-based tests
```

### Verifying changes

The workers have vitest suites; the scripted v1.0 acceptance smoke is `inbound/smoke.mjs` (issue #25).
End-to-end: verify against `npx wrangler dev --config wrangler.dev.jsonc` + `curl` the mailbox API;
verify the relay on the box with `swaks --server 127.0.0.1:2525 ...`. Always `npm run typecheck`
first (it is not part of any test run).

## Architecture (load-bearing)

- **One send core.** All sends funnel through `inbound/src/mailbox.ts` so behavior cannot drift.
  `POST /send` is a back-compat alias of `/api/send`. Keep the Bearer-token gate constant-time;
  never replace with `===`.
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

**GitHub Actions**, and the deploy is **TAG-GATED**: `deploy.yml` runs on a pushed SemVer tag
(`v*`), never on a merge. **A bare merge to `main` does NOT redeploy production** -- it runs CI only.
Ship with `git tag -a vX.Y.Z -m ... && git push origin vX.Y.Z`; the workflow applies
`wrangler d1 migrations apply` first, then `wrangler deploy`, so a schema change ships with its code.
**The tag gates EXPECT the version pins already on `main`** (v1.0.5 shipped deploy-only because
they were not): a `## vX.Y.Z` section in `CHANGELOG.md`, `clients/python/pyproject.toml`
`version`, `postern_client/__init__.py` `__version__`, and `inbound/package.json` `version` --
land the release PR with all four, THEN cut the tag. (`mcp/package.json` versions on its own
`postern-mcp-v*` track.)
`workflow_dispatch` may run the gate, but the deploy step is guarded on a tag ref, so a manual
dispatch from a branch never ships prod. Public repo -> GitHub-hosted `ubuntu-latest`.

**Every tag workflow runs ONE shared preflight first** (`.github/workflows/tag-preflight.yml` ->
`.github/scripts/tag-preflight.sh`), and each lists it in `needs:`, so the tag fan-out is
all-or-nothing. It asserts the tag equals all four pins, that `CHANGELOG.md` has a non-empty
`## vX.Y.Z` section, and that the tag is on `origin/main`; `postern-mcp-v*` tags get the same gate
against `mcp/package.json`. Before it existed the five `v*` workflows were peers with no ordering, so
v1.0.5 deployed production and rolled both door images off a tag whose release + PyPI jobs failed.
On a non-tag ref (dispatch, push to main) it asserts the pins agree with each other. It guards
HAND-CUT tags, which a ci.yml-only assert cannot.

**Verify the ARTIFACT, not the pipeline**: the worker's `modified_on` (or a behavior probe against
the live worker), never a green run. This paragraph previously claimed merges to `main` deploy, which
was wrong and cost a sprint an assumption -- code merged is NOT code live here. The tag deploy now
enforces this itself: after `wrangler deploy` it reads the live deployment back through the API and
asserts production serves the version just uploaded (`.github/scripts/verify-worker-deployment.mjs`),
then runs `inbound/smoke.mjs` against the live instance when the `POSTERN_SMOKE_*` secrets are
configured (and says so loudly when they are not).

The relay is rebuilt and reinstalled on the directory host by hand (`go build` + `systemctl`); the
pipeline does not ship the binary.

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
