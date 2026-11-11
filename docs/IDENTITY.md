# Identity: one principal layer for humans and agents (#854)

Status: **ruled; phase M1 shipped.** Conrad accepted all ten recommendations in section 9
as written (2026-11-10, recorded on #854). M1 (section 6) is built: the tables, the
service-principal seeds, and the idempotent backfill. M2 and M3 are not built. Where this
file and a shipped contract (AUTH-CONTRACT.md, CONTRACT.md,
`docs/design/webmail-v2-contracts.md` 1.10, DELEGATION.md) disagree, the shipped contract
wins.

Conrad, 2026-11-10: *"we need to figure out how we can have a nice integrated idp for
both agents and humans that can link both api keys and usernames and passwords for both
the webmail and possibly the imap proxy side of things in the future"*.

## 1. Where identity lives today (main, measured)

| Who | Store | Credential | Verified by | Doors |
|---|---|---|---|---|
| Human | `smtp_credentials` (username PK, `from_addr`, PBKDF2-SHA512 hash, `disabled`) | username + password | the worker only: `/api/session`, `/api/smtp-auth` | webmail session; SMTP AUTH and IMAP in `native` mode (both call `/api/smtp-auth`) |
| Human session | `webmail_sessions` (hash of the cookie, `identity` = address, `username` = the login, migration 0015) | cookie | the worker | webmail |
| Human, external directory | the LDAP directory or PAM; nothing in postern | directory password | the relay and the IMAP door, directly | SMTP AUTH, IMAP (`ldap` / `system` modes) |
| Agent, runtime | `agent_identities` (`idn_` id, sha256 of the token, `from_addr`, `scopes`) | API token | the worker | API, MCP |
| Agent, legacy | `POSTERN_SEND_IDENTITIES` var (sha256 of the token, `from`, `scopes`) | API token | the worker | API, MCP |
| Operator | six static slots (`POSTERN_API_TOKEN`, `_READ`, `_SEND`, `_DELETE`, `_IMAP`, `_ORGANIZE`), each a comma set | API token | the worker | admin API, installer, the doors' service tokens |
| IMAP door, relay | static slots plus `POSTERN_TRANSPORT_TOKEN` | API token | the worker | the service seams |

Links between them:

- `delegation_grants` (#740): `grantee_id` (an `idn_` id) may act on `address` with
  `read` / `organize` / `quote` / `send_as`.
- `audit_log` (#801): `actor_kind` + `actor_id`. Today the operator audits as
  `operator` with a NULL id (no static slot has an id). With #740 S2 (#860, in review)
  an agent's organize write on a granted address audits as `agent` + its `idn_` id.

What hurts, in order:

1. **Two people models.** A human is a row keyed by a USERNAME. An agent is a row keyed by
   an `idn_` ID. Nothing can name "this person" across both, so a grant cannot have a
   human grantee and the human cannot be an audit actor by id.
2. **One credential per person.** A human has exactly one password, shared by webmail,
   SMTP and IMAP. A phone that leaks it leaks webmail too, and rotating it breaks every
   client at once. An agent has exactly one token.
3. **The operator is anonymous.** Six static slots, no ids, so the audit log cannot say
   which key acted.
4. **The external directory is invisible.** An LDAP or PAM user has no postern row, so it
   cannot hold a grant or appear in the audit log by id.

## 2. Principles

- **Augment, never replace.** Every table and env var above keeps working through every
  phase. A deploy that never touches the new routes behaves exactly as today.
- **Additive migrations only** (CREATE TABLE / CREATE INDEX / INSERT), so the #112 deploy
  gate applies them with no marker.
- **Stable opaque ids everywhere.** Grants, audit rows and sessions name a principal id,
  never a username or an address. A username can be renamed; an id cannot.
- **Self-host needs nothing external.** Federation is optional and additive (section 7).
- **The worker stays the only verifier of postern-held secrets.** It already is (section 1);
  the doors keep calling `/api/smtp-auth`.
- **Zero new runtime dependencies.** Hashing stays PBKDF2-SHA512 (#851) for passwords and
  sha256 for high-entropy tokens.

## 3. The model

Four nouns. A **principal** is who. A **credential** is how they prove it. An
**address** is what mail they own. A **grant** extends one principal's reach to
another's address.

### 3.1 `principals`

```sql
CREATE TABLE IF NOT EXISTS principals (
  id           TEXT PRIMARY KEY,     -- opaque; see "ids" below
  kind         TEXT NOT NULL,        -- human | agent | service
  display_name TEXT,
  label        TEXT,                 -- operator note
  created_by   TEXT NOT NULL,        -- a principal id, or 'migration'
  created_at   TEXT NOT NULL,
  disabled_at  TEXT                  -- disabling a principal stops EVERY credential
);
```

- **`kind` decides the CEILING, never the grant.** `human`: at most read, send, delete,
  organize (today's `NATIVE_SESSION_CAPS`). `agent`: at most read, send, organize (today's
  `RUNTIME_CAPS`, never delete, never admin). `service`: the operator and the doors; the
  only kind that can hold `admin`, `imap` or the transport seam. A credential's caps are
  always a subset of its principal's ceiling, checked at mint AND at resolve.
- **ids.** New principals get `prn_` plus 24 hex. A migrated agent KEEPS its `idn_` id as
  its principal id, so every `delegation_grants.grantee_id` and every audit `actor_id`
  written by #740 S2 stays valid with no rewrite. The prefix is history, not type; code
  reads `kind`, never the prefix.
- **Never deleted.** Disable, as `agent_identities` and `delegation_grants` already do.

### 3.2 `credentials`

```sql
CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,    -- crd_ + 24 hex
  principal_id  TEXT NOT NULL,
  type          TEXT NOT NULL,       -- password | api_token | app_password | passkey | federated
  lookup        TEXT,                -- sha256(token) for api_token/app_password; login for password; issuer|subject for federated
  secret        TEXT,                -- the stored verifier (PBKDF2 string, passkey public key); NULL for api_token (the lookup IS the hash)
  caps          TEXT NOT NULL,       -- JSON array, a subset of the principal's ceiling
  protocols     TEXT,                -- JSON array: web | api | imap | smtp; NULL = every door the type allows
  label         TEXT,                -- "Ada's iPhone", "triage bot"
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,                -- coarse (per day), so a read does not become a write
  expires_at    TEXT,
  revoked_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_lookup ON credentials(type, lookup) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_credentials_principal ON credentials(principal_id, id);
```

Many credentials per principal, each typed, labelled and revocable on its own. That is
the fix for hurt 2: a phone gets an app password; revoking it touches nothing else.

### 3.3 `principal_addresses`

```sql
CREATE TABLE IF NOT EXISTS principal_addresses (
  address      TEXT PRIMARY KEY,     -- lowercased; on ALLOWED_FROM_DOMAIN
  principal_id TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0  -- the default From
);
```

- An address has ONE owner. Today each person has one `from`; this table lets a person
  own aliases later without a second account. v1 of this layer migrates exactly one
  primary address per principal and adds nothing else.
- **Role queues stay where they are** (`POSTERN_VIEWER_ROLES`, #425). A queue is a shared
  address, not owned by one principal. Moving queues into D1 is a separate decision.

### 3.4 Grants and audit, generalized

- `delegation_grants.grantee_id` becomes "a principal id". It already holds the
  `idn_` ids that become principal ids, so no row changes. A human grantee (an assistant
  acting on a manager's mail) becomes possible once humans have principal ids.
- `delegation_grants.created_by` becomes a principal id (today the string `operator`).
- `audit_log.actor_id` becomes a principal id for every actor, and `actor_kind` the
  principal's `kind`. Old rows keep their values; `operator` + NULL stays readable as
  "a static slot, before service principals existed".

## 4. Credential types per door

| Door | Accepts | Notes |
|---|---|---|
| Webmail | `password` (then a session), `passkey` (then a session, #792), `api_token` (BYO-token mode, unchanged) | A session row gains `principal_id`. `webmail_sessions.identity` and `username` stay for old rows. |
| API / MCP | `api_token` | Human or agent. A human's token is bound to that human and capped at the human ceiling (decision D-ID-3). |
| IMAP door | `app_password` (recommended), `password` (upgrade-safe), `api_token` (`token` mode, unchanged), directory login (`ldap` / `system`, unchanged) | The door keeps calling `/api/smtp-auth`; that route checks `password` and `app_password` credentials whose `protocols` allow `imap`. |
| SMTP submission | `app_password` (recommended), `password` (upgrade-safe), directory login | Same route, `protocols` must allow `smtp`. |
| Operator / doors | static slots (unchanged), later `api_token` credentials of `service` principals | Section 5.3. |

**App passwords** are generated (24 random bytes, shown once), stored as sha256 (they are
high-entropy, so a slow hash adds nothing), limited by `protocols`, and never accepted by
webmail. The main password keeps working on IMAP and SMTP so no client breaks on upgrade;
an operator or user can later turn that off per principal (decision D-ID-4).

## 5. Resolution

### 5.1 One resolver, today's order kept

A request resolves in this order, and the first hit wins. The first three are exactly
today's order, so an upgrade resolves every existing credential the same way.

1. A static slot (comma set, constant-time).
2. A `POSTERN_SEND_IDENTITIES` entry.
3. An `agent_identities` row (until phase M3; after that, the same row via `credentials`).
4. A `credentials` row of type `api_token`.

The result carries `principalId` and `kind`. `AuthResolution.identityId` (#801) becomes
`principalId`; for a migrated agent the value is the same string.

### 5.2 Caps

`effective caps = credential.caps ∩ ceiling(principal.kind)`, computed at resolve. A
disabled principal or a revoked, expired credential resolves to nothing (401). The write
scope follows the bound address whatever the caps (#857), and the read scope follows
`AGENT_READ_SCOPE` for agents (#740 S2), unchanged.

### 5.3 The operator gets an id (hurt 3)

Each static slot gets a `service` principal created by the migration, with a fixed id
per slot (`svc_both`, `svc_read`, `svc_send`, `svc_delete`, `svc_imap`, `svc_organize`).
The token values stay in env; only the id is new. Audit rows then say WHICH slot acted.
A comma set shares one id per slot; per-consumer ids come with `service` api tokens later.

### 5.4 Env registry entries

`POSTERN_SEND_IDENTITIES` entries have no id and get none in v1. They keep resolving as
today and cannot hold a grant (DELEGATION.md section 4, in #860, says so). The upgrade path
is to mint a runtime identity instead. Retiring the var is a later, separate ruling.

## 6. Migration

Every phase is additive and can stop. Nothing is dropped in this design.

| Phase | Ships | Old tables |
|---|---|---|
| **M1** | the three tables; a backfill: each `agent_identities` row becomes an `agent` principal with its OWN `idn_` id, an `api_token` credential (lookup = its existing `token_hash`) and its primary address; each `smtp_credentials` row becomes a `human` principal (`prn_`), a `password` credential (lookup = username, secret = the existing hash) and its primary address; one `service` principal per static slot. Resolution still reads the OLD tables. | source of truth |
| **M2** | resolution reads `credentials` first, old tables as the fallback; every admin route writes BOTH, in one batch; sessions record `principal_id`; audit rows name principal ids. | written in step |
| **M3** | new credential types (app passwords, human api tokens); admin routes for principals and credentials; the old tables stop being written. | frozen, still readable |

The backfill is idempotent (`INSERT ... WHERE NOT EXISTS`), so it runs on every deploy
and also picks up rows a pre-M2 admin route wrote after M1 landed.

**M1 as shipped.**

- **Migration `0019_principals.sql`** creates the three tables and seeds the six `service`
  principals (`svc_both`, `svc_read`, `svc_send`, `svc_delete`, `svc_imap`,
  `svc_organize`). It is additive, so the #112 gate applies it unmarked.
- **The backfill is a function, not migration SQL.** A copy from `smtp_credentials` and
  `agent_identities` is an `INSERT ... SELECT`, which the #112 gate refuses. It is
  `backfillPrincipals()` (`inbound/src/principals.ts`), run by
  `POST /api/admin/principals/backfill` (operator only, audited `principals.backfill`).
  Running it after each deploy is a deploy-pipeline step, not built yet.
- **Idempotent AND convergent.** A second run inserts and changes nothing. A run after the
  source changed mirrors exactly that change: a revoked identity disables its principal
  and revokes its credential; a disabled or re-enabled user, a password change, and a
  display-name change are mirrored; a deleted user's password credential is revoked and
  its principal disabled. No row is ever deleted.
- **Ids.** An agent principal keeps its `idn_` id; its credential is `crd_` plus the same
  24 hex. A human principal gets a fresh `prn_` id once, keyed on its live `password`
  credential's `lookup` (the username).
- **One owner per address.** An address another principal already owns is reported in
  `addressConflicts` and left with its owner.
- **The operator is no longer anonymous in the audit log** (D-ID-5): rows the admin routes
  write now name `actor_kind` `service`, `actor_id` `svc_both`, or `svc_admin` when the
  caller is the admin-only `POSTERN_API_TOKEN_ADMIN` slot (#904, seeded by migration 0021). Older rows keep `operator` +
  NULL. `delegation_grants.created_by` is still the string `operator` until M2.
- **Nothing reads the new tables to authorize anything.** Every credential resolves exactly
  as before; `inbound/principals.test.ts` asserts that across static, registry, runtime and
  session credentials, before and after a backfill.

**M2, the part #740 S5 needs (shipped; the rest of M2 waits until after S5).**

- **Every webmail session names its human principal.** Migration `0020` adds
  `webmail_sessions.principal_id`. A sign-in looks the principal up by its live `password`
  credential, and creates it on the spot (`ensureHumanPrincipal`, the same per-user code
  the backfill runs) when the backfill has not reached that login yet. So the backfill and
  the session cannot disagree. A session minted before `0020` resolves with `principalId`
  null and simply gets one at its next sign-in.
- **A grant and its audit row can name a human.** The grant and revoke paths take a
  grantor: the operator by default (unchanged: `created_by` `operator`, actor `service` /
  `svc_both`), or a human principal (`created_by` and the audit actor are its `prn_` id,
  actor kind `human`) pinned to its own address. A human grantor may not name an address,
  and revoking a grant on any other address is the same `404` as a missing id.
- **Deferred until after S5:** resolution reading `credentials` first, the full dual-write
  on every admin route, and the new credential types (M3).

**M2, dual-write and parity (shipped).**

- **Every write to the old tables carries its principal-table statements in the SAME D1
  batch** (`inbound/src/principalmirror.ts`): the eight write sites are user create, first
  user, update (disable, display name, From), set password (admin reset, self change and the
  upgrade-on-sign-in rehash), the legacy smtp-credentials upsert, user delete, agent mint and
  agent revoke. The statements are pure SQL over the old row as it stands after the write
  and encode the backfill's converge rules, so a write and its mirror land together or not
  at all. A delete revokes the credential and disables the principal; nothing is deleted.
- **`GET /api/admin/principals/parity`** (operator only, audited `principals.parity`)
  compares every `agent_identities` and `smtp_credentials` row with its principal and
  credential (token hash or secret, revoked or disabled, scopes, kind) and counts live
  password credentials with no account row. It returns counts and up to 20 sample OPAQUE ids
  (`idn_`, `prn_`, `crd_`), never a hash, secret, username or address; a differing human with
  no principal yet is counted (`withoutPrincipal`), not sampled.
- **Reads still use only the old tables.** The new tables authorize nothing yet.

**M2 reads, agree-or-fallback (shipped).** A runtime agent token and every password check
(webmail sign-in, `/api/smtp-auth`, change password) consult `credentials` beside the old
table, and ALWAYS act on the old table's answer: a credential is only compared (same hash or
secret, same principal and caps, same revoked or disabled state, including "the old table
denies it and no live credential exists"). A disagreement is counted in
`principal_read_misses` (migration `0022`: per UTC day and kind, counts only), with one upsert
made only on a miss, so an agreeing sign-in writes nothing. A stale credential therefore can
never allow what the old table denies. A failure on the new side (the credentials read, the
counter write, or the session mint's principal lookup) falls back to today's resolution and is
logged; it never denies. `GET /api/admin/principals/parity` reports the miss counts.

**How the fallback is retired.** It is the lead's call, made from the parity route (it needs
no spend and is not a ruling). M3 (credentials become the authority, the old tables stop being
written) happens only when all of these hold: the deploy backfill runs on every release (#901, #906); one full
release ran with dual-write; and parity returns zero diffs after that release's backfill, with
zero read-path misses across the release.

**Usernames.** `smtp_credentials.username` becomes the `lookup` of the principal's
`password` credential. Renaming a login changes that credential, never the principal id,
so sessions, grants and audit rows survive a rename.

**The external directory (hurt 4).** No row is created up front. When an `ldap` or
`system` login first needs an id (a grant, an audit row, a session if webmail ever
accepts directory logins), the worker creates a `human` principal with a `federated`
credential, lookup `ldap|<login>` or `system|<login>`. The door still verifies the
password against the directory; postern stores no directory secret.

## 7. Federation (optional, later)

An upstream sign-in (Cloudflare Access, Google, any OIDC issuer) links to a principal as a
`federated` credential, lookup `<issuer>|<subject>`. It mints the SAME webmail session a
password does. Linking needs an already-signed-in principal or the operator, never a
first sign-in, so an outside issuer can never create an account by itself. Self-host
needs none of this.

**S5 shows the agent roster to humans.** `GET /api/delegations/mine/grantees` lists every
LIVE agent identity (id, display name, From) to every signed-in human on that deploy, so a
human can pick whom to grant. It shows nothing else about an agent (no powers, no grants it
holds, no creation data). An operator who does not want humans to see the roster leaves
agents unminted or revokes them; there is no per-agent visibility flag in v1.

## 8. What each #740 slice keys on

| Slice | Keys on | Needs this layer first? |
|---|---|---|
| S1 (shipped) | `grantee_id` (`idn_`), `address` | no |
| S2 (#860) | the same, plus audit `actor_id` = `idn_`, `target_id` = message id | no; the ids become principal ids unchanged |
| S3 `quote` | the same | no |
| S4 `send_as` | the same; the send response names the From used (#847) | no |
| S5 (a human grants and reads their own log) | the HUMAN as `created_by` and as audit actor | **yes, M2 at least.** Without principal ids a human could be recorded only by username, which is the mutable key this design exists to retire |

So S3 and S4 can proceed now. S5 waits for M2.

## 9. Decisions for Conrad

| id | question | recommendation |
|---|---|---|
| D-ID-1 | the kinds: `human`, `agent`, `service`? | yes; `kind` sets the ceiling, nothing else |
| D-ID-2 | may an agent sign in to webmail with a password? | no; agents use tokens, so a webmail session always means a person |
| D-ID-3 | may a human hold API tokens (scripts, their own MCP)? | yes, bound to them and capped at the human ceiling; this is "link api keys and passwords" |
| D-ID-4 | app passwords for IMAP and SMTP? | yes, recommended for new clients; the main password keeps working on those doors until the principal turns it off |
| D-ID-5 | service principals for the static slots, so the operator audits by id? | yes (section 5.3) |
| D-ID-6 | external directory users get a principal lazily, on first need? | yes (section 6) |
| D-ID-7 | federation (OIDC) in scope now? | no; the `federated` type is reserved so it lands without a schema change |
| D-ID-8 | env registry entries: leave without ids, steer to runtime identities? | yes; retiring the var is a separate ruling |
| D-ID-9 | a signed-in human admin role (open since contract 1.10)? | not in this design; with principals it becomes a cap on a `human` credential, so it can be ruled on its own |
| D-ID-10 | one address per principal in v1, aliases later? | yes |

## 10. Threats this design adds, and the answer to each

- **Type confusion** (an app password presented to webmail, an api token presented as a
  password). Each door asks `/api/smtp-auth` or the session mint for ONE type set, and
  the lookup index is per type, so a value of the wrong type matches nothing.
- **Ceiling bypass** (a credential minted with caps above its kind). Checked at mint and
  again at resolve, so a hand-edited row cannot exceed the kind.
- **Migration window** (M2 writes two tables). One batch per admin write, so the two
  agree or neither changes; the resolver reads the new table first only after the
  backfill has run.
- **Enumeration.** The new routes keep the existing enumeration-safe answers and the
  #409 throttle, keyed per principal.
- **Audit integrity.** Unchanged: rows are written in the same batch as the action they
  record (#801, #740 S2).

## 11. Not in this design

Per-message exclusion (#853); moving role queues into D1; human admin roles (D-ID-9);
retiring `POSTERN_SEND_IDENTITIES`; any change to how the relay or the IMAP door talk to
an external directory.
