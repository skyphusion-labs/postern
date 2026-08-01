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

## v1.3.8

**Incident patch. v1.3.7's door image could not start.** `imap/posternimap/rfc822.py`
carried a docstring example using the escape sequence `\udcc3\udca9`, meant to show
two backslash escapes as visible text. The docstring is a normal (non-raw) string, so
that sequence compiled to two REAL, unpaired UTF-16 surrogate code points in the
constant. CPython 3.13+ refuses to compile a module containing one; the door image is
`FROM python:3.14-slim`. The `imap` CI job, and separately `imap-image.yml`'s own
pre-build gate job, both pinned Python 3.12, which still tolerated it, so 686 passing
trial tests and a clean mypy run said nothing about the interpreter the image actually
ships. Two of three production doors went to 0/1 and the third flapped; service was
restored by rolling back to the v1.3.6 image (`9f7a768`) while this was fixed.

- **imap: the docstring escape no longer materializes as a live constant.** One line:
  the backslashes are doubled, so the example still shows the escape sequence as text
  without compiling it into one. The documented compat32 behavior is unchanged and the
  example itself was kept -- it is real, load-bearing documentation of what
  `header_text` relies on.
- **Both gates that missed it are now pinned to Python 3.14**, matching
  `imap/Dockerfile`'s `FROM` line: `ci.yml`'s `imap` job, and `imap-image.yml`'s own
  pre-build `gate` job, which is the literal step that stood between source and the
  `build` step that produced the broken image. A green suite on a different
  interpreter than production is not evidence about production.
- **New guard** (`imap/posternimap/tests/test_no_lone_surrogates.py`): walks every
  `.py` file's AST and asserts no string constant contains a lone surrogate code point
  (U+D800-U+DFFF), so this class cannot return silently.

**No UIDVALIDITY bump, no reproject sweep for this release.** Nothing about the
projection or the store changes -- v1.3.8 only fixes whether the door process can
start. Do not repeat v1.3.7's supervised-deploy steps here.

## v1.3.7

**Supervised deploy.** #529 changes the announced `RFC822.SIZE` for every existing UID
dated on days 1-9 of any month once the reproject sweep runs. The served `BODY[]`
bytes do NOT change -- the door's render was always correct and this release moves the
worker's projection onto it -- but RFC 3501 section 2.3.1.1 names the RFC-2822 size
among the data that must never change for a given mailbox + UIDVALIDITY + UID, so a
`POSTERN_IMAP_UIDVALIDITY` bump is a MUST, not a precaution. The practical reason is
the stronger one: clients cached the WRONG size for those UIDs, and the bump forces a
clean resync, which is the only reliable way to clear that cached bad state. Order and
steps are the same as #507: worker deploy, then the reproject sweep, then the door
image roll. Every intermediate point is safe on its own (a version-mismatched row
falls back to a live hydrate-and-measure, per `PosternIMAPMessage.getSize`), so the
ordering is about correctness of the final state, not about avoiding a crash
mid-rollout. Do not ship this without the window.

