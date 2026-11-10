# Delegation grants (#740)

> Interface Control Document for delegated agent action on a human's mail. This file is
> the contract for what is SHIPPED and the plan for what is not. Slice S1 (this release)
> is the grant STORE and its operator routes: **nothing enforces a grant yet**, so no
> agent can do anything with a grant that it could not do without one.

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
| `powers` | a non-empty subset of the powers below. |
| `label` | an optional operator note. |
| `createdBy` | `operator` (S1 grants are operator-made; S5 adds the human). |
| `createdAt` / `revokedAt` | revocation sets `revokedAt`; a row is never deleted. |

**Powers**, and the slice that will enforce each:

| power | will allow | slice |
|---|---|---|
| `organize` | mark read, flags and move on the address's mail | S2 |
| `quote` | quote the address's mail into a reply or forward | S3 |
| `send_as` | send with the address as From | S4 |

Anything else in `powers` (`read`, `send`, `delete`, `admin`, a typo) is refused with
`400 E_VALIDATION_ERROR`, never stripped.

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

**Audit.** Every grant, list and revoke writes one `audit_log` row (actions
`delegation.grant`, `delegation.list`, `delegation.revoke`), refusals included. A grant or
revoke and its row land in one D1 batch. Read the log at `GET /api/admin/audit`.

## 4. What is not built yet (the plan)

- **S2, `organize`:** the mark-read, flags and move paths widen from the agent's own
  address to its own address plus every address it holds an active `organize` grant on.
  Each such write is audited in the same batch as the write, and fails if the audit
  write fails.
- **S3, `quote`:** the reply and forward quote source widens on a `quote` grant.
- **S4, `send_as`:** the send From may be an address the agent holds `send_as` on, and
  the send response reports the From it actually used (#847).
- **S5:** a human reads their own audit log and makes and revokes grants on their own
  address from webmail. That is what makes the trail a product feature rather than an
  operator log.

Two questions are open with Conrad and S2 does not start until they are answered: whether
the #718 estate-wide agent READ stays the default once grants exist, and whether
per-message exclusion (privileged material) is in scope for the first release.

## 5. Provenance

| Item | Location |
|---|---|
| Store + routes | `inbound/src/delegations.ts`, `inbound/migrations/0017_delegation_grants.sql` |
| Shared admin plumbing + audit writer | `inbound/src/adminkit.ts` |
| Tests | `inbound/delegations.test.ts` |
| Route rows | `inbound/src/routes.ts` (`admin-delegations-*`), `contracts/api-routes.json` |
