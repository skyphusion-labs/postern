# Deploying Postern (clean install)

From a fresh clone, with only your own domain, you can deploy Postern, send a
message, and receive + read it back from the store. This is the path the
`inbound/smoke.mjs` script asserts (issue #25 / CONTRACT section 7). Nothing
here is specific to any one account or domain.

## Prerequisites

- A Cloudflare account and a domain on it (using Cloudflare DNS).
- Node 22+ and `npx wrangler` (logged in: `npx wrangler login`).
- The sending domain onboarded to **Email Sending** (SPF/DKIM/bounce records):
  Dashboard -> Compute & AI -> Email Service -> Email Sending -> Onboard Domain,
  then `npx wrangler email sending list` should show `enabled=yes`.
  Outbound send uses Cloudflare Email Sending, which requires the **Workers Paid**
  plan (USD 5/month). Inbound receive via Email Routing works on the free plan.
- For the inbound leg: **Email Routing** enabled on the same domain (Dashboard
  -> Email -> Email Routing), with MX pointed at Cloudflare.

## 1. Create the storage resources

The store (D1 + R2, optionally Vectorize) is per-account; there is no shared
default. Create your own:

```bash
cd inbound
npx wrangler d1 create postern              # copy the database_id it prints
npx wrangler r2 bucket create postern-attachments
# optional (semantic search): npx wrangler vectorize create postern-vec --dimensions=768 --metric=cosine
```

Edit `inbound/wrangler.jsonc`:
- paste your `database_id` into the `d1_databases` block,
- set `DEFAULT_FROM`, `DEFAULT_FROM_NAME`, `ALLOWED_FROM_DOMAIN` to your domain,
- to reach the worker over `https://postern.<subdomain>.workers.dev` (the URL the
  webmail and smoke steps below use), set `"workers_dev": true`. The shipped
  default is `false` (secure-by-default: no public door; a production install
  instead adds a token-gated custom route on your own domain), so with the
  default left in place `npm run deploy` gives you no reachable URL to smoke.
- (optional) uncomment the `vectorize` + `ai` blocks if you created the index.

Apply the schema:

```bash
npx wrangler d1 execute postern --remote --file=schema.sql
```

### CI deploy and D1 migrations (read this before wiring GitHub Actions)

The push-to-`main` deploy workflow (`.github/workflows/deploy.yml`) runs
`wrangler d1 migrations apply DB --remote` before every inbound deploy. Wrangler
tracks which migration files have already run in a `d1_migrations` table and
applies only the pending ones.

**Fresh install via `schema.sql` (above):** the schema is already current, but
`d1_migrations` is still empty. The first CI deploy will try to re-apply
`0001_attachments_fts_dmarc.sql` and later files against an already-built store
and fail (for example `duplicate column name`). The migration gate (#112) may
catch this with a clearer message, but the fix is the same: **baseline-seed**
`d1_migrations` once so the pipeline sees every migration through the current
schema as already applied.

After `schema.sql` succeeds, list the migration files under
`inbound/migrations/` and insert each filename (exactly as on disk, including
`.sql`) into `d1_migrations`:

```bash
cd inbound
npx wrangler d1 execute postern --remote --command "
INSERT INTO d1_migrations (name) VALUES
  ('0001_attachments_fts_dmarc.sql'),
  ('0002_direction_thread.sql'),
  ('0003_body_html.sql'),
  ('0004_smtp_credentials.sql'),
  ('0005_messages_autoincrement_uid.sql'),
  ('0006_envelope_v2.sql'),
  ('0007_seen.sql');
"
```

Verify nothing is pending:

```bash
npx wrangler d1 migrations list postern --remote
```

**Greenfield alternative:** skip `schema.sql` and apply migrations directly
(`npx wrangler d1 migrations apply postern --remote`). Wrangler creates
`d1_migrations` and records each file as it runs; CI then no-ops until a new
migration lands.

**Existing store / offline migration (0005 pattern):** when a migration must be
applied manually (core-table rebuild, backup-first operation), run it offline
per the operator runbook, verify, then baseline-seed **only that migration name**
(or the full set through your current schema revision) before merging code that
expects it. Do not rely on CI to auto-apply destructive migrations; the gate
blocks them unless the file carries an explicit `-- postern:allow-destructive`
marker reviewed for online apply.

When new migrations ship in the repo, CI applies only the ones not yet in
`d1_migrations`; additive migrations pass the gate automatically.

## 2. Set the API token and deploy

```bash
npx wrangler secret put POSTERN_API_TOKEN   # generate one: openssl rand -hex 32
npm install
npm run deploy
```

With `workers_dev` enabled (above), `npm run deploy` prints the deployed URL, e.g.
`https://postern.<your-subdomain>.workers.dev`. Allow up to a minute after the
first deploy for the workers.dev route to go live before you smoke it.

Open `https://postern.<your-subdomain>.workers.dev/webmail` to browse the mailbox
in a browser (paste that origin + your `POSTERN_API_TOKEN`); IMAP clients can use
the `imap/` proxy. Both are read-only (see `webmail/README.md` and `imap/README.md`).

**Agent and script clients** (no clone required):

```bash
# MCP (Cursor / Claude Code): npx -y @skyphusion/postern-mcp with POSTERN_API_URL + POSTERN_API_TOKEN
npm install -g @skyphusion/postern-mcp   # optional global install

# Python CLI + library
pip install postern-client
export POSTERN_API_URL=https://postern.<your-subdomain>.workers.dev
export POSTERN_API_TOKEN=<your-token>
postern ping
```

See [docs/INTEGRATION.md](docs/INTEGRATION.md), [mcp/README.md](mcp/README.md), and
[clients/python/README.md](clients/python/README.md).

## 3. Wire inbound mail (for the receive leg)

In the Dashboard -> Email -> Email Routing -> Routing Rules, route all addresses
(including catch-all) to the deployed Worker. The worker stores every inbound
message, then forwards the original to `FORWARD_TO` if you set one.

## 4. Run the smoke

The smoke takes your own values; it has no built-in domain or account.

```bash
# Outbound + store + reply-threading (no real inbound needed):
POSTERN_BASE_URL=https://postern.<your-subdomain>.workers.dev \
POSTERN_API_TOKEN=<your-token> \
POSTERN_FROM=noreply@<your-domain> \
POSTERN_TO=you@<your-domain> \
node inbound/smoke.mjs

# Full v1.0 acceptance, including a real inbound delivery (step 3 wired):
POSTERN_BASE_URL=https://postern.<your-subdomain>.workers.dev \
POSTERN_API_TOKEN=<your-token> \
POSTERN_FROM=noreply@<your-domain> \
POSTERN_TO=you@<your-domain> \
node inbound/smoke.mjs --expect-inbound --inbound-subject "postern hello"
# then send a real email to an address on your domain with that subject.
```

A green run is the v1.0 launch artifact: deploy -> send -> store -> reply
threads -> inbound arrives and is searchable, all asserted on the structured
store/API, not on prose.
