# Webmail v2 release notes (operator)

How to upgrade, verify, and roll back a Postern deployment that includes webmail
v2 (epic #338, phases 1-6). Companion user-facing notes live in
[`webmail/README.md`](../webmail/README.md). Security gate ledger:
[`docs/reviews/webmail-v2-phase6-adversarial-2026-07-18.md`](reviews/webmail-v2-phase6-adversarial-2026-07-18.md).

## What ships in v2

| Phase | Issue | Capability |
|---|---|---|
| 1 | #351 | Native session auth (`/api/session`), CSRF double-submit, BYO token still works |
| 2-3 | #352 | Durable mailboxes (Archive/Trash/Junk/Drafts), flags, move, folder rail |
| 4 | #353 | Compose parity: draft attachments, reply-all/forward, sanitize-on-send |
| 5 | #354 / #342 | IMAP door parity + projected SIZE (unicode-safe) |
| 6 | #355 | Adversarial battery, browser E2E, this release doc |

Remote images stay blocked under the served CSP (`img-src 'self' data:`); there is
no working opt-in (#343 closed as "truth the docs").

## Schema prerequisites

Webmail v2 needs migrations **0010 through 0013** applied (additive; #112 gate
auto-applies). Full chain from empty store: `0000`..`0013`.

| Migration | Purpose |
|---|---|
| `0010_webmail_sessions.sql` | `webmail_sessions` table |
| `0011_durable_mailboxes.sql` | drafts, placement, folder UID counters, mailbox column |
| `0012_projected_size.sql` | cached RFC822.SIZE for IMAP |
| `0013_draft_attachments.sql` | draft attachment staging + compose_mode |

Baseline-seed list (schema.sql installs) is in [`DEPLOY.md`](../DEPLOY.md).
Verify pending:

```bash
cd inbound
npx wrangler d1 migrations list postern --remote
```

Nothing through `0013` should remain pending before flipping traffic to a build
that expects those tables.

## Upgrade (existing production)

1. **Merge / deploy inbound Worker** that includes the phase code + migrations.
   CI runs `wrangler d1 migrations apply` then `wrangler deploy` (see
   `.github/workflows/deploy.yml`).
2. Confirm migrations: `migrations list` shows 0010-0013 applied.
3. **IMAP doors** (if used): roll the Swarm image to a tip that includes the
   projected-size + draft IMAP routes; keep `VIEWER_MODE` / service token as
   already documented in fleet-chezmoi `system/postern/`.
4. Smoke:
   - `GET https://<origin>/webmail` returns HTML with CSP
     `frame-ancestors 'none'` and `connect-src 'self'`.
   - BYO token: connect, list, open a message (body in sandboxed iframe).
   - If native auth is on: sign-in, CSRF-protected organize/send.
   - Drafts: create, attach (<20, <25 MiB total), send; confirm sanitize strips
     script handlers on HTML send.
5. Optional: run `cd inbound && npm test` and `cd webmail/e2e && npm test` on the
   release tag.

## Rollback

Migrations 0010-0013 are **additive** (CREATE / ALTER ADD). Do not DROP them in
panic; rolling the Worker image back to a pre-v2 build is safe:

- Old code ignores new columns/tables.
- Sessions/drafts created by v2 remain in D1 until cleaned; they do not break
  v1 list/read/send.
- IMAP projected_size NULL rows fall back to hydrate (pre-0012 behavior).

If a deploy must be aborted mid-migration, leave applied files in
`d1_migrations` and redeploy a Worker that understands them (never delete
migration history).

## Operator configuration checklist

| Knob | Notes |
|---|---|
| `POSTERN_SEND_IDENTITIES` | Var (not secret); per-identity From bind for webmail compose |
| Session auth backend | Native vs off; see AUTH-CONTRACT / webmail-v2-contracts §1 |
| CSP | Served from `serveWebmail()`; do not loosen `connect-src` or `frame-ancestors` |
| Attachment caps | 20 attachments, 25 MiB decoded total (drafts + send) |
| IMAP service token | `POSTERN_API_TOKEN_IMAP` / Swarm `postern_imap_imap_token` |

## User-facing summary (short)

- Sign in with mailbox credentials (when enabled) or paste a read token.
- Folders: Inbox, Sent, All, Archive, Trash, Junk, Drafts.
- Compose, reply, reply-all, forward; drafts autosave; attachments on drafts.
- Message HTML is sandboxed; remote images do not load.
- Sign out clears the session (or tab tokens).

## Closing the epic

Phase 6 acceptance (#355) closes when: adversarial suite green, Playwright
critical journeys green in CI, this doc merged, and no open critical/high from
the ledger. Epic #338 closes after #355.
