# Delegation grants (#740)

> Interface Control Document for delegated agent action on a human's mail. This file is
> the contract for what is SHIPPED and the plan for what is not. Slice S1 is the grant
> STORE and its operator routes. Slice S2 enforces the `read` and `organize` powers and
> adds the `AGENT_READ_SCOPE` operator flag (section 4). Slice S3 enforces `quote`
> (section 4.4). Slice S4 enforces `send_as` (section 4.5), on a transport that can set
> the `Sender:` header only.

## 1. Why

An agent credential reads the whole deployment (#718), but every WRITE it makes is bound
to its own address: it can find a human's invoice and cannot mark it read, file it, or
reply quoting it. #740 is the destination Conrad named for that asymmetry: delegated
read AND send, with an audit trail. The audit trail is a precondition for the write side,
not a companion to it. A wrong read is a disclosure you can reason about afterwards; a
wrong write changes a human's mailbox, and without a record naming which agent did it the
human cannot reconstruct what happened to their own mail.

A grant is the explicit, revocable, audited statement that one agent identity may act on
one human address, and how.

## 2. The grant

| field | meaning |
|---|---|
| `id` | `dlg_` plus 24 hex characters. Stable; never reused. |
| `granteeId` | an agent identity id (`idn_...`, [SEND-IDENTITIES.md section 10](SEND-IDENTITIES.md)). Must be LIVE (unrevoked) when the grant is made. |
| `address` | the human address the grantee may act on. On `ALLOWED_FROM_DOMAIN`, and never the grantee's own address. |
| `powers` | a non-empty subset of the powers below. Every power implies `read`, so the stored set always carries it. |
| `label` | an optional operator note. |
| `createdBy` | `operator` (S1 grants are operator-made; S5 adds the human). |
| `createdAt` / `revokedAt` | revocation sets `revokedAt`; a row is never deleted. |

**Powers**, and the slice that will enforce each:

| power | will allow | slice |
|---|---|---|
| `read` | read the address's mail when the operator has set `AGENT_READ_SCOPE=granted` (Conrad's Q1 ruling) | S2, shipped |
| `organize` | mark read, flags and move on the address's mail, each write audited | S2, shipped |
| `quote` | reply to, quote and forward the address's mail, each quote audited before it is sent | S3, shipped |
| `send_as` | send with the address as From (the agent named as Sender), each send audited before dispatch; needs a Sender-capable transport | S4, shipped |

**Every power implies `read`.** Filing, quoting or sending as mail you cannot read means
nothing, so a grant of `["organize"]` is stored, returned and audited as
`["read", "organize"]`, in this canonical order. The record says exactly what the grant
allows; no reader has to re-derive a rule.

Anything else in `powers` (`send`, `delete`, `admin`, a typo, a different case) is
refused with `400 E_VALIDATION_ERROR`, never stripped.

**One ACTIVE grant per (grantee, address).** A second is `409 E_CONFLICT`. To change the
powers, revoke the grant and make a new one, so every change is its own audited event.
A partial unique index enforces this in the database as well as in the handler.

**The grantee reference is checked at mint.** D1 does not enforce foreign keys, so the
INSERT itself is conditional on the grantee row existing unrevoked. An unknown or revoked
grantee is `400 E_GRANTEE_INVALID`. If the grantee is revoked between the check and the
write, the answer is `409 E_GRANTEE_INVALID`, no grant is stored, and no "ok" audit row is
written.

## 3. Operator routes (a `both` token)

```bash
# Grant
curl -sS -X POST "$POSTERN_API_URL/api/admin/delegations" \
  -H "Authorization: Bearer $POSTERN_API_TOKEN" -H 'content-type: application/json' \
  -d '{"granteeId":"idn_...","address":"alice@example.com","powers":["organize"],"label":"inbox triage"}'

# List (active only; includeRevoked=1, grantee=idn_..., address=..., keyset limit/cursor)
curl -sS "$POSTERN_API_URL/api/admin/delegations?address=alice@example.com" -H "Authorization: Bearer $POSTERN_API_TOKEN"

# Revoke (idempotent)
curl -sS -X DELETE "$POSTERN_API_URL/api/admin/delegations/dlg_..." -H "Authorization: Bearer $POSTERN_API_TOKEN"
```

All three routes are `admin`-scoped. No agent identity, no static scoped token, and no
webmail session can reach them.

**Known limit: a refusal at the scope gate is not audited.** A request that the gate
refuses (`401` with no credential, `403` with the wrong scope) never reaches a handler,
so it writes no `audit_log` row. That is true of every route, not only these. Refusals
the HANDLER makes (bad powers, an unknown grantee, a duplicate) are audited. Whether
the gate itself should record refusals is a gate-level decision, deliberately left for
later.