- **imap: an out-of-range `BODY[n]` no longer drops the connection** (#530). Twisted's
  `spew_body` has no error path for a bad section number: once `IMAP4Server` has
  written the untagged `* n FETCH (` prefix, any exception from a render accessor is
  unrecoverable, and `__ebSpewMessage` logs it and tears down the TCP connection. The
  door's own FETCH warm pass (#457) already ran every accessor read in a threadpool
  step wired to a clean tagged-BAD errback; it was swallowing the bad-index case along
  with genuine backend failures. Two raise sites needed covering, and the first pass
  only caught one: an out-of-range index (`getSubPart` on the root message and on a
  nested part), and a too-deep index into a part that is not itself multipart (raises
  `TypeError`, not `IndexError`, in Twisted's own walk -- found and closed in review
  before the gap could reach a live client). Gated end to end against a real Twisted
  `IMAP4Server` + `IMAP4Client`: a bad FETCH answers a tagged BAD, then a second, valid
  FETCH on the SAME connection answers with real content.
- **imap: `BODYSTRUCTURE` filename parameters no longer carry an extra layer of
  quoting** (#531). Twisted's own Content-Disposition parser
  (`_MessageStructure._disposition`) is a documented "poorly tested parser" that never
  strips the RFC 2822 quoted-string wrapper it is handed, unlike its Content-Type
  parameter handling, which does. `("filename" "repro-4096.bin")` was going out as
  `("filename" "\"repro-4096.bin\"")`. Fixed at the one place `BODYSTRUCTURE` is
  written to the wire, reversing the quoting with the exact inverse of the renderer's
  own escaping (so a filename containing a real quote character round-trips exactly,
  not merely "every quote character deleted"). The Content-Type `name=` parameter has
  an adjacent, smaller version of this gap (tracked separately as #534, not in this
  release): `unquote()` strips the wrapper but never undoes backslash-escaping.
- **inbound + imap: the Date header day-of-month is zero-padded on both sides**
  (#529). The worker emitted it unpadded ("1 Aug"); the door has always emitted it
  zero-padded ("01 Aug") via Python's `email.utils.format_datetime`. `projectRfc822Size`
  is just the worker render's byte length, so the cached `projected_size` was one byte
  short of the door's actual `BODY[]` for every message dated on days 1-9 of the month,
  roughly 30% of the mailbox at any given time. **PROJECTION_VERSION 3 -> 4**, in
  lockstep across both projectors. Gated by a real cross-engine harness
  (`imap/posternimap/tests/test_projection_cross_engine.py` + new
  `inbound/scripts/render-golden.mjs`) that runs BOTH renderers on the SAME input in
  ONE test and asserts byte equality directly, rather than two suites separately
  matching a hand-copied number -- which is how this shipped with both green in the
  first place. That pattern (each engine's suite comparing its own output to a
  hand-copied number in the other file, which looks like a cross-engine contract but
  is not one) is tracked separately for the other shared-golden tests.
- **imap: RFC 6855 `UTF8=ACCEPT`** (#504), behind a per-connection `ENABLE` gate.
  Twisted's `imap4` has no ENABLE support at all; the command, the capability, and the
  per-connection state are the door's own.
- **imap: one canonical string per stored header, and 8-bit APPEND refused on
  purpose** (#517). A stored `In-Reply-To` carrying raw 8-bit bytes had been served as
  THREE different strings by the same door, decided by whether anything else in the
  same FETCH had already forced hydration -- a summary-path fold per character
  disagreeing with a hydrated-path fold per byte, because Python's stdlib hands back a
  lossy `str()` of the underlying `email.header.Header` on one path and the Header
  object itself on the other. `rfc822.header_text()` is now the one canonicaliser both
  seams route through. Landed together with an explicit, named 8-bit-in-header APPEND
  refusal (tagged NO, never BAD; scoped to headers only, an 8-bit BODY is ordinary
  8BITMIME mail and still accepted): fixing the string bug would otherwise have turned
  an ACCIDENTAL refusal (an `AttributeError` swallowed into a useless "APPEND failed"
  message) into an accidental ACCEPT, opening a window before #504's ENABLE-gated
  refusal existed. Follow-up review (docs + tests only, no behavior change): a header
  carrying both an RFC 2047 encoded-word and raw 8-bit bytes never has that
  encoded-word decoded either, the same guarantee a pure-ASCII header already had, and
  that claim is now a pinned test with a control, not a docstring assertion.
- **inbound: `reproject-sweep.mjs` no longer FATALs on its own success path.** Its
  completion guard demanded exact equality between rows-examined and a live store
  total; on a mailbox that keeps receiving mail while the sweep runs, the total moves
  and a run that converted every row it needed to could still exit 1. Hit for real
  during the #507 rollout window: 216 pages, every row converted, exit 1 for nothing.
- **inbound: smoke leg 9 (drafts DELETE) now proves the row is actually gone**, not
  just that the server answered 200 -- brought to the same standard leg 10 already
  held (delete, then GET and require 404).
- Routine dependency bumps (GitHub Actions, `@modelcontextprotocol/sdk`, `@types/node`,
  the Cloudflare toolchain group) and a repo-hygiene fix (genericizing a leaked
  internal hostname in `imap/bench/README.md`).

No route change, no D1 migration.

## v1.3.6

**Supervised deploy.** This release changes `RFC822.SIZE` and the `BODY[]` bytes for
every existing UID, so it REQUIRES a `POSTERN_IMAP_UIDVALIDITY` bump on the same roll
and a `projected_size` backfill. RFC 3501 section 2.3.1.1 names the RFC-2822 size and
the message texts among the data that "must never change" for a given mailbox +
UIDVALIDITY + UID, so the bump is a MUST, not a precaution. Do not ship this without
the window. Order and steps are in the PR for #507.

- **imap: RFC822.SIZE now byte-matches the BODY[] literal it labels** (#507). The door
  implemented twisted `IMessagePart` but not `IMessageFile`, so `spew_body` fell back to
  `imap4.MessageProducer`, which re-serializes a message from the PARSED tree instead of
  sending the rendered projection: it re-joined the headers with CRLF, copied the body
  through verbatim, and wrote its own multipart boundary lines. BODY[] was a second
  serialization that the projected size had never described, so the announced number was
  short for every message. Measured on a raw socket: plain announced 226 and served
  {235}, html 518 against {540}, attachment 550 against {573}. The gap was
  `header_lines + 1` on single-part mail, constant in body length, NOT one byte per line
  as first diagnosed. The door now implements `IMessageFile.open()`, which both
  `spew_body` and `spew_rfc822` prefer, so there is ONE serializer and the two agree by
  construction. Gated at the wire, on all four projection shapes, in
  `imap/posternimap/tests/test_size_literal_e2e.py`.
- **imap: the served body is CRLF, as RFC 5322 requires** (#507). Separate from the size
  bug and not in the original report: the projection emitted bare LF, so every
  single-part message went out with bare-LF body lines (the header block only looked
  right because twisted re-joined it). RFC 5322 section 2.1 is explicit that CR and LF
  "MUST NOT appear independently". Both projectors now terminate with CRLF from a single
  constant (`_NL` in `imap/posternimap/rfc822.py`, `NL` in
  `inbound/src/rfc822Project.ts`) and normalize stored body text idempotently, so a body
  already carrying CRLF never gains a second CR. `_NL` had been dead code since it was
  introduced: it was defined and never referenced, and every newline was a hard-coded
  literal.
- **PROJECTION_VERSION 2 -> 3**, in lockstep across both projectors, with the shared
  golden byte constants moved together on both sides.
- **inbound: `POST /api/admin/reproject` and `scripts/reproject-sweep.mjs`, the
  projected_size backfill** (#507). A version bump invalidates every cached size at once
  and nothing refilled them, because `refreshProjectedSize` only ever ran at store time.
  Without the sweep every pre-existing row (10634 at the last live count) is a permanent
  cache miss and each `RFC822.SIZE` on old mail costs a full message hydration, which is
  the cost the #342 cache exists to remove. One keyset page per call, admin-scoped,
  idempotent, dry-run by default; every row recomputed through `store.projectedSizeFor`,
  the same entry point live ingest uses, and every write read back and reported as
  `failed` if it did not land.

## v1.3.5

Patch release. The code change is CI-only, but the deploy is the point: it is what
carries the role-queue configuration to the live Worker, since `vars` take effect only
on a full `wrangler deploy` and never on a merge.

- **Role queues are switched on** for `abuse@`, `postmaster@` and `alerts@`
  (`POSTERN_VIEWER_ROLES`). The feature has been built, tested and shipped since
  #425/#438, but the var was absent from the live Worker entirely, so no role queue had
  ever been served. Membership is set in the operator's own config, not here; the
  public template keeps its empty default. The value was validated against the real
  parser (`parseViewerRoles`) before shipping rather than eyeballed, because that parser
  fails CLOSED on the ENTIRE map: one malformed entry serves no role queue at all, which
  is indistinguishable from "that person is not on the queue". Two negative controls
  (duplicate role, role-as-own-member) were run alongside it so a green parse could not
  be vacuous.
- **ci: the drafts lifecycle now actually runs against a live instance** (PR #510).
  `inbound/smoke.mjs` leg 9 has three blocks, and the third -- create, read back,
  stale-PUT `409 E_CONFLICT`, PUT with the current `updatedAt`, DELETE -- had SKIPped on
  every run since it was written, because neither workflow supplied
  `POSTERN_IDENTITY_TOKEN`. The only `/api/drafts` behavior CI had ever proven live was
  the two refusals. Both `deploy.yml` and `smoke-staging.yml` now supply it and share one
  secret contract, so they stay at parity. The credential was pre-existing and escrowed;
  nothing was minted and nothing was rotated. The leg deletes the draft it creates, so it
  cannot leave debris. This was the last SKIP in the smoke.
- **docs: two stale claims corrected** in the `smoke-debris-sweep.mjs` header (PR #510).
  It stated that neither workflow wires `POSTERN_DELETE_TOKEN` (#496 changed that) and
  that the `draft` subject forms can never come from a CI run (the change above makes
  them possible). Both were true when written. The historical reason the 64-message
  backlog existed is preserved.

No schema change, no route change, no migration, no `PROJECTION_VERSION` or
`UIDVALIDITY` bump.

## v1.3.4

Patch release: two IMAP door correctness fixes and the structured-identifier
compliance fix. No schema change, no route change, no migration -- and no
`PROJECTION_VERSION` or `UIDVALIDITY` bump, because a production count found zero
affected rows (10634 rows, 0 non-ASCII `message_id`, 0 non-ASCII `in_reply_to`,
detector controls verified live so the zeros are trustworthy).

- **imap: the mailbox no longer reports itself empty mid-refresh** (#492, PR #503).
  `_refresh` ended by re-sorting the live snapshot. That sort reordered nothing (the
  list is uid-ascending by construction), but CPython DETACHES the backing array for
  the whole duration of a keyed sort, so a synchronous accessor on the reactor thread
  (`getMessageCount` after an APPEND, `getUID` after a STORE) could read it mid-sort
  and see an EMPTY list. The door then pushed `* 0 EXISTS` for a folder that has mail,
  and a client wipes its view of the folder on that. Reproduced at roughly a 10%
  window across 500 rows, now covered by two regression gates.
- **imap: one mailbox operation at a time, ordered** (#492, PR #505). Twisted does not
  serialize commands per connection (`blocked` is set only inside `__cbFetch`), so two
  commands against the same mailbox could be in the threadpool at once, each having
  resolved sequence numbers against a snapshot the other was mutating. RFC 3501 /
  RFC 9051 section 5.5 puts that obligation on the server, and mutt (pipeline depth 15)
  and mbsync (unlimited) pipeline by default. Every worker-touching operation now takes
  a turn in a per-mailbox FIFO queue whose waiters are Deferreds on the reactor thread,
  so a waiter costs no pool thread and the pool stays free for other mailboxes (a mutex
  would have reintroduced the #416 starvation one level down). COPY/MOVE resolves its
  source rows and moves them in ONE crossing, since two queue entries are two turns by
  definition. The `_refresh_lock` is retired.
  - **Behavior change:** a COPY/MOVE whose SOURCE read fails with a `MailboxException`
    (an unreachable worker on a cold snapshot) now answers a tagged `NO` where it
    answered `BAD`. `BAD` means the server could not parse the command; a worker the
    door cannot reach is not a protocol error, and the identical failure one call later
    already answered `NO` (RFC 3501 section 7.1).
- **inbound + imap: a message identifier is emitted, not RFC 2047 encoded** (#500,
  PR #506). `Message-ID` and `In-Reply-To` are structured fields, and RFC 2047 section 5
  is an explicit MUST NOT for encoded-words there. Measured against Mutt 2.2.12: the
  encoded-word was echoed back VERBATIM in `In-Reply-To`, so the reply forked its thread.
  Both projectors are changed in lockstep, with the same byte constants asserted on both
  sides so one cannot move without the other. `_to_wire` is hardened to accept whatever
  the stdlib parser returns: under compat32 a non-ASCII header line comes back as an
  `email.header.Header`, not a `str`, which raised in both `spew_envelope` and
  `spew_body` and hung the FETCH.
- **inbound: an identifier the door cannot serve is collapsed, and matched in both
  forms** (#500, PR #508). Extends the existing rule -- verbatim unless the id cannot be
  represented (#486, #494) -- to the third way that happens: a non-ASCII id, which
  RFC 6532 makes LEGAL but which our door cannot carry until it implements RFC 6855
  `UTF8=ACCEPT` (#504). Thread resolution applies the IDENTICAL transform to
  `in_reply_to` / `references` before matching, trying the raw form FIRST, so a sender
  quoting its own raw id still finds the collapsed parent and no lookup that succeeded
  before can start failing. Verified live: the reply now inherits the thread where it
  previously forked, with a never-stored control still forking.

## v1.3.3

Patch release: a stated decoded-size bound on the IMAP import seam, Message-ID
round-trip integrity for ids carrying line breaks, and a CI smoke that cleans up
after itself. No schema change, no route change, no migration.

- **inbound: IMAP import decoded size is capped at 22 MiB** (#493, PR #498).
  `rawMime` on `POST /api/imap/import` is checked BEFORE the MIME is parsed; past
  the cap the answer is `413 E_PAYLOAD_TOO_LARGE` (the door maps it to a tagged
  IMAP `NO`, never a 5xx). The number is derived from the 30 MiB JSON body cap and
  base64's 4/3 inflation, so it refuses nothing a real client can send today;
  raising the APPEND ceiling means moving both caps together (documented in
  CONTRACT.md).
- **inbound: a Message-ID carrying CR/LF is stored as its sha256** (#494, PR #499),
  the same collapse the byte budget already applies, because a raw line break
  cannot survive the RFC822 projection and forked the thread on reply. One rule:
  verbatim unless the id cannot be represented. Placement preserves the pre-#486
  legacy-row merge.
- **smoke: runs clean up after themselves** (#496, PRs #497 + this release). New
  `inbound/scripts/smoke-debris-sweep.mjs` (dry-run by default) removes probe
  messages a smoke run left behind; leg-10 cleanup now also deletes the reply-leg
  copy it created; and the deploy + staging workflows pass
  `POSTERN_DELETE_TOKEN` (new `POSTERN_SMOKE_DELETE_TOKEN` secret, a dedicated
  delete-scoped member), so CI smoke runs stop accumulating debris in the target
  mailbox.

## v1.3.2

Patch release: message identity kept verbatim, the IMAP door's last blocking read off
the reactor thread, and a quiet-by-default gate. No schema change, no route change, no
migration; the imap door changes ride the door image this tag builds.

- **inbound: Message-IDs are stored VERBATIM** (#486, PRs #489 + #491). The 64-char
  sha256 collapse at ingest is gone; its stated Vectorize rationale was stale (vector
  ids are hash-derived at any length, the raw id rides only in metadata). The id is now
  the header the sender sent, `<>`-stripped and trimmed, up to 255 UTF-8 bytes -- the
  budget guards the R2 attachment key and is counted the way R2 counts it. This
  preserves the structured GitHub id (`owner/repo/{issues,pull}/N@github.com`) that the
  old collapse destroyed at an invisible length cliff, and it FIXES THREADING for long
  ids: `in_reply_to` is stored raw and never matched a hashed parent, so replies forked.
  One normalizer is shared by both ingest paths (inbound seam and IMAP APPEND import).
  Rows stored under the pre-fix hash still merge on redelivery via a legacy lookup keyed
  exactly as the old code keyed it (untrimmed); no backfill, deliberately -- the raw
  header was never persisted, so there is nothing to backfill from.
- **imap: the live poll no longer blocks the reactor** (#485, PR #490). The last #416
  part 2 call site: the store refresh (NOOP and the timed tick) now runs in the reactor
  threadpool, while the untagged EXISTS push stays on the reactor thread because it
  writes to the protocol transport. `do_NOOP` chains refresh, then notify, then the
  tagged OK, so a client still learns about new mail within the NOOP that asked; ticks
  return their Deferred so a slow refresh delays the next tick instead of stacking; a
  refresh-vs-refresh lock stops two overlapping reads from double-appending the same
  arrivals. Both halves are asserted by thread identity over a real socket, with
  mutation controls.
- **imap: the door is gated QUIET by default** (#467, PR #488). A real-socket e2e test
  drives a normal session with both diagnostic levers at their production default and
  asserts stdout/stderr stay byte-empty and no twisted log event fires from door code --
  the gate that would have caught the v1.2.0 stray-diagnostics regression (#456). Proved
  red against that exact seam before it was trusted.
- **imap: the driven surface is asserted, not assumed** (#468, PR #487). Every IMAP
  command the door implements is driven through the recording transport with a per-drive
  control that the worker routes were actually reached, killing vacuous passes.
- **ci: deploy smoke leg 9 split into its two refusals** (#483, PR #484). The
  read-scoped token now asserts the scope gate (403) and a separate send-scoped token
  asserts the identity gate (`E_IDENTITY_REQUIRED`), with a loud SKIP when the optional
  `POSTERN_SMOKE_SEND_TOKEN` secret is not configured.

## v1.3.1

Patch release: the sprint-5 fix pair plus an honest deploy gate. No schema change, no
contract change; the folders response is byte-identical. This is also the tag whose
deploy produces the LIVE re-measure of `GET /api/folders` (#477 stays open until that
number confirms the predicted band).

- **inbound: `GET /api/folders` is ONE D1 statement** (#477, PR #481). The route used to
  issue fifteen statements for a bare viewer (plus two per role queue), awaited in
  series; against D1 every statement is a network round trip, which is what the measured
  ~2.2s p50 actually was (the aggregation itself costs ~39ms at 50k rows). Counts are now
  conditional aggregates over one pass, the per-recipient read override is a join on the
  `message_seen_by` primary key, role queues are extra columns, and the drafts count plus
  the durable-folder UIDVALIDITY values ride the same statement as scalar subqueries. The
  lazy UID-counter mint now runs only for a folder with no counter row (once per estate),
  so the steady-state read path writes nothing. The answer is proven unchanged against
  the pre-#477 per-folder SQL as an in-suite oracle, and the one-statement cost is
  asserted through the real handler, not described.
- **inbound: the ingest path survives an omitted `TRUSTED_SENDER_DOMAINS`** (#473,
  PR #480). `isTrusted()` now guards the read the way every sibling comma-list var
  already does, so a clean-install operator who prunes the var gets an empty allowlist
  (nothing trusted, message still stored) instead of a TypeError on EVERY inbound
  message that surfaced as a transient infrastructure fault (CF redelivery retries
  in-Worker; SMTP 451 retry-forever through the relay). `Env` still declares the var
  required, matching the family convention (required declaration, guarded read), and the
  convention is now documented on both sides so neither drifts.
- **ci: the deploy smoke probe polls the sent-copy read-back** (#478). Attachments
  persist via `ctx.waitUntil` AFTER the send answers -- deliberate, so sends stay fast --
  which made an immediate read-back structurally racy: v1.2.0, v1.2.1, and v1.3.0 all
  show a red probe step against deploys that were verified healthy (v1.2.x red was also
  the real #470 defect, fixed in v1.3.0; the v1.3.0 red was purely this race, #479 has
  the full cross-reference). The probe now polls on a bounded 10s deadline with the
  assertions unchanged. This tag is the first whose gate can be believed.

## v1.3.0

The single-source-roles release. One BREAKING change with a short operator migration
(below), plus the first intake wave the v1.2.1 live smoke and the #416 follow-ups
surfaced: the sent copy now stores its attachments, the two remaining pre-gate routes
answer a fixed envelope, and the door gets a measured timeout, a worker circuit
breaker, and a pool-saturation signal.

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
- **inbound (#470):** the stored SENT copy now carries its attachments. `dispatchAndStore`
  always handed the parts to the transport (the recipient got them) but the sent-copy
  `store.put` carried none, so your own sent attachments were unreadable from your own
  mailbox (webmail Sent, IMAP Sent, `GET /api/messages/{id}/attachments/{i}`) -- true
  since outbound attachments shipped in #70, found by the v1.2.1 deploy's first full
  live-smoke run. The sent copy now stores metadata rows + R2 bytes through the SAME
  path inbound uses, decoded after dispatch so a maximum-size send never holds two
  decoded copies at once. The smoke's own first assertion on that leg read a
  list-summary-only field off the single-message shape (structurally red forever);
  corrected to read `attachments[]` (#471).
- **inbound (#442):** `/api/smtp-auth` and `/ingest` -- the two remaining PRE-GATE
  routes -- now answer an unexpected throw with the same fixed
  `500 E_INTERNAL_SERVER_ERROR` envelope the session path got in #441: no message echo,
  detail to the worker log. The 5xx is load-bearing on the mail seams: both relay
  callers branch on status alone, so `/ingest` stays SMTP 451 (the MTA retries) and an
  smtp-auth outage stays an INFRA error -- never a `200 {ok:false}` that would read as
  "wrong password" and strike the #105 throttle until every account locked out.
  Verified against the real relay binary (#472).
- **imap door (#458):** `POSTERN_API_TIMEOUT` drops 15s -> 5s on MEASUREMENT (680 live
  calls; every door call class sits at 0.3-0.6s p99 except `GET /api/folders` at a
  stable ~2.2s, which sets the floor), and zero/negative is now a loud startup refusal
  (a 0 made every socket non-blocking: a door that looked configured and served
  nothing). New worker CIRCUIT BREAKER (`POSTERN_API_BREAKER_*`, default 5 consecutive
  TRANSPORT failures -> 30s cooldown): only timeouts/refused/reset count, any HTTP
  answer resets it, and an OPEN circuit answers the same tagged `NO [UNAVAILABLE]` an
  unreachable Worker already gets -- never an empty mailbox, pinned over the wire. Pool
  exhaustion is now a rate-limited log line (`POSTERN_IMAP_POOL_LOG_SECONDS`) with the
  suppressed-dispatch count carried forward, instead of a fact inferred from latency
  (#474).

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