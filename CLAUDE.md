# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Postern: email for humans AND agents (egalitarian).** A self-hostable mailbox on Cloudflare: it
sends and receives mail, stores every message in a searchable store (D1 full-text + R2 + optional
Vectorize), and exposes ONE structured mailbox API that agents and human clients (IMAP / webmail)
both speak. Humans and agents are first-class peers: each sends as itself under per-identity
credentials, not a shared mailbox. Cloudflare Email is the default transport on each seam, never a
hard dependency. From a fresh clone, with only your own domain, you can deploy it, send a message,
and receive + read it back. Public, on CF Email (formerly `skyphusion-email`). See **DEPLOY.md** for
the clean-install quickstart.

**Inbound Worker version:** trust `inbound/package.json` (do not hardcode a frozen
version in this file). Tag-gated release on `main` (`v*`).

**Public demo (Skyphusion Labs account, 2026-08):** zone **posternonline.com** lives on the regular
Skyphusion Labs Cloudflare account (not a separate demo account). Live Worker name **`postern`**,
custom domain **`demo.posternonline.com`**. The apex **`posternonline.com`** and
**`www.posternonline.com`** are the marketing site, served by the `postern-site` repo's own Worker
(custom domains in its `wrangler.toml`; read live 2026-11-13: both answer 200, no redirect).
Operator config: gitignored `inbound/wrangler.demo.jsonc` (account + D1/R2/Vectorize ids). The demo
deploys from the `postern-demo` repo's CI on merge to its `main` (it pins `POSTERN_VERSION` and
`POSTERN_COMMIT`); do not deploy it by hand.
Email Routing catch-all routes to Worker `postern`. Public read token is documented in **README.md**
(`POSTERN_API_TOKEN_READ`; send/reply/delete refused). Mail any `@posternonline.com` address into
the shared demo mailbox.

**Production estate mail** is the Worker `skyphusion-email-inbound` (D1 `skyphusion-mail`),
distinct from the public posternonline demo (Worker `postern`, its own D1). It ships from THIS
repo's tag deploy (`deploy.yml` on a `v*` tag): the operator wrangler config lives in the
`POSTERN_INBOUND_WRANGLER` secret of the GitHub Environment `production`, and that config, not
the committed template, names the Worker and its D1. An escrow copy of the config is kept out of
tree in the operator private infrastructure repository; it is a backup, not the deploy path. To
see what a tag deployed, read the deploy run log ("Reading live vars for Worker: ...",
"Uploaded ...", the `env.DB (...)` binding line).

Read **docs/CONTRACT.md** (authoritative data model + transport seams), **docs/AUTH-CONTRACT.md**, and
**docs/SEND-IDENTITIES.md** before changing behavior.

## Components (one repo)

- **`inbound/`** -- THE core Cloudflare Worker (the heart of postern). Ingests inbound mail via Email
  Routing, stores it in D1 (FTS5 search), R2 (attachment bytes), and optionally Vectorize (chunked
  embeddings for crew RAG), and serves the one mailbox API (`/api/messages`, `/api/search`,
  `/api/send`, `/api/reply`, `/api/threads`) plus a same-account `MailboxService` RPC entrypoint
  (legacy `EmailService` alias for send-only bindings). It also SENDS, so the sent copy is written in
  the same isolate as the store. **Production receiving is CF Email Routing -> this Worker**, not a
  host MTA.
- **`relay/`** -- a small Go SMTP daemon (`go-smtp` + `enmime`) for local services that can only speak
  SMTP (cron, backups, CI failure mail). Unauthenticated intake is **loopback only**
  (default `127.0.0.1:2525`; `0.0.0.0` is refused). Authenticated submission (587/465) is a
  separate door and may bind a public address (`relay/config.go`, `relay/README.md`).
  It parses MIME and POSTs to the worker over HTTPS. Optional (bring-your-own-SMTP). Box-side relay is an
  **operator/dev seam**, not the production inbound path.
- **`mcp/`** -- the MCP server (TypeScript) so agents speak the mailbox over MCP. Published on npm
  as **`@skyphusion/postern-mcp`** (`npx -y @skyphusion/postern-mcp`). **Per-identity send** is
  first-class here: each human/agent sends under its OWN identity via per-identity creds
  (`docs/SEND-IDENTITIES.md`). **Advertised MCP `serverInfo.version` must match `mcp/package.json`**
  (`mcp/src/version.ts` + tests; never hardcode a drifted literal).