**Audit.** Every grant, list and revoke writes one `audit_log` row (actions
`delegation.grant`, `delegation.list`, `delegation.revoke`), refusals included. A grant or
revoke and its row land in one D1 batch. Read the log at `GET /api/admin/audit`.

## 4. S2: what a grant enforces (shipped)

A grant is read on every request that needs it and never cached across requests, so a
revoke takes effect on the next request. **A grant counts only while its grantee identity
is live:** the lookup joins `agent_identities` on `revoked_at IS NULL`, so revoking the
identity cuts every grant it holds at once. The grant rows are not rewritten; they stay
listed, and simply stop counting. Only a RUNTIME agent identity (an `idn_...`
id) can hold one. A webmail session, a static token and a `POSTERN_SEND_IDENTITIES`
entry have no identity id for a grant to name, so they hold none and nothing below
changes for them.

### 4.1 The operator flag `AGENT_READ_SCOPE`

| value | an agent credential (a Bearer with the `read` cap) reads |
|---|---|
| unset | the whole deployment, as since #718. An upgraded deploy keeps this until the operator changes it. |
| `estate` | the same. |
| `granted` | its own address, the role queues it is on, and every address it holds an active grant on. |
| anything else | `granted` (fail closed), and the Worker logs a config error once per value. Values are exact: `Granted` and the empty string are unknown values. |

The installer writes `granted` on a NEW install, next to `WEBMAIL_AUTH_BACKEND`. It never
adds the flag on `upgrade`, and `--adopt` carries the live value (or its absence) over.

### 4.2 The `read` power (and every other power, which implies it)

Under `granted`:

- `GET /api/messages/{id}`, its `/attachments/{i}` sub-route and `GET /api/threads/{id}`
  read own plus granted addresses.
