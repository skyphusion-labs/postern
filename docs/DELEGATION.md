# Delegation grants (#740)

> Interface Control Document for delegated agent action on a human's mail. This file is
> the contract for what is SHIPPED and the plan for what is not. Slice S1 is the grant
> STORE and its operator routes. Slice S2 enforces the `read` and `organize` powers and
> adds the `AGENT_READ_SCOPE` operator flag (section 4). Slice S3 enforces `quote`
> (section 4.4). `send_as` is stored but not enforced yet (S4).

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
| `send_as` | send with the address as From | S4 |

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
message id, and `detail` `{op, ..., granted: [addresses]}`. If the audit insert fails,
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

### 4.5 Known limits of S2 and S3

- **A refusal at the scope gate is not audited** (section 3 says the same for the
  operator routes). A `403` from the gate (a token without `organize`) never reaches a
  handler and writes no row.
- **Reads are not audited.** Organize writes and quotes are; a list, search or get of
  granted mail is not.
- **Per-message exclusion is not in v1** (Conrad's Q2 ruling). A grant covers all of the
  address's mail. Tracked in #853.
- **`seen` with several granted addresses is one address per request.** `for` names one
  recipient, so marking two humans' state is two requests.

## 5. What is not built yet (the plan)

- **S4, `send_as`:** the send From may be an address the agent holds `send_as` on, and
  the send response reports the From it actually used (#847).
- **S5:** a human reads their own audit log and makes and revokes grants on their own
  address from webmail. That is what makes the trail a product feature rather than an
  operator log.

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
| Tests | `inbound/delegations.test.ts`, `inbound/delegated-read.test.ts`, `inbound/delegated-organize.test.ts`, `inbound/delegated-quote.test.ts`, `deploy/test/installer.test.mjs` |
| Route rows | `inbound/src/routes.ts` (`admin-delegations-*`), `contracts/api-routes.json` |
