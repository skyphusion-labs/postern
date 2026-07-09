# postern inbound

The core Cloudflare Worker: ingest via **Email Routing**, store in D1 (searchable
mailbox), R2 (attachment bytes), and Vectorize (chunked embeddings for RAG), serve
the mailbox API (`/api/*`), and send outbound mail in the same isolate so sent copies
land in the store without a cross-worker hop.

```
inbound mail ─► Email Routing ─► this Worker ─┬─► message.forward()  (FORWARD_FOR subset only)
                                              ├─► D1 messages + attachments (+ FTS5)
                                              ├─► R2 attachment bytes
                                              ├─► Vectorize chunk embeddings (VECTORIZE_FOR opt-in)
                                              └─► outbound send (CF Email or relay transport)
```

## Processing order (load-bearing)

`src/index.ts`'s `email()` handler runs in a fixed order, and the order matters:

1. **Forward first, before parsing.** CF Email Workers require `message.raw` to be
   unconsumed when `forward()` is called. `PostalMime().parse()` consumes the
   stream, so parsing before forwarding silently breaks delivery. Forward only
   happens for recipients on `FORWARD_FOR` (crew keep their own mail).
2. **Parse the MIME** (`message.raw` is a tee CF keeps available after forward).
3. **Derive auth verdicts** (SPF / DKIM / DMARC) and an allowlist `trusted` flag.
4. **Clean the body** (strip signature + quoted-reply lines), cap at 32 KB.
5. **D1 insert** with `INSERT OR IGNORE` keyed on `message_id` (dedup). If the
   row already existed (`changes === 0`), the handler returns early; attachments
   and embeddings are not re-done for a duplicate.
6. **Attachments to R2 + D1**, best-effort under `ctx.waitUntil`.
7. **Vectorize embeddings**, best-effort under `ctx.waitUntil`, opt-in per
   recipient via `VECTORIZE_FOR`.

Steps 6 and 7 run in `waitUntil` so a slow R2 / AI call never blocks (or fails)
delivery; their errors are logged, not thrown.

## Bindings (`wrangler.jsonc`)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 (`postern` in `wrangler.jsonc`) | `messages`, `attachments`, `messages_fts` (FTS5) |
| `VECTORIZE` | Vectorize (`postern-vec`, 768-dim, cosine) | semantic recall over bodies |
| `ATTACHMENTS` | R2 (`postern-attachments`) | attachment bytes; keys referenced in `DB.attachments` |
| `AI` | Workers AI (optional AI Gateway) | `@cf/baai/bge-base-en-v1.5` embeddings |

Fleet live deploy uses operator-chosen resource names (for example `skyphusion-mail`,
`skyphusion-mail-vec-v2`); the template in `wrangler.jsonc` stays generic.

## Vars (`wrangler.jsonc` `vars`)

All are plain (non-secret) comma-separated lists; this Worker holds **no secrets**.

| Var | Effect | Empty (`""`) means |
|-----|--------|--------------------|
| `TRUSTED_SENDER_DOMAINS` | domains/addresses eligible for `trusted=1` (must also pass SPF or DKIM, or have both stripped by CF) | nothing is ever trusted |
| `FORWARD_TO` | destination for transparent forwarding | forwarding disabled (store-only) |
| `FORWARD_FOR` | recipients whose mail is forwarded to `FORWARD_TO` | forward everything (not recommended once crew share the domain) |
| `VECTORIZE_FOR` | recipients whose mail is embedded into Vectorize (opt-in) | index everything |

Note the asymmetry: an empty `FORWARD_FOR` / `VECTORIZE_FOR` means "all", but an
empty `TRUSTED_SENDER_DOMAINS` means "none". That is deliberate (fail-closed on
trust, permissive on the routing lists you control), but keep both lists
populated in production so the behavior is explicit.

## Trust model

`trusted` (stored per message) is a coarse "is this from us / a known service"
flag, not a spam verdict. `isTrusted()` requires the sender to be on
`TRUSTED_SENDER_DOMAINS` AND one of:

- SPF `pass`/`neutral`, OR
- DKIM `pass`, OR
- both SPF and DKIM reporting `none` (CF Email Routing strips transport auth
  headers, so absence of a verdict is expected; CF's own MX already filters
  inbound, so allowlist alone suffices in that case).

An allowlisted sender whose auth actively **fails** (a spoof attempt) is **not**
trusted. The domain match is anchored (`== domain` or `endsWith("@" + domain)`),
so `notskyphusion.org` does not match `skyphusion.org`.

## Vectorize cost bound

Embedding is the only metered call per message. Cost is bounded two ways:

- the body is capped at **32 KB** before chunking;
- `chunkText(body, 1200, 150)` is `.slice(0, 24)`, so at most **24 chunks**
  (24 embedding inputs in one `AI.run` batch) per message regardless of size.

Chunk ids are `<sha256(messageId)[:56]>.<i>` to stay within Vectorize's 64-char
id limit. Only recipients on `VECTORIZE_FOR` are indexed at all.

## Attachment handling

Each attachment is stored at R2 key `att/<messageId>/<i>-<safeName>` where
`safeName` strips everything outside `[A-Za-z0-9._-]` and truncates to 100 chars
(so a hostile filename cannot escape the key prefix or inject a path). Zero-byte
parts are skipped. Metadata (filename, mime, size, key) goes into `DB.attachments`.
Storage is best-effort per attachment; one failure is logged and the rest proceed.

## Setup

```bash
cd inbound
npm install

# One-time resource creation (paste IDs into wrangler.jsonc):
npx wrangler d1 create postern
npx wrangler d1 execute postern --remote --file=schema.sql
npx wrangler vectorize create postern-vec --dimensions=768 --metric=cosine
npx wrangler r2 bucket create postern-attachments

npm run typecheck     # CI gate
npx vitest run        # unit suite (pure helpers)
npm run deploy        # wrangler deploy  (auto-deploys on green main via Jenkins)
```

For an existing DB that predates the attachments/FTS/dmarc columns, apply
`migrations/0001_attachments_fts_dmarc.sql` instead of the full `schema.sql`.

### Email Routing wiring (CF Dashboard)

Email > Email Routing > Routing Rules: route **all** addresses (including
catch-all) to Worker `skyphusion-email-inbound`. Remove any direct "Forward to
email" rules; forwarding is handled inside the Worker (after ingestion) so every
message is stored exactly once.

## Tests

`smoke.test.ts` (vitest, node env) unit-tests the pure helpers: auth-verdict
parsing, the `isTrusted` allowlist decision (including spoof and lookalike-domain
cases), body cleaning, `htmlToText`, `chunkText` (the cost bound), `sha256hex`,
and `toArrayBuffer`. The `email()` handler itself needs a live
`ForwardableEmailMessage` plus the D1/R2/Vectorize/AI bindings, so it is verified
end-to-end against `wrangler dev` or a real inbound message, not in the unit
suite. Run `npm run typecheck` before pushing (it is not part of the test run).

## Reading stored mail

Query D1 directly (the `messages` table + `messages_fts` for full-text search):

```bash
npx wrangler d1 execute postern --remote \
  --command "SELECT received_at, from_addr, subject, trusted FROM messages ORDER BY received_at DESC LIMIT 20"
```