- `GET /api/messages`, `GET /api/search` and `GET /api/folders` read the caller's own
  address by default. A `to=` naming a granted address reads THAT address's mailbox as
  its owner sees it: every lens, and the owner's read state. `identityScope` reports
  `{kind: "member", addresses: [<granted address>]}`. This is named the way a role queue
  is (#425), and a role queue wins if an address is both.
- `GET /api/whoami` adds `delegations`: the active grants, each `{id, address, powers}`.
  It is `[]` when there are none, never absent, under either flag value.

Under `estate` the agent already reads every address, so a grant adds no read.

### 4.3 The `organize` power

Under EITHER flag value, an active `organize` grant widens the three organize routes:

- `POST /api/messages/flags` and `POST /api/messages/move` reach the caller's own mail
  plus the mail of every address it holds `organize` on.
- `POST /api/messages/seen` with `for: <granted address>` writes THAT address's read
  state on that address's mail. Without `for`, the mark is the caller's own read state,
  exactly as before. `for` naming any other address is still `403`.

**Every such write is audited in the same D1 batch as the write.** One `audit_log` row
per touched message on a granted address: action `delegation.organize`, `actor_kind`
`agent`, `actor_id` the grantee's identity id, `target_kind` `message`, `target_id` the
message id, and `detail` `{op, ..., address}`, where `address` is the granted human whose
mail it is (a message two granted humans both receive gets a row for each; #740 S5 made
this per address, so each human's own trail shows only their mail). If the audit insert fails,
the batch rolls back and the write does not happen. A write that touches only the
caller's own mail writes no audit row. Every field names a stable id, so a later
identity layer (#854) can adopt these rows without rewriting them.

### 4.4 The `quote` power (S3)

Under EITHER flag value (Conrad's S3 ruling, Q2), an active `quote` grant widens the
mail a reply or forward may READ from the caller's own address (and its role queues) to
that plus every address it holds `quote` on. #718 left this scope at the caller's own
address even when it reads the estate, so the grant is the only thing that widens it.
It covers every route that quotes, taken from the route table: `POST /api/send` and
`/send` (`forwardMessageId`), `POST /api/reply` (the reply target, and its body with
`quoteOriginal`), and a draft send of a `reply`, `replyAll` or `forward` draft.

**Every quote of granted mail is audited BEFORE it is sent** (Conrad's S3 ruling, Q1):
one `audit_log` row, action `delegation.quote`, `actor_kind` `agent`, `actor_id` the
grantee's identity id, `target_kind` `message`, `target_id` the quoted message id, and
`detail` `{op: "reply" | "forward", address}`. If that insert fails, nothing is sent.
A reply counts whether or not it quotes the body: it reads the target's parties, subject
and thread. A quote of the caller's own mail writes no row.

**The row records an ATTEMPT, not a delivery.** The provider send is not a database write,
so it cannot share a batch with the row. The row is written first; if the dispatch then
fails, the row stays.

### 4.5 The `send_as` power (S4)

An agent holding an active `send_as` grant sends as the human by naming the address as
`from` on `POST /api/send`, `/send` or `POST /api/reply` (Conrad's S4 ruling, RFC 5322
as designed):

| header | value |
|---|---|
| `From:` | the granted address, with the HUMAN's display name (from their account). The caller does not choose this name. |
| `Sender:` | the agent identity's own address and display name: who actually sent it. A client that shows "on behalf of" is honest about it. |
| `Reply-To:` | the human. A caller `replyTo` is accepted only if it is the granted address (`400` otherwise). |

The send response reports both: `from` is the human and `sender` is the agent (#847's
`from` field, plus `sender`, present only on a send_as send). A draft send takes no
caller `from`, so it always goes out as the identity itself. Without the grant, a `from`
naming another address is overridden by the identity's own, as before.

**Each send_as send is audited BEFORE dispatch**, fail closed: one `audit_log` row,
action `delegation.send_as`, `actor_kind` `agent`, `actor_id` the grantee's identity id,
`target_kind` `address`, `target_id` the granted address, `detail` `{op: "send" | "reply"}`.
If that insert fails, nothing is sent. As with `quote`, the row records an attempt.

**send_as needs a transport that can set the `Sender:` header.** The default Cloudflare
Email Sending transport cannot: it has no `sender` field, and `Sender` is not on its
header allowlist, which rejects the whole send rather than drop the header (measured
against the Email Service headers reference, 2026-11-09). So on that transport a send_as
send is refused, before the audit row and before any dispatch, with
`422 E_SEND_AS_UNSUPPORTED` and a message that says why. It is never sent without a
Sender and never silently sent as the agent instead (Conrad's ruling, fail closed). The
SMTP relay transport (`OUTBOUND_TRANSPORT=relay`) writes `Sender:` and supports it.
Cloudflare support for `Sender` on the allowlist is a feature request (#896).

### 4.6 S5: the human manages their own address (shipped)

A signed-in human, from a webmail SESSION, manages delegation on their own address and
reads their own trail. Every route refuses a Bearer of any kind (`403 E_SESSION_REQUIRED`):
this is the human's door, not the operator's. The general gate demands CSRF on the
state-changing verbs. The address is always the session's own; no route takes one.

| route | does |
|---|---|
| `GET /api/delegations/mine/grantees` | the LIVE agent identities, exactly `{id, displayName, from}`. Every signed-in human on the deploy sees this roster (the lead's S5 ruling, Q1). |
| `GET /api/delegations/mine` | the active grants on my address whose grantee is live, newest first: `{id, granteeId, granteeName, granteeFrom, powers, label, createdBy, createdAt}`. `createdBy` is `operator` or my principal id. |
| `POST /api/delegations/mine` `{granteeId, powers, label?}` | grant on my address. All four powers are allowed (Q2). The same validation as the operator route; an `address` field is a `400`. Audited `delegation.grant` with actor `human` / my `prn_` id, and `created_by` my `prn_` id. |
| `DELETE /api/delegations/mine/{id}` | revoke a grant on my address, idempotent. Any other id, including a grant on someone else's address, is the same `404` as a missing one. Audited `delegation.revoke`, actor human. |
| `GET /api/audit/mine` | the audit rows about my address, newest first, keyset `limit`/`cursor`, the `/api/admin/audit` row shape: grants and revokes on it, quotes and organize writes of my mail (`detail.address`), and send_as sends as me (`target_id`). Nothing about any other address. |

A session minted before migration `0020` names no principal; these routes answer `401
E_REAUTH_REQUIRED` and one more sign-in fixes it. A human-made grant is enforced exactly as
an operator's (sections 4.2 to 4.5).

### 4.7 Known limits of S2 to S5

- **A refusal at the scope gate is not audited** (section 3 says the same for the
  operator routes). A `403` from the gate (a token without `organize`) never reaches a
  handler and writes no row.
- **Reads are not audited.** Organize writes and quotes are; a list, search or get of
  granted mail is not.
- **Exclusion is per thread, not per message** (#853, section 4.8). A grant covers all
  of the address's mail except the threads its owner marked human-only.
- **`seen` with several granted addresses is one address per request.** `for` names one
  recipient, so marking two humans' state is two requests.

### 4.8 #853: human-only threads (shipped)

The owner of an address marks one THREAD human-only (the lead's D1 ruling: thread, not
message). From then on no agent reaches the owner's mail in that thread, whatever its
grants, and under BOTH `AGENT_READ_SCOPE` values (D2): an estate agent loses it too.

| route (webmail session only, CSRF on writes) | does |
|---|---|
| `GET /api/delegations/mine/exclusions` | my active marks, newest first: `{id, threadId, subject, createdAt}`. `subject` is my earliest message in the thread, or null (D3). No paging. |
| `POST /api/delegations/mine/exclusions` `{threadId}` | mark the thread. `201 {created: true, item}`; a repeat is `200 {created: false, item}` with the same item, never a `409`. A thread with none of my mail in it is the same `404 E_NOT_FOUND` as an unknown one. An `address` field is a `400`. |
| `DELETE /api/delegations/mine/exclusions/{id}` | remove my mark: `200 {ok: true}`. Unknown, already removed, or someone else's: the same `404`. |

`threadId` is the id every message row reports. A Bearer is `403 E_SESSION_REQUIRED`, and a
session minted before migration `0020` is `401 E_REAUTH_REQUIRED`, as in section 4.6.

**What a mark hides.** A message is hidden from an agent when an active mark names its
thread AND the mark's owner is on its delivered set or sent it (the owner's mail, by the
same predicate the read routes use). One predicate in `inbound/src/store.ts`
(`exclusionClause`) is the whole rule. It applies to every agent path:

- reads: list, `countOnly`, search in every mode (fts, substr, semantic, hybrid), folder
  counts, get, attachments, thread;
- writes: seen, flags and move skip a hidden id like an unknown one (`updated` does not count it);
- quotes and replies: reply, `send_as` reply, forward and a draft's reply or forward are
  the same `404` as a missing target;
- threading: a send whose `In-Reply-To` or `References` names a hidden message starts a
  new thread.

A hidden message answers with exactly the bytes an absent one does. A refused agent read
writes no audit row.

**What a mark never hides.** The agent's OWN mail: a message delivered to the agent, or
sent as it, stays visible even inside a marked thread. A mark never changes what a human
session or a static token reads. A message delivered to the owner AND someone else is the
owner's mail too, so the owner's mark hides that row from every agent, including an agent
the other person delegated to.

**Who counts as an agent.** A Bearer bound to an identity: a runtime agent identity or a
registry entry. A webmail session is the human; a static token is the operator.

**Audit.** `delegation.exclude` and `delegation.unexclude`: actor `human` / the owner's
`prn_`, target `{kind: "thread", id: threadId}` on both, detail `{address, exclusionId}`.
Both show in `GET /api/audit/mine`. A repeat mark writes no row.

**Cost.** Measured before the build (50k messages, 500 marks, local SQLite): a paged
list, search or get costs the same within noise; an unbounded estate `countOnly` for an
agent rises from about 0 to about 19 ms. Human and operator queries carry no extra
predicate, so their plans are unchanged. A denormalized flag was rejected: it would be a
second source of truth for an access rule.

## 5. What is not built yet (the plan)

- **The S5 webmail UI** (the Settings screen over section 4.6) is the frontend lane's,
  on the same contract.

**Conrad's rulings (2026-11-10), recorded on #740:**

- **Q1, opt-in fallback.** Once grants exist, an agent reads its own address plus its
  granted addresses. The #718 estate-wide agent read becomes an explicit operator flag,
  `AGENT_READ_SCOPE` (`estate` or `granted`). It is off on a new install (the installer
  writes `granted`). An UNSET flag means `estate`, so an upgraded deploy keeps today's
  behaviour until the operator flips it. An unknown value fails closed to `granted`
  with a config error. S2 builds this.
- **Q2, per-message exclusion is not in v1.** It is #853, in the backlog.

## 6. Provenance

| Item | Location |
|---|---|
| Store + routes | `inbound/src/delegations.ts`, `inbound/migrations/0017_delegation_grants.sql` |
| Shared admin plumbing + audit writer | `inbound/src/adminkit.ts` |
| S2 enforcement | `inbound/src/api.ts` (`agentEstateRead`, `readAccessScope`, `delegatedView`, `organizeWriteScope`), `inbound/src/store.ts` (`OrganizeAudit`) |
| Tests | `inbound/delegations.test.ts`, `inbound/delegated-read.test.ts`, `inbound/delegated-organize.test.ts`, `inbound/delegated-quote.test.ts`, `inbound/delegated-send-as.test.ts`, `relay/sender_dispatch_test.go`, `deploy/test/installer.test.mjs` |
| Route rows | `inbound/src/routes.ts` (`admin-delegations-*`), `contracts/api-routes.json` |
