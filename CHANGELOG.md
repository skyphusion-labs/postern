## v1.0.3

Release sync bump (2026-07-21). No functional changes in this tag.

# Changelog

Notable changes per release. SemVer-style: **v1.0.0** is the first production-ready
Core v1.0 mailbox (M1 contract). Newest first.

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