# Changelog

Notable changes per release. SemVer-style: **v1.0.0** is the first production-ready
Core v1.0 mailbox (M1 contract). Newest first. This tracks the inbound Worker +
`postern-client` release train (the `v*` tags).

`@skyphusion/postern-mcp` (`mcp/`) rides its own `postern-mcp-v*` tag track and is
deliberately **release-less**: those tags get no section here and cut no GitHub
Release, because the npm registry is that train's ledger and duplicating it in two
places is how ledgers drift. Its tag-to-`mcp/package.json` version lockstep is
enforced by the shared tag preflight (`.github/scripts/tag-preflight.sh`), so a
mismatched MCP tag fails before it publishes.

## Unreleased

- **BREAKING (imap door + inbound): role membership is configured ONCE, on the Worker**
  (#438). `POSTERN_IMAP_VIEWER_ROLES` is RETIRED: the door reads the parsed map from the
  new `GET /api/imap/roles` (`imap` scope, the least-privilege door token) instead of
  parsing a verbatim mirror of `POSTERN_VIEWER_ROLES`. Two configurations of one fact
  could disagree, and the broader side showed a queue to someone the other did not, which
  is the divergence #425 exists to close.
  **Operator migration, in order:** move the same value to the Worker var
  `POSTERN_VIEWER_ROLES`; provision `POSTERN_API_TOKEN_IMAP` if unset (role queues now
  require it); deploy the WORKER; then roll the door with `POSTERN_IMAP_VIEWER_ROLES`
  UNSET. A door that still sets it REFUSES TO START, naming those steps -- a var that
  looks applied and does nothing is how a queue goes dark. A door rolled ahead of the
  Worker serves no role queue (404 -> fail closed, loud) and mail is unaffected.
  Membership is read per session on the first LIST/SELECT, inside the thread pool, and
  cached process-wide for `POSTERN_IMAP_ROLES_TTL_SECONDS` (default 300, `0` disables).
  That TTL is a REVOCATION bound: an expired map is DROPPED, never served as a fallback,
  so a member removed from a queue loses it within the TTL even if the Worker is
  unreachable. There is no on-disk last-known-good, deliberately (the door is a stateless
  container, and a cache outliving the process would outlive a revocation).
  The refusal set did not move: the Worker parser still drops the WHOLE map on any
  malformed or ambiguous entry, and the door inherits that by construction, adding only
  the structural checks the Worker cannot own (a response it will not build folders from,
  two roles colliding on one folder name), also whole-map.

## v1.2.1

Door patch: the v1.2.0 image shipped two defects in the FETCH hot path, both fixed here.
No schema change; no worker API surface change. The door image roll off this tag is the
real payload.

- **imap door (#457):** per-message FETCH body hydration ran ON the reactor thread (the
  one residual #416 part 2 pinned honestly). Measured: a `FETCH 1:10` against a 200ms
  worker froze every OTHER connected client for 2405ms of a 2399ms command, in ten
  separate stalls, each able to run to the full `api_timeout` against a dead worker.
  `do_FETCH` now PRE-RUNS the accessor reads the render is about to make in the
  threadpool (`fetchwarm.fetch_reads` + `prehydrate`), so the render reads memory:
  flat zero stalls, with lazy hydration proven preserved (a header scan still fetches
  no body, `BODY[i]` still pulls one attachment). Bench + method: `imap/bench/` (#463).
- **imap door (#456 residual):** leftover debug instrumentation (`DEBUG in_pool enter`
  printed unconditionally to stderr on EVERY worker call, ignoring the opt-in
  diagnostic levers) is removed (#463).
- **mcp (own tag, noted here for the record):** `mailbox_search`/`mailbox_list` gained
  `seenFor`, the last declared worker param the client could not send (#453, #462);
  ships on the next `postern-mcp-v*` tag.
- **operator note (no code):** the v1.2.0 deploy's live-smoke leg failed 401 because the
  smoke read credential had been orphaned by an out-of-band worker-secret re-set the day
  before (crew-secrets#231); production itself was healthy and verified by API read-back.
  The credential is re-minted with real escrow, the read set now has a custody roster +
  re-set procedure, and the smoke leg is expected green on this tag.

## v1.2.0

The 2026-07-26 intake sprint: all 12 issues filed by the v1.1.0 evaluation (#413-#420, #422,
#425, #427, #429) plus the #436 audit-scripts arc. MINOR because real capability shipped:
webmail role queues, honored session `to=`, the generated route contract, and a door that no
longer freezes whole-mailbox under a slow call. No schema change; no migration ships with
this tag. First tag through the shared preflight (#418), which itself ships here.

- **release safety (#418):** ONE shared preflight (`tag-preflight.yml` ->
  `tag-preflight.sh`) gates every tag workflow via `needs:`, asserting the tag equals all
  four version pins, `CHANGELOG.md` has a non-empty section, and the tag is on
  `origin/main`; `postern-mcp-v*` tags get the same gate against `mcp/package.json`.
  After `wrangler deploy` the workflow verifies the ARTIFACT: it reads the live deployment
  back and asserts production serves the uploaded version, then runs the live smoke when
  the `POSTERN_SMOKE_*` secrets are configured (#434).
- **route contract (#417):** `inbound/src/routes.ts` is the single source of the API
  surface; the live scope gate DERIVES from it (the api.ts if-chain is gone), and
  `npm run routes:emit` projects it to `contracts/api-routes.json` +
  `contracts/api-params.json`. Four suites keep it honest, including one contract suite
  per client (mcp, python, imap door) asserting each emits only what the contract
  declares (#449, #452, #455, #459).
- **webmail roles (#425):** new worker var `POSTERN_VIEWER_ROLES` (mirrors the door's
  `POSTERN_IMAP_VIEWER_ROLES` verbatim); role addresses appear as their OWN folders with
  per-member seen state; `GET /api/roles` (admin scope) is the operator drift-diff
  surface (#437). Optional var; absent means no role folders.
- **inbound (#422):** a session's `to=` is HONORED as a recipient filter inside the
  account boundary instead of being silently swallowed (#444).
- **inbound (#429):** the pre-gate session dispatch gets the route error envelope;
  unknown errors answer a fixed 500 and never echo internals onto the sign-in
  surface (#441).
- **imap door (#416):** worker calls run in the reactor threadpool with per-thread
  connections, so one slow call no longer freezes the whole door (measured 15s ->
  gone); NO responses surface the worker's reason instead of a bare status (#446,
  #456). Residual: per-message FETCH body hydration, tracked as #457.
- **imap door (#427):** LIST/LSUB patterns match the WHOLE mailbox name (RFC 3501
  6.3.8), with non-wildcard metacharacters escaped (#443).
- **relay (#414):** a worker 403 now answers SMTP 451 (queue-and-retry) instead of a
  permanent bounce; MIME part cap aligned with the worker's attachment cap (20); loud
  deprecation warning on the legacy re-send path (#433).
- **clients:** python client closes the worker parity gap (attachments, filters,
  folders, drafts) (#413, #440); mcp wire types and search/list params synced to the
  worker, including the auth block (#415, #445).
- **ci (#419, #420):** `npm audit --audit-level=high` gates the npm surfaces, coverage
  floors enforced, corpus-notify repo-guarded (#435); audit actions SHA-pinned and the
  fleet pin single-sourced (#439).
- **ci (#436):** the adversarial-audit workflow checks its scripts out of the PUBLIC
  `skyphusion-labs/security-audit` repo (pinned at v0.2.0); the fleet deploy key and
  read token are gone from this repo's workflows (#451).

## v1.1.0

The 2026-07-25/26 evaluation sprint: a full up-to-par audit of the repo (docs, security,
components, CI/release) plus the fixes it demanded. MINOR because real capability shipped:
named viewer lenses, role-address folders, per-reader seen rendering, and webmail login
hardening. Migration `0014` ships with this tag (additive, auto-applied).

- **inbound:** `direction` now filters the STORED wire fact exactly, on both read endpoints and
  in every search mode; the viewer-relative views are NAMED lenses instead (`lens=inbox|sent`,
  needs a viewer, not combinable with `direction`) (#403, the read-back defects). Before this, a
  caller asking "did anything arrive for X" could get X's own sent copy back under
  `direction=inbound`. The #350 INBOX view is unchanged, it just has its name now.
- **inbound:** `fts` search joins tokens with AND, so ABSENCE is representable: a marker string
  that exists nowhere returns an empty set instead of every message sharing one of its words
  (#403). `/api/messages` also now REFUSES an invalid `direction` instead of silently ignoring it.
- **inbound:** `seenFor=` on `GET /api/messages` + `/api/search` renders a chosen reader's
  per-recipient seen state independent of the row predicate (#404's enabling half). A bound
  session may only name itself; absent, byte-identical to before.
- **imap:** role addresses get their OWN folders (#404): `POSTERN_IMAP_VIEWER_ROLES` maps
  `role@dom=member@dom+member@dom`; members see `Roles/<localpart>` under a `\Noselect` parent,
  INBOX stays personal, read state stays per member (never "the queue is handled"), every
  non-read write refuses honestly. per_account mode only; estate default byte-identical.
  Fail-closed on malformed config, non-members, and underivable viewers.
- **inbound (webmail sessions):** the durable brute-force lockout deferred from #351 finally
  shipped (#409): per-account + per-client-IP counters in D1 (migration `0014`), backoff with
  `429` + `Retry-After`, fail-closed `503` when the counter store is unreachable, enumeration
  posture preserved. Plus: the mint path now enforces the repo body cap (`413`) and refuses
  cross-site mints (login CSRF). All still dark unless `WEBMAIL_AUTH_BACKEND=native`.
- **inbound (webmail):** marking a message read in a session no longer flips row-level seen
  estate-wide or clobbers other recipients' read state (#410): the session identity is bound as
  the seen viewer, a mismatched `for` is refused, and the message-access gate applies. Bearer
  token callers (the IMAP door) are byte-identical. The message iframe also carries its own CSP
  now, so the sandbox attribute is not a single point of failure.
- **mcp (own tag, noted here for the record):** `mailbox_reply` finally carries `attachments`,
  `mode` (`reply`/`replyAll`) and `quote_original` (the worker accepted all three since #363; the
  tool schema said otherwise); `mailbox_list`/`mailbox_search` gained `lens`, and search echoes
  `mode`/`viewer`/`lens`. Published as **postern-mcp 1.3.0** (`postern-mcp-v1.3.0`).
- **python:** `postern-client` gains `lens` on list (`--lens` in the CLI); version 1.1.0
  (lockstep with this tag), and `__version__` is synced (it had drifted to 1.0.4 while 1.0.6
  published; the publish gate now asserts it too).
- **deps:** postcss bumped past GHSA-r28c-9q8g-f849 in `mcp/` (#431; Dependabot alert 19).
- **docs:** the evaluation's 22-finding docs sweep (#412): DEPLOY/README no longer claim
  merge-deploys (tag-gated is the truth), the quickstart's seed step no longer hard-errors on a
  fresh install, OPERATIONS backup covers ALL tables (it silently lost drafts, placement,
  per-recipient seen, and UID counters), IMAP-APPLE-MAIL reflects durable Drafts/Trash, and the
  scoped-token slots are documented in DEPLOY. `docs/AUTH-CONTRACT.md` is rewritten as the
  PORTABLE one-login contract (#424); the operator-specific record moved to the operators'
  private infrastructure repository, same route as the deploy runbooks.
- **evaluation intake (filed, not fixed here):** #413-#420 track the remaining findings --
  python-client API parity, relay 403 bounce mapping, MCP surface rot, IMAP door error
  passthrough + reactor blocking, cross-seam contract tests, tag-workflow preflight, npm audit
  gates + coverage floors, adversarial-audit hardening. #422, #425, #427, #429 are adjacent
  findings from the sprint's own lanes.

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

Worker deploy only -- **corrected 2026-07-26: run-level evidence shows both door images ALSO
built and dispatch-rolled on this tag** (imap-image run 30162386466, relay-image run
30162386461), so what shipped was the worker plus both door images; no GitHub Release and no
PyPI artifact. The inbound Worker shipped; the PyPI and GitHub-release legs did NOT run,
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