- **`webmail/`** -- a single self-contained page (vanilla HTML/CSS/JS, no build step) served by the
  worker at **`/webmail`**. Compose, reply, and read: list, read, threads, search, session
  login, drafts, delete. BYO-token in `sessionStorage` only, HTML rendered in a sandboxed
  iframe (no scripts/trackers), locked-down CSP.
- **`imap/`** -- Twisted IMAP proxy fronting the API: read, the `\Seen` flag, delete (EXPUNGE, via a
  `both`-scoped `POSTERN_API_TOKEN_DELETE`), drafts, and soft-move to Trash/Junk/Archive; sending
  still only through the structured API. Thunderbird / mutt / iOS Mail can open the mailbox.
  **Production door is the container image** (`imap/Dockerfile` -> `ghcr.io/skyphusion-labs/postern-imap`),
  not a host-level Python install. Host/systemd IMAP on a box is for local/dev, not the canonical
  prod receiving path (that remains CF Email -> inbound Worker).
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
# relay/   (Go 1.26+)    -- go vet ./... ; go build -o skyphusion-email-relay .
# imap/    (Python/Twisted) -- see imap/README.md; trial-based tests
```

### Verifying changes

The workers have vitest suites; the scripted v1.0 acceptance smoke is `inbound/smoke.mjs` (issue #25).
**The cross-seam route contract is GENERATED from `inbound/src/routes.ts`** (#417). That file is the
single source: the live scope gate in `api.ts` CALLS the `requiredScope()` derived from those rows
(the if-chain that used to live there is gone), so there is no second list to drift.
`npm run routes:emit` (in `inbound/`) projects it to `contracts/api-routes.json` (route + method +
required scope) and `contracts/api-params.json` (the query/body names each route reads, keyed by the
same route id). **Add or rename a route by editing `inbound/src/routes.ts` and re-emitting in the
SAME commit; never hand-edit the JSON.** Four tests keep it honest: `inbound/route-contract.test.ts`
(the scope column against the real `handleApi`), `inbound/route-table.test.ts` (the derivation is
equivalent to the if-chain it replaced, no row is shadowed, the committed JSON matches the source),
`inbound/route-params.test.ts` (every declared parameter is REFUSED when bogus or demonstrably
changes the answer, against the real handler), and one contract suite per client
(`mcp/test/worker-contract.test.ts`, `clients/python/.../test_worker_contract.py`,
`imap/posternimap/tests/test_worker_contract.py`) asserting each client emits only what the contract
declares, and can reach everything it honors.
End-to-end: verify against `npx wrangler dev --config wrangler.dev.jsonc` + `curl` the mailbox API;
verify the relay locally with `swaks --server 127.0.0.1:2525 ...`. Always `npm run typecheck`
first (it is not part of any test run).

## Architecture (load-bearing)

- **One send core.** All sends funnel through `inbound/src/mailbox.ts` so behavior cannot drift.
  `POST /send` is a back-compat alias of `/api/send`. Keep the Bearer-token gate constant-time;
  never replace with `===`.
- **Sender domain.** `ALLOWED_FROM_DOMAIN` has no product default
  (`inbound/src/fromdomain.ts`); unset refuses rather than borrowing one.
  The legacy relay `/send` path rewrites an off-domain sender to `DEFAULT_FROM`
  and keeps the original as `Reply-To` (`relay/smtp.go`). The `/ingest` seam does not rewrite.
  Relay defaults are `example.com` and `noreply@example.com` (`relay/config.go`).
- **Store:** D1 (`messages`/`attachments`, FTS5), R2 (attachment bytes), Vectorize (embeddings for RAG).

## Gotchas

- **Never bind unauthenticated intake to `0.0.0.0`.** That listener carries no AUTH verdict,
  so a public bind is an open relay (`relay/smtp.go`). Submission (587/465) is the separate public door.
- **Max 50 recipients** (to + cc + bcc), enforced in both `mailbox.ts` (`MAX_RECIPIENTS`) and `smtp.go`
  (`MaxRecipients`). Keep them in sync.
- **No queue.** Synchronous sends; on worker failure the relay returns SMTP 451 (transient) so the MTA
  can retry, but nothing is durably buffered.
- **Webmail safety:** no `innerHTML` of message content, sandboxed iframe render, locked-down CSP, token
  in `sessionStorage` only.

## CI / deploy / release tagging

**GitHub Actions**, and the deploy is **TAG-GATED**: `deploy.yml` runs on a pushed SemVer tag
(`v*`), never on a merge. **A bare merge to `main` does NOT redeploy production** -- it runs CI only.

### Cut a Worker / PyPI release (`v*`)

1. **Release PR on `main` first** -- land all version pins before any tag (v1.0.5 shipped deploy-only
   because they were not):
   - `CHANGELOG.md` section `## vX.Y.Z`
   - `clients/python/pyproject.toml` `version`
   - `postern_client/__init__.py` `__version__`
   - `inbound/package.json` `version` (and `inbound/package-lock.json`, top-level and `packages[""]`)
   - `inbound/src/version.ts` `VERSION` (asserted by `inbound/version.test.ts` and `tag-preflight.sh`)
