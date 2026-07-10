# IMAP + Apple Mail -- door contract

The Apple Mail IMAP door contract: dual-token delete, attachment serving, Trash
behavior.

## What shipped (merged on `main`)

| PR | Commit area | What |
|---|---|---|
| [#290](https://github.com/skyphusion-labs/postern/pull/290) | `inbound/` | `DELETE /api/messages/{id}` + Vectorize tombstone |
| [#291](https://github.com/skyphusion-labs/postern/pull/291) | `imap/` | EXPUNGE wired to delete API |
| [#292](https://github.com/skyphusion-labs/postern/pull/292) | `imap/`, crew-secrets, fleet | Dual-token IMAP: read + `POSTERN_API_TOKEN_DELETE` |
| [#293](https://github.com/skyphusion-labs/postern/pull/293) | `imap/` | COPY-to-Trash delete; first attachment CTE attempt |
| [#294](https://github.com/skyphusion-labs/postern/pull/294) | `imap/` | Attachment base64 **wire** bytes in FETCH; session Trash staging |

**Open (merge when CI green):**

| PR | What |
|---|---|
| [#295](https://github.com/skyphusion-labs/postern/pull/295) | Content-Type `name=` on attachments (PDF UTI); Trash staging **shared per username** across IMAP connections |

## Deployment

The door runs wherever the operator hosts it. See [`imap/README.md`](../imap/README.md)
for env vars and deployment.

## Apple Mail delete path

Apple Mail does **not** use `STORE \Deleted` + `EXPUNGE` in INBOX. It **COPY/MOVE**
to the `\Trash` mailbox.

Postern has **no Trash store**. The IMAP door:

1. Intercepts COPY/MOVE to Trash (`server.do_COPY` / `do_MOVE`).
2. Stages the message summary in **process-wide Trash staging** (keyed by IMAP username; PR #295).
3. Hard-deletes via `DELETE /api/messages/{id}` using **`POSTERN_API_TOKEN_DELETE`** (both scope).
4. Removes the message from the source folder snapshot.

**COPY vs MOVE (RFC 6851, PR #304):** `MOVE` is advertised in CAPABILITY and
implemented fully. Both verbs hard-delete from the source as above, but they differ in
what the client is told about the source view:

- **MOVE** additionally emits an untagged `EXPUNGE` for every moved message (message
  SEQUENCE numbers, high-to-low, per RFC 3501 7.4.1 and the #300/#301 fix) BEFORE the
  tagged `OK`, so the client's source view updates in the same round-trip. No stale
  view; no COPYUID is emitted (Trash has no backing store / persistent destination UIDs
  and we do not advertise UIDPLUS, so a COPYUID would fabricate UIDs).
- **COPY** emits no untagged `EXPUNGE`; the client re-syncs the source on its next poll
  (the historical COPY-to-Trash client-view gap). Apple Mail prefers MOVE, so it now
  gets the immediate update.

**Trash folder semantics:**

- **Archive** is an empty placeholder; deletes never go there.
- **Trash** shows staged summaries until EXPUNGE on Trash or imap process restart.
- Messages are **already gone from the Postern store** after step 3; Trash is a
  client-compat view, not recovery.

**Tokens:**

| Secret / env | Scope | Used for |
|---|---|---|
| `POSTERN_API_TOKEN` / read member | read | LIST, FETCH, seen, attachments |
| `POSTERN_API_TOKEN_DELETE` / delete member | both | EXPUNGE, COPY/MOVE-to-Trash delete |

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
