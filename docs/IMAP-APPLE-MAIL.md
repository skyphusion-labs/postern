# IMAP + Apple Mail -- door contract

The Apple Mail IMAP door contract: dual-token delete, attachment serving, Trash
behavior.

## Draft autosave

Apple Mail issues `APPEND Drafts` repeatedly while a message is being composed.
Drafts now has a real server-side store (`drafts` table, migrations 0011/0013;
`POST /api/drafts`): the IMAP door persists every APPEND as a create-or-revise
instead of a no-op.

- A first APPEND creates a new draft.
- A later APPEND matching an existing draft (same recipient + normalized subject,
  within a recency window) revises it in place under a NEW, higher per-folder UID
  (RFC 3501 UID immutability: an existing UID is never rewritten).
- Drafts persist across reconnect and roam between devices (identity-scoped, not
  IMAP-session-local).
- Trash, Junk, and Archive also persist a genuine new APPEND now (soft-placed via
  the same import seam). Only Notes still rejects APPEND: it has no backing store
  by design (#109, #218 Experiment A).

## What shipped (merged on `main`)

| PR | Commit area | What |
|---|---|---|
| [#290](https://github.com/skyphusion-labs/postern/pull/290) | `inbound/` | `DELETE /api/messages/{id}` + Vectorize tombstone |
| [#291](https://github.com/skyphusion-labs/postern/pull/291) | `imap/` | EXPUNGE wired to delete API |
| [#292](https://github.com/skyphusion-labs/postern/pull/292) | `imap/`, crew-secrets, fleet | Dual-token IMAP: read + `POSTERN_API_TOKEN_DELETE` |
| [#293](https://github.com/skyphusion-labs/postern/pull/293) | `imap/` | COPY-to-Trash delete; first attachment CTE attempt |
| [#294](https://github.com/skyphusion-labs/postern/pull/294) | `imap/` | Attachment base64 **wire** bytes in FETCH; session Trash staging |
| [#295](https://github.com/skyphusion-labs/postern/pull/295) | `imap/` | Content-Type `name=` on attachments (PDF UTI); Trash staging **shared per username** across IMAP connections |

## Deployment

The door runs wherever the operator hosts it. See [`imap/README.md`](../imap/README.md)
for env vars and deployment.

## Apple Mail delete path

Apple Mail does **not** use `STORE \Deleted` + `EXPUNGE` in INBOX. It **COPY/MOVE**
to the `\Trash` mailbox.

Trash, Junk, and Archive are **durable folders** (`mailbox_placement` +
`mailbox_uid_counter`, migration 0011): COPY/MOVE to any of them is a **soft
move**, not a delete. The IMAP door:

1. Intercepts COPY/MOVE to Trash/Junk/Archive (`server.do_COPY` / `do_MOVE`,
   classified via `Account.copyability`).
2. Soft-places the message via `POST /api/messages/move` (sets the durable
   `mailbox` column; the message stays in the store).
3. Removes the message from the source folder live snapshot (it no longer matches
   that folder filter).
4. The message is recoverable: COPY/MOVE back to INBOX/Sent/All (a "restore") moves
   it out of the placement folder again, direction-checked so an inbound message
   cannot restore to Sent and vice versa.

A message is only **permanently gone** when it is EXPUNGEd (flagged `\Deleted`
then EXPUNGE, in INBOX or in Trash/Junk/Archive themselves): that hard-deletes via
`DELETE /api/messages/{id}` using **`POSTERN_API_TOKEN_DELETE`** (#278).

**COPY vs MOVE (RFC 6851, PR #304):** `MOVE` is advertised in CAPABILITY and
implemented fully. Both verbs soft-move identically, but differ in what the client is
told about the source view:

- **MOVE** additionally emits an untagged `EXPUNGE` for every moved message (message
  SEQUENCE numbers, high-to-low, per RFC 3501 7.4.1 and the #300/#301 fix) BEFORE the
  tagged `OK`, so the source view updates in the same round-trip. No COPYUID is
  emitted (a soft-moved message keeps its own per-folder UID, minted fresh in the
  destination; we do not advertise UIDPLUS, so a COPYUID would fabricate a shared
  identity across folders).
- **COPY** emits no untagged `EXPUNGE`; the client re-syncs the source on its next poll
  (the historical COPY-to-Trash client-view gap). Apple Mail prefers MOVE, so it now
  gets the immediate update.

**Trash folder semantics:**

- **Archive**, **Trash**, and **Junk** are durable per-folder placements, not empty
  placeholders; a soft-moved message stays there until EXPUNGEd or moved again. Only
  **Notes** is an empty placeholder (no backing store, #109).
- EXPUNGE on Trash/Junk/Archive (or on INBOX for `\Deleted`-flagged messages) is the
  only permanent delete; it hard-deletes as in step 4 above.

**Tokens:**

| Secret / env | Scope | Used for |
|---|---|---|
| `POSTERN_API_TOKEN` / read member | read | LIST, FETCH, seen, attachments, COPY/MOVE soft-place |
| `POSTERN_API_TOKEN_DELETE` / delete member | both | EXPUNGE (hard delete) only (#278) |
| `POSTERN_API_TOKEN_IMAP` | imap | Drafts APPEND persist; Trash/Junk/Archive new-message APPEND import (#352) |

## Apple Mail attachments (#210)

Postern stores attachment bytes in R2; IMAP **projects** MIME at FETCH time.

**Invariant:** declared `Content-Transfer-Encoding` must match the bytes served in
BODY[] FETCH.

| Part | Wire CTE | IMAP serves |
|---|---|---|
| text/html body | `8bit` | decoded text (identity) |
| attachment | `base64` | **base64 wire bytes** (not decoded) |

**Do not** use `cte=binary` on attachments: `EmailMessage` strips `\r` from binary
payloads and corrupts PDFs.

**PDF "Open With" fix (#295):** set Content-Type `name=` so BODYSTRUCTURE carries
`NAME` (Apple Mail uses this for UTI detection, not only the filename extension).

## Smoke (after roll)

From a host that reaches your IMAPS door:

1. **Attachment:** open a PDF on a message with attachments; should open in Preview
   without an app picker (re-sync Mail first: Mailbox -> Synchronize).
2. **Delete:** delete a test message; INBOX count drops; **Trash** shows it until
   empty trash / reconnect; message must not reappear in INBOX.
3. **API bytes:** attachment GET should start with `%PDF` for invoice PDFs.

## Dev / CI

```bash
cd imap && pip install -e '.[dev,tls]' && python -m mypy && python -m twisted.trial posternimap.tests
```

Key tests: `test_copy_to_trash_deletes_from_inbox`, `test_attachment_imap_body_serves_base64_wire`,
`test_attachment_content_type_has_name_param`, `test_trash_staging_shared_across_account_instances`.

## Related docs

- [`imap/README.md`](../imap/README.md) -- proxy behavior, env vars
- [`docs/AUTH-CONTRACT.md`](AUTH-CONTRACT.md) -- token scopes
- [`docs/CONTRACT.md`](CONTRACT.md) -- attachment API, store model