2. **Then** cut the annotated tag and push:

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The workflow applies `wrangler d1 migrations apply` first, then `wrangler deploy`, so a schema change
ships with its code. `release.yml` also opens the GitHub Release; PyPI publish rides the same `v*`
track via `publish-pypi.yml`.

3. **After the tag is live, move the demo and the site to it.** Both are separate repos with their
   own pins, and neither follows a release by itself (on 2026-11-11 the demo was six releases behind
   and the site linked a release five behind, #934):
   - **postern-demo**: a PR per its README, "Upgrade the demo". Set `POSTERN_VERSION` to the tag and
     `POSTERN_COMMIT` to its commit (`git ls-remote https://github.com/skyphusion-labs/postern.git
     'refs/tags/vX.Y.Z^{}'`). Add any binding or var the release's `inbound/wrangler.jsonc` added;
     the release notes' Upgrade section names the migrations the demo deploy applies. The merge
     deploys, and the deploy fails unless `/health` reports the new version. The demo's daily
     `version-check` workflow goes red while its pin is behind the latest release.
   - **postern-site**: a PR that moves every `skyphusion-labs/postern/.../vX.Y.Z` link and the
     install command to the tag, then a site tag. The site's `ci` fails until this is done
     (`scripts/check-postern-version.mjs`, also run daily).

### MCP package track (separate)

`mcp/package.json` versions on its own **`postern-mcp-v*`** tag track (`npm-mcp.yml`). A `v*` Worker
tag does not publish MCP; a `postern-mcp-v*` tag does not deploy inbound.

`workflow_dispatch` may run the gate, but the deploy step is guarded on a tag ref, so a manual
dispatch from a branch never ships prod. Public repo -> GitHub-hosted `ubuntu-latest`.

**Every tag workflow runs ONE shared preflight first** (`.github/workflows/tag-preflight.yml` ->
`.github/scripts/tag-preflight.sh`), and each lists it in `needs:`, so the tag fan-out is
all-or-nothing. It asserts the tag equals the three pins plus `inbound/src/version.ts`, that `CHANGELOG.md` has a non-empty
`## vX.Y.Z` section, and that the tag is on `origin/main`; `postern-mcp-v*` tags get the same gate
against `mcp/package.json`. Before it existed the five `v*` workflows were peers with no ordering, so
v1.0.5 deployed production and rolled both door images off a tag whose release + PyPI jobs failed.
On a non-tag ref (dispatch, push to main) it asserts the pins agree with each other. It guards
HAND-CUT tags, which a ci.yml-only assert cannot.

**Verify the ARTIFACT, not the pipeline**: the worker's live version / `modified_on` (or a behavior
probe against the live worker), never a green run. Code merged is NOT code live here. The tag deploy
enforces this itself: after `wrangler deploy` it reads the live deployment back through the API and
asserts production serves the version just uploaded (`.github/scripts/verify-worker-deployment.mjs`),
then runs `inbound/smoke.mjs` against the live instance when the `POSTERN_SMOKE_*` secrets are
configured (and says so loudly when they are not). After any release, confirm the **live Worker
version** matches the tag you intended.

The relay image is `ghcr.io/skyphusion-labs/postern-relay`, published by `relay-image.yml`
(a `v*` tag, a `relay/**` push to `main`, or `workflow_dispatch`). Nothing installs it
on a host: the host `systemctl` path is gone (2026-09-24; see that workflow).
Production receiving stays CF Email Routing to the inbound Worker.

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

## Release convention (bump-at-release)

One convention for every skyphusion-labs repo (Conrad, ruled 2026-11-10, fleet-chezmoi#1766). A version moves ONLY in a release PR: bump the version, then assemble the changelog. Feature and fix PRs do not bump. Releases go through a PR (fleet-chezmoi#1622) and the tag goes on that PR's merge commit.

- Version of record here: the version files the last release commit touched (clients/python/pyproject.toml, clients/python/postern_client/__init__.py and the package locks; read the last `chore(release)` commit).
- Tag shape: `v*`.
- Check before a release PR: does a tag already exist for the version currently in the manifest? Yes means the cycle is closed, so the release PR bumps. No means a bump already landed outside a release PR; stop and read why before bumping again.
