# Fable product-gap review, 2026-07-17

Whole-repository deep dive per issue #337: gaps, defects, weak contracts, and the wider-release
roadmap for Postern.

- **Reviewer:** Claude Fable 5 (model id `claude-fable-5`), deep reasoning enabled, with four
  scoped evidence sweeps (core worker, human doors, machine doors, delivery/ops/product) run on
  the same model and every load-bearing claim re-verified against source by the lead reviewer.
- **Reviewed commit:** `c5118ac6f50d899044e67eea261fc6d40cad6a64` (main tip at review time).
- **Method:** docs read first (CONTRACT, AUTH-CONTRACT, SEND-IDENTITIES, DEPLOY, component
  READMEs), every material claim verified in code or tests; TODO/FIXME and dead-code sweep;
  the five end-to-end journeys from #337 traced in source; static checks and full test suites
  run; findings deduplicated against the open backlog (#335, #338) and closed decisions (#280).
- **Excluded from reading, by standing rule:** `inbound/wrangler.ci.json` (secret-derived) and
  the untracked local `imap/smoke/` scratch.

## Commands run

All green at the reviewed commit:

| Command | Result |
|---|---|
| `cd inbound && npm run typecheck` | pass |
| `cd inbound && npx vitest run` | 28 files, 328 tests, all pass |
| `cd mcp && npm run typecheck` | pass |
| `cd mcp && npx vitest run` | 5 files, 36 tests, all pass |
| `cd relay && go vet ./... && go build` | clean, builds |
| `cd imap && python3 -m twisted.trial posternimap.tests` | 383 tests, all pass |

Two candidate CI findings from the ops sweep were **killed in verification** (the pinned
`actions/*` majors and `actions/upload-code-coverage` are all real public artifacts; the sweep's
public-registry knowledge was stale). They are excluded below; only verified findings remain.

## What holds up (verified strong)

The security and contract fundamentals the docs claim were verified true in code, notably:
constant-time token comparison everywhere (including the PBKDF2 dummy-hash timing equalization);
per-identity send registry that is deny-by-default with server-authoritative From; the transport
vs API token separation failing closed; atomic dedup-v2 upsert; durable AUTOINCREMENT uids; FTS
query sanitization and LIKE escaping on the substr path; CRLF header-injection rejection on send;
streaming body caps; attachment download hardening (nosniff, sandboxed CSP); the relay's
loopback-only intake enforced fail-closed at startup; MAX_RECIPIENTS=50 in sync on both sides of
the seam; submission AUTH TLS-only with From-spoofing rejected; webmail's no-innerHTML discipline
and empty-sandbox srcdoc rendering; the IMAP door's \Seen round-trip, base64 attachment CTE
invariant, and redacted wire trace. Migrations gating (destructive-shape blocking,
ships-with-code ordering) is genuinely strong. Licensing (AGPL core, MIT clients), SECURITY.md,
and Dependabot coverage are coherent.

## Findings

Severity: release-blocker / high / medium / low / opportunity. Status: new issue / tracked /
accepted limitation / doc fix. File references are at the reviewed commit.

### Core worker (`inbound/`)

| # | Sev | Finding | Evidence | Impact | Recommendation | Status |
|---|---|---|---|---|---|---|
| C1 | high | No migration creates the base `messages` table; DEPLOY's "Greenfield alternative" (skip schema.sql, apply migrations) fails at 0001 with "no such table" | `inbound/migrations/` (no 0000; 0001 ALTERs `messages`), DEPLOY.md:87-90 | One of the two documented install branches is broken for every fresh clone | Add a `0000_base_schema.sql` or delete the greenfield paragraph | new issue |
| C2 | medium | `/api/send` and `/api/reply` have no idempotency; dispatch-then-store ordering means a retry after timeout or a store failure after dispatch double-sends | `inbound/src/mailbox.ts:385`, `:223` | Duplicate outbound mail on client retry; sent copy can be lost while mail went out | Optional Idempotency-Key short-circuit; document at-least-once semantics in CONTRACT s3 | roadmap (distinct from the #280 queue decision, which is an accepted limitation gated on an SLA) |
| C3 | medium | Attachment bytes and rows are written best-effort via `ctx.waitUntil` after the response, console.error only, no audit or reconcile (vectors have one, attachments do not) | `inbound/src/store.ts:302-305`, `:336` | Killed isolate or R2 error leaves a message with unrecoverable missing attachments and no detection | Attachment-presence audit; consider awaiting the R2 write on ingest | roadmap |
| C4 | medium | No `delete` scope exists; DELETE requires `admin`, satisfied only by `both`, so the IMAP door's "dedicated delete token" is necessarily a full-admin token | `inbound/src/api.ts:540` (`RouteScope = read/send/admin`), `:551-560`, AUTH-CONTRACT.md:331 | The least-privilege posture breaks exactly at the one credential handed to a network-facing door | Add a real `delete` scope | roadmap, top 10 |
| C5 | medium | Stored searchable `body_text` is silently lossy: quoted replies and signatures stripped, 32k cap; search cannot match text visible in the client | `inbound/src/ingest.ts:80-81`, `:209` | Undocumented fidelity gap in the search and read contract | Document in CONTRACT s1; consider indexing pre-clean text for FTS | doc fix + roadmap |
| C6 | low | `list()` to and from filters do not escape LIKE metacharacters (`%`, `_`), unlike the substr path | `inbound/src/store.ts:832-838` vs `:990` | Wrong matches on filter values containing wildcards (bound params, so no injection) | Reuse `escapeLikePattern` with ESCAPE | small fix |
| C7 | low | `reconcile()` is read-only; no prune code exists for reported orphan vectors | `inbound/src/store.ts:1295-1639`, comment at :1316 | Pre-ledger orphans accumulate unboundedly, manual-only remediation | Ship the gated prune or document as a permanent manual op | roadmap |
| C8 | medium | No rate limiting on send/search/reply and no structured logs or metrics (console.* only) | whole worker | A leaked send token allows unlimited 50-recipient blasts; failures visible only as console noise | Per-token rate limit on send; structured logging | roadmap, top 10 |
| C9 | low | `/api/threads/{id}` is unpaginated with an N+1 attachments query per row | `inbound/src/store.ts:699-714` | Pathological threads return everything expensively | Paginate or cap | roadmap |
| C10 | low | `isTrusted` grants trusted=1 from allowlist From alone when SPF and DKIM verdicts are both absent (reachable on the transport-token-gated `/ingest` path) | `inbound/src/ingest.ts:181-196` | The trusted flag is weaker than it reads on that path; low real risk | Document the assumption in CONTRACT | doc fix |

### Human doors (`webmail/`, `imap/`)

| # | Sev | Finding | Evidence | Impact | Recommendation | Status |
|---|---|---|---|---|---|---|
| D1 | high | RFC822.SIZE computation hydrates the full projection including a download of every attachment; bulk `UID FETCH 1:* (RFC822.SIZE ...)` (normal client sync) costs one message GET plus N attachment GETs per message, serialized on the reactor | `imap/posternimap/message.py:329-340`, `:193-199` | Cold-sync cost cliff and a stall for all connected clients on any attachment-bearing mailbox. Note the constraint: SIZE MUST byte-match the projected BODY[] literal (RFC 3501; the in-code comment correctly forbids the wire_size shortcut), so the fix is a cached projected length, not stored wire size | Cache the rendered projection length (invalidate with the projection); lazy per-part attachment fetch | new issue |
| D2 | high | `_hydrate` downloads ALL attachments even for a text-only BODY[TEXT] read | `imap/posternimap/message.py:193-199` | Reading one line of a 20MB-attachment mail costs 20MB | Same issue as D1: per-part lazy fetch keyed on the requested BODY[i] | new issue (with D1) |
| D3 | high | The "Load remote images" opt-in is non-functional on the supported same-origin `/webmail` path: the served CSP `img-src 'self' data:` is inherited by the srcdoc iframe, so the opt-in still blocks remote loads | `inbound/scripts/sync-webmail.mjs:56-62`, `webmail/index.html:472-487` | The privacy default works, but the documented escape hatch (README) silently does nothing | Make the opt-in real (dynamic CSP) or remove/document it as inert | new issue |
| D4 | medium | Served webmail CSP includes `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`; the security docs describe only the strict directives, and tests never assert script-src. The sole top-frame XSS control is the no-innerHTML discipline (guarded by one regex test) | `inbound/scripts/sync-webmail.mjs:56-62` vs webmail/README security posture and COMPOSE.md s6 | Single-layer defense presented as multi-layer | Truth up the docs; assert the full policy in webmail.test.ts | new issue (with D3) |
| D5 | high | APPEND into the real views (INBOX, Sent, All) silently discards the message with a tagged OK. Justified only for the post-send Sent copy; a genuine APPEND (drag from another account, Sent copy after sending via non-Postern SMTP) is silent data loss | `imap/posternimap/account.py:220-236`, `server.py:302-344`, `mailbox.py:709-715` | The F11 silent-loss class, reintroduced for real views | Distinguish the already-stored sent copy from a genuine new APPEND, or refuse with NO | new issue |
| D6 | medium | COPY/MOVE-to-Trash hard-deletes from the store in the same round trip; "moving back" from Trash hits the D5 no-op with the body already gone, so an apparent undo is permanent loss | `imap/posternimap/server.py:387-435`, docs/IMAP-APPLE-MAIL.md | Trash semantics are a trap despite being documented | Real soft-delete window, or refuse restore-from-Trash loudly | new issue (with D5) |
| D7 | medium | Trash staging is process-wide, unbounded (cleared only on EXPUNGE or restart), and keyed on the free client-chosen username label in token mode | `imap/posternimap/account.py:134-138` | Unbounded memory; divergent Trash views per label over the one mailbox | TTL/bound the staging; key on token identity | roadmap |
| D8 | medium | Blocking urllib on the reactor thread serializes the whole door; one slow upstream call stalls every connected client | `imap/posternimap/client.py`, `mailbox.py:880-889` | Fine for one self-host user; degrades badly shared | deferToThread or async client before multi-user scale | roadmap |
| D9 | medium | Non-pushable SEARCH shapes fall to manual search that hydrates (and, per D2, downloads attachments for) every message in the window | `imap/posternimap/server.py:591-619` | Expensive and reactor-blocking for common compound searches | Extend pushdown | roadmap (related: parked #222 upstream matchers) |
| D10 | medium | Read state diverges between doors: IMAP persists \Seen, webmail neither displays nor sets it | webmail/index.html (no seen usage) vs `imap/posternimap/mailbox.py:604-686` | Same store, contradictory read-state UX | Webmail displays and sets \Seen | tracked (#338) |
| D11 | medium | Webmail accessibility and mobile: no roles/tabindex/keyboard navigation, no media query (fixed 360px sidebar), alert() errors | `webmail/index.html:620-637`, `:54-56`, `:344` | Not keyboard- or screen-reader-usable; no mobile layout | a11y/responsive foundation | tracked (#338) |
| D12 | low | Documented compose deferrals (no cc/bcc, attachments, HTML, drafts, reply-all, forward, delete, bulk, identity display); replying to an HTML-only mail quotes an empty body | COMPOSE.md s3-4, `webmail/index.html:750` | Known deferrals; the empty-quote is a real papercut | Quote a text rendering of bodyHtml when bodyText is empty | tracked (#338) |
| D13 | low | imap README "Known limitations" still describes interim ordinal UIDs; the code ships durable store-rowid UIDs | imap/README:242-249 vs `mailbox.py:30-47`, `:249-256` | Docs understate shipped behavior | Refresh the README | doc fix |
| D14 | low | When the real client IP is unrecovered (PROXY misconfigured behind an L4 LB), all logins share one throttle bucket: one brute-forcer locks out everyone | `imap/posternimap/server.py:138-144` | Self-DoS config footgun | Startup warning when peer IPs all match one host | roadmap |
| D15 | opportunity | native/ldap/system auth grants every authenticated directory user the ONE shared mailbox; group gate optional | imap/README:82-98 | Surprising posture for directory admins | Explicit doc callout | doc fix |

### Machine doors (`mcp/`, `clients/python/`, `relay/`)

| # | Sev | Finding | Evidence | Impact | Recommendation | Status |
|---|---|---|---|---|---|---|
| M1 | high | MCP has no attachment-read tool: agents see attachmentCount and metadata but cannot fetch bytes (the Python client can) | `mcp/src/tools.ts:40-107` vs `clients/python/.../client.py:227` | Hard dead-end for an agent on any mail with attachments; breaks "agents are first-class" | `mailbox_get_attachment(message_id, index)` returning base64 + mime + filename | new issue |
| M2 | medium | MCP send tools cannot attach files although the worker API accepts `attachments[]` | `mcp/src/types.ts:56-69` | Agents can never send a file | Optional base64 attachments on send/reply | new issue (with M1) |
| M3 | low | Version drift: package 1.1.1, McpServer advertises 1.1.0 | `mcp/package.json:3` vs `src/index.ts:33` | Wrong handshake version | Source from package.json | small fix |
| M4 | low | MCP search mode enum omits substr and the field selector the contract defines | `mcp/src/tools.ts:35` vs CONTRACT s10.8 | No exact-substring or field-scoped agent search | Add them | small fix |
| M5 | low | Stale comment says direction filtering is not wired on /api/search; it is | `mcp/src/client.ts:59-62` | Misleads maintainers | Fix comment | small fix |
| M6 | opportunity | No mark-seen MCP tool | POST /api/messages/seen exists, read-scoped | Agent triage cannot mark processed | Optional tool | roadmap |
| M7 | medium | Python `search()` and the CLI cannot filter by direction although list can, MCP search can, and the README claims exact contract parity | `client.py:209-225`, `cli.py:98-102`, python README parity claim | Client/contract asymmetry, false parity claim | Add direction (and field) | small fix |
| M8 | low | `ping()` returns False only on auth errors; scope-403 and network errors raise raw | `client.py:240-246` | Untidy failure UX | Document or normalize | small fix |
| M9 | low | Python package 0.1.0/Beta with no changelog | pyproject | Weak maturity signals | Add CHANGELOG | small fix |
| M10 | medium | Legacy relay inbound path (no POSTERN_INGEST_URL) silently drops attachments, cc, and envelope fidelity | `relay/smtp.go:83-129`, `client.go:15-22` | Silent inbound data loss on legacy-configured deploys | Deprecate the legacy path or refuse attachments loudly | new-ish; smallest fix is doc + warning |
| M11 | low | Hardcoded stale User-Agent "skyphusion-email-relay/0.2.0" | `relay/client.go:11` | Cosmetic; misleading in upstream logs | Build-stamp | small fix |
| M12 | opportunity | Relay auth throttle is in-memory per process; multi-instance multiplies the brute-force budget | `relay/throttle.go:24-25` | Documented; matters only at scale | Note in ops docs | doc fix |

### Delivery, operations, docs, product

| # | Sev | Finding | Evidence | Impact | Recommendation | Status |
|---|---|---|---|---|---|---|
| O1 | high | No backup, restore, or disaster-recovery documentation exists anywhere in the product tree for the D1 store or R2 attachments | whole tree; DEPLOY.md:93 is the only mention of the word | A self-hoster can lose all mail with no recovery path; journey-5 ops gap | docs/BACKUP.md: scheduled `wrangler d1 export`, R2 copy guidance, a restore-into-fresh-store procedure | new issue |
| O2 | high | The production custom-domain API door is undocumented: `workers_dev:false`, no routes example anywhere, DEPLOY flips workers_dev on only for smoke and says production "adds a custom route" without showing how | `inbound/wrangler.jsonc:12`, DEPLOY.md:36-39 | The clean-install journey strands operators on the explicitly non-production workers.dev posture | DEPLOY production section plus a commented routes block in the template | new issue |
| O3 | medium | Human doors are absent from the clean-install narrative: DEPLOY points at `imap/` in passing; the IMAP and webmail bring-up path is not in the journey | DEPLOY.md:116-117 | "Email for humans" self-host journey hits a documentation cliff | "Human doors (optional)" DEPLOY section | new issue (with O2) |
| O4 | medium | DEPLOY baseline-seed list is stale (hardcodes 0001..0007, omits 0008); harmless today (0008 is idempotent) but the copy-paste pattern breaks on the next non-idempotent migration | DEPLOY.md:69-79 | First CI deploy failure for future fresh installs | Refresh plus "regenerate from ls migrations/" | doc fix |
| O5 | medium | CHANGELOG documents v1.0.2 (2026-07-17) but tags stop at v1.0.1; release workflow fires on tag push only | CHANGELOG.md:6, `git tag` | Version discipline drift; no v1.0.2 release exists | Push the tag or hold the entry | operator action |
| O6 | medium | No CodeQL/SAST and no secret-scanning workflow (dependency-vuln gates DO exist: govulncheck, pip-audit) | `.github/workflows/` | Static-analysis gap for a public mail server parsing untrusted MIME | CodeQL (js, go, python) plus push protection | roadmap |
| O7 | medium | No CONTRIBUTING, code of conduct, or issue/PR templates on a repo inviting self-hosters | repo root, `.github/` | No contributor onramp | Short CONTRIBUTING plus one template | roadmap |
| O8 | medium | `/health` and Workers observability exist but no operator doc mentions monitoring or alerting | `inbound/src/api.ts:45`, `wrangler.jsonc:7` | Self-hosters have primitives with no guidance | Monitoring section in the ops doc (bundle with O1) | new issue (with O1) |
| O9 | low | Doc maps omit docs/PROXY-PROTOCOL.md and docs/reconcile-orphan-vectors.md | CLAUDE.md, docs/architecture.md | Two real docs undiscoverable | Add to maps | doc fix |
| O10 | low | Residual CI question: can a fork PR satisfy the required `coverage` check (token/permissions on fork runs)? The action itself is public (verified) | `.github/workflows/code-coverage-ts.yml` | If not, external PRs stall on a required check | Verify with a test fork | verify |
| O11 | opportunity | No examples/ directory (curl walkthrough, agent config samples) | repo root | Polish | Add examples/ | roadmap |

## Journey verdicts

1. **Receive, store, search, read, attachment:** clean end-to-end. Soft spots: best-effort
   attachment durability (C3), silently lossy searchable body (C5).
2. **Authenticated send/reply, stored copy, door visibility:** correct and threads completely.
   Gap: no idempotency, dispatch-before-store (C2). Doors agree on Sent; read state diverges (D10).
3. **Agent via MCP:** happy path read-search-reply works. Breakpoints: send tools silently
   unregistered when the send token is absent (stderr-only signal), attachment bytes unreachable
   (M1), cannot send attachments (M2), retryable 502s surface generic.
4. **Clean self-host install:** the send-store-reply smoke path is fully performable and the $5
   Workers Paid assumption is honestly stated. Cliffs: broken greenfield branch (C1), no
   production door (O2), human doors out of the narrative (O3), no backup after go-live (O1).
   The "~10 minutes" README claim is credible for the smoke posture only.
5. **Delete, retention, recovery:** the delete path itself is well-ordered (Vectorize and ledger
   before D1, abort on failure, no new orphans). But IMAP Trash is an undo-shaped permanent
   delete (D5/D6), historical orphan vectors have no prune (C7), and there is no backup/restore
   story at all (O1).

## Release-readiness verdict

**Sound for its current audience; not yet ready for a wider "bring the humans" release.**

v1.0.1 is a genuinely solid agent-first mailbox: the core worker's contracts and security
fundamentals verify true in code, all 747 tests pass at the reviewed commit, and the agent and
API journeys work as documented. The wider-release gaps cluster in three places: (1) the
self-host story breaks exactly where a new operator leaves the smoke posture (broken greenfield
branch, undocumented production door, no backup story); (2) the human doors carry silent
data-loss traps (APPEND discard, Trash-restore illusion) and an attachment-hydration cost cliff
that will hurt the first real mailbox with attachments; (3) two security documents overstate the
webmail posture (inert remote-images opt-in, undocumented unsafe-inline CSP). None of these are
architectural; all are fixable without new dependencies.

## Top 10 prioritized actions

1. Fix the install paths: base-schema migration or remove the greenfield branch (C1), document
   the production route with a template example (O2), add the human-doors section (O3), refresh
   the seed list (O4).
2. Write the backup/restore/DR plus monitoring doc (O1, O8).
3. IMAP hydration economics: cached projected SIZE (respecting the RFC byte-match constraint)
   and lazy per-part attachment fetch (D1, D2).
4. Webmail honesty: make the remote-images opt-in real or remove it; truth up and test the full
   CSP (D3, D4).
5. APPEND/Trash data-loss class: refuse or store genuine APPENDs, make Trash semantics
   impossible to mistake for recovery (D5, D6).
6. MCP attachment access, read and send (M1, M2).
7. A real `delete` scope for the door credential (C4).
8. Send idempotency key and documented at-least-once semantics (C2), attachment-presence
   audit (C3).
9. Rate limiting and structured logging (C8); CodeQL and secret scanning (O6).
10. Community onramp: CONTRIBUTING and templates (O7), tag/CHANGELOG sync (O5), stale-doc
    refresh (D13, O9, M5).

## Release-blocker checklist (next wider release)

- [ ] C1 greenfield install branch fixed or removed
- [ ] O2/O3 production door and human-doors bring-up documented end to end
- [ ] O1 backup/restore procedure published
- [ ] D1/D2 SIZE and body reads no longer download attachments
- [ ] D3/D4 webmail CSP docs truthful; remote-images opt-in functional or gone
- [ ] D5/D6 no silent APPEND discard; Trash cannot masquerade as recovery
- [ ] M1 agents can read attachments over MCP

## Three-horizon roadmap

**Now (blockers above):** items 1-6 of the top 10.

**Next:** #338 phase 1-3 (auth/session contract, durable folders/flags/drafts, webmail seen
state, a11y/responsive foundation); delete scope (C4); idempotency (C2); rate limiting and
structured logs (C8); MCP/Python parity papercuts (M4, M5, M7, M8); IMAP concurrency
(deferToThread, D8) and Trash staging bounds (D7); relay legacy-path deprecation (M10).

**Later:** contacts/address book (per the #338 decision), examples directory, per-user mailbox
isolation posture for directory-auth deployments (D15), durable outbound queue if and only if a
concrete SLA materializes (the #280 gate), byte-exact FETCH milestone (retires the projection
constraint behind D1), signatures and scheduled send.

## What not to build

- A second store anywhere: every door stays a client of the one mailbox API.
- A webmail framework/build-step rewrite without the evidence threshold #338 sets.
- A durable send queue ahead of the #280 SLA gate.
- An RFC822.SIZE "optimization" that serves stored wire size: it breaks size-validating clients
  by disagreeing with the projected BODY[] literal (the in-code comment is correct; keep it).
- Calendar/tasks/chat suite; ad/tracking anything; replacements for standards-based clients.
- Forced hosted-account infrastructure on self-hosters (the #338 constraint stands).

## Follow-through

Focused follow-up issues are filed for the confirmed untracked high findings (C1, D1/D2, D3/D4,
D5/D6, M1/M2, O1/O8, O2/O3) and linked from #337. Mediums and lows stay in this roadmap until
selected for a sprint. No fixes ship in this review PR.
