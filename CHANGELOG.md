# Changelog

Notable changes per release. SemVer-style: **v1.0.0** is the first production-ready
Core v1.0 mailbox (M1 contract). Newest first. This tracks the inbound Worker +
`postern-client` release train; `@skyphusion/postern-mcp` (`mcp/`) tags and
versions on its own npm publish cadence and does not get an entry here by convention.

## v1.0.6

Role-address filing correctness, and the release pins v1.0.5 shipped without.

- **inbound:** `FILE_ALSO_UNDER` no longer depends on delivery ORDER (#407). Cloudflare invokes the
  worker once per envelope recipient and that order is not ours; the merge path appended only the
  envelope recipient, so mail addressed to a role address AND anything else was filed under the
  owner only when the role address happened to arrive first. Every address beyond the envelope
  recipient is now appended with an idempotent, delimiter-safe statement; the concurrency-critical
  insert-or-merge (#178) is untouched. Proven against real SQLite in both orders, with idempotence
  and substring-address controls.
- **inbound:** the store FAKE learned the same statement, so an order-dependent bug can no longer
  pass the fake-based suite green (it did, once).
- **python:** `postern-client` version synced to 1.0.6 for the PyPI publish gate.
- **operator note (no code):** the deployed operator config carries `d1_databases[0].database_name`
  `skyphusion-mail` (the escrow value), not the public template placeholder. The `database_id` was
  always correct, so nothing pointed at another database. Escrowed in `crew-secrets`.

## v1.0.5

Worker deploy only. The inbound Worker shipped; the PyPI and GitHub-release legs did NOT run,
because the tag was cut without bumping `clients/python/pyproject.toml` or adding a CHANGELOG
section (both are version-lockstep gates). Recorded rather than quietly re-tagged; v1.0.6 carries
the pins.

- **inbound:** `FILE_ALSO_UNDER` (#402) -- a `recipient=alsoFileUnder` map applied at ingest, so mail
  to a shared role address is ALSO recorded as delivered to a named owner and appears in that
  mailbox view of the SAME stored message. Filing, not transport: nothing is copied, forwarded, or
  re-transmitted. Empty or unset changes nothing. Exists because per-account mailbox views leave an
  unowned role address (an abuse intake, say) stored but visible to nobody.
- **docs:** `CLAUDE.md` corrected -- the deploy is TAG-GATED and a merge to `main` ships nothing
  (#405). The file had claimed the opposite, which is how merged code came to be treated as live.

## v1.0.4

Security dependency overrides for Dependabot advisories (#394, #395).

- **mcp:** npm overrides pin transitive deps through `@modelcontextprotocol/sdk`:
  `fast-uri@3.1.4` (GHSA-4c8g-83qw-93j6 and backslash-host GHSA), `@hono/node-server@2.0.11`
  (GHSA-frvp-7c67-39w9). Postern MCP uses stdio transport only; overrides clear the advisory
  surface without waiting on upstream SDK pins (#394, #395).
- **inbound:** npm override `sharp@0.35.3` for the wrangler/miniflare dev dependency chain (#395).
- **python:** `postern-client` version synced to 1.0.4 for PyPI publish on release tag.

## v1.0.3

Release sync bump (2026-07-21). No functional changes in this tag.

## v1.0.2

Reply routing fixes for outbound sent mail and staging smoke.

- **inbound:** replying to a stored outbound send targets the original `To`
  recipients instead of `From` (the sender), fixing `reply has no recipient
  after excluding sender` on sent-mail replies (#386).
- **smoke-staging:** skip the reply leg with an explicit ok when
  `POSTERN_TO` equals `POSTERN_FROM` (self-addressed staging send) (#387).

## v1.0.1 -- 2026-07-16

Production catch-up release. Marks the current deployed tip (`inbound` Worker +
IMAP/relay images on GHCR `latest`) after post-v1.0.0 main landings (docs, IMAP
image policy, Dependabot, operator notes). No intentional Core contract break.

## v1.0.0

**Postern Core v1.0 -- email for humans and agents.** First tagged release of the
complete self-hostable mailbox on Cloudflare Email.

**Store and API (`inbound/`)**

- One Worker: ingest (CF Email Routing + `POST /ingest`), D1 + FTS5 + R2 attachments,
  optional Vectorize hybrid search, mailbox API (`/api/messages`, `/api/search`, `/api/send`,
  `/api/reply`, `/api/threads`), same-account `MailboxService` RPC.
- Envelope fidelity v2 (#189): multi-recipient merge on duplicate Message-ID,
  IMAP ENVELOPE projection, seen state.
- Per-identity send registry (#85), scoped read/send tokens, MTA-STS testing/enforce,
  mobileconfig for iOS/macOS mail setup.
- Legacy send-only `worker/` folded into `inbound/` (#190).

**Transport (`relay/`)**

- Loopback ingest SMTP, submission 587/465 with pluggable auth (native / ldap / system),
  outbound `/dispatch` BYO-SMTP bridge with attachments (#92), PROXY protocol on the edge.

**Client doors**

- `mcp/`: MCP tools; search defaults to hybrid; opt-in per-identity send.
- `webmail/`: read-only UI at `/webmail`; search defaults to hybrid.
- `imap/`: read-only IMAP proxy with SEARCH pushdown and wire e2e tests.
- `clients/python/`: stdlib HTTP client.

**Ops and docs**

- Architecture map with mermaid diagrams (`docs/architecture.md`).
- Nightly staging smoke workflow (`inbound/smoke.mjs`, issue #25).
- Vectorize v2 index rebuild and orphan reconcile runbook (`docs/reconcile-orphan-vectors.md`).

See [DEPLOY.md](DEPLOY.md) for clean-install from a fresh clone.