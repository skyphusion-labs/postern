# IMAP + Apple Mail -- operator handoff (2026-07-09)

Checkpoint for the Apple Mail IMAP work stream: dual-token delete, attachment
serving, Trash behavior. Written for crew handoff (laptop -> rancid.internal or
any new session).

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

## Production (as of 2026-07-09)

- **Host:** biafra (`10.1.1.6`), Swarm service `postern-imap_postern-imap`
- **Image:** `ghcr.io/skyphusion-labs/postern-imap:<main-sha>` (CI `imap-image` + fleet roll)
- **API origin:** `https://postern.skyphusion.org`
- **Listener:** IMAPS `10.1.1.6:993` (PROXY protocol optional)
- **Secrets (Swarm):** `postern_imap_api_token`, `postern_imap_delete_token`, TLS cert/key
- **Roll:** `fleet-chezmoi/system/swarm/bin/roll-postern-door.sh imap` (or CI dispatch)

Token minting: `crew-secrets/operator/postern/` (`provision-imap-delete-token.sh`, README).

## Apple Mail delete path

Apple Mail does **not** use `STORE \Deleted` + `EXPUNGE` in INBOX. It **COPY/MOVE**
to the `\Trash` mailbox.

Postern has **no Trash store**. The IMAP door:

1. Intercepts COPY/MOVE to Trash (`server.do_COPY` / `do_MOVE`).
2. Stages the message summary in **process-wide Trash staging** (keyed by IMAP username; PR #295).
3. Hard-deletes via `DELETE /api/messages/{id}` using **`POSTERN_API_TOKEN_DELETE`** (both scope).
4. Removes the message from the source folder snapshot.

**Trash folder semantics:**

- **Archive** is an empty placeholder; deletes never go there.
- **Trash** shows staged summaries until EXPUNGE on Trash or imap process restart.
- Messages are **already gone from the Postern store** after step 3; Trash is a
  client-compat view, not recovery.

**Tokens:**

| Secret / env | Scope | Used for |
|---|---|---|
| `POSTERN_API_TOKEN` / read member | read | LIST, FETCH, seen, attachments |
| `POSTERN_API_TOKEN_DELETE` / delete member | both | EXPUNGE, COPY-to-Trash delete |

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

From a host that reaches biafra IMAPS (or SSH + docker exec):

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
- Fleet deploy: `fleet-chezmoi/system/postern/runbooks/imap-door-deploy.md` (generic);
  live Swarm stack under `fleet-chezmoi/system/swarm/stacks/postern-imap.stack.yml`

## Session context (Cursor laptop, 2026-07-09)

- User verified on Apple Mail (Skyphusion account, biafra IMAPS).
- Sample messages: Cloudflare invoice, xAI forwarded test (`~/xai-test-email.eml`).
- Issue #278 tracks dual-token delete + Apple Mail parity.

## rancid.internal handoff (2026-07-09)

**Cursor crew box:** rancid (`10.1.1.8`, `rancid.internal`). Clone postern at
`/home/conrad/dev/postern` after Remote SSH connect.

**Before Apple Mail smoke on prod:**

1. Merge PR #295 (CI fix: clear shared Trash staging in e2e `setUp`).
2. Wait for `imap-image` CI + fleet roll on **biafra** (not rancid; IMAP runs on swarm manager).
3. Re-sync Mail account; retest PDF open + Trash visibility.

**From rancid:** reach biafra IMAPS on `10.1.1.6:993` over VLAN; API at
`https://postern.skyphusion.org`. Fleet record:
`fleet-chezmoi/system/postern-imap/README.md`.

**Do not** deploy IMAP on rancid; it is podman-first, no swarm. Ops stay on biafra.
