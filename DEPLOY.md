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
  ('0000_base_schema.sql'),
  ('0001_attachments_fts_dmarc.sql'),
  ('0002_direction_thread.sql'),
  ('0003_body_html.sql'),
  ('0004_smtp_credentials.sql'),
  ('0005_messages_autoincrement_uid.sql'),
  ('0006_envelope_v2.sql'),
  ('0007_seen.sql'),
  ('0008_vector_ledger.sql');
"
```

Verify nothing is pending:

```bash
npx wrangler d1 migrations list postern --remote
```

**Greenfield alternative:** skip `schema.sql` and apply migrations directly
(`npx wrangler d1 migrations apply postern --remote`). Migration
`0000_base_schema.sql` creates the base `messages` table, so the full chain
(`0000` through `0008`) bootstraps an empty store on its own; wrangler creates
`d1_migrations` and records each file as it runs, and CI then no-ops until a new
migration lands. Use this OR the `schema.sql` + baseline-seed path above, never
both. (`0000` is `CREATE TABLE IF NOT EXISTS`, so it is also a harmless no-op on
a store already built by `schema.sql`.)

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
in a browser (paste that origin + your `POSTERN_API_TOKEN`). That workers.dev URL
is the smoke posture; a production install serves the API on a hostname you
control (see "Production door" below) and stands up the human doors (webmail
compose, the IMAP proxy) per section 5.

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

### Production door: the API on your own domain

The smoke steps above use the `workers.dev` URL. The shipped template keeps
`"workers_dev": false` (secure by default: no public door until you add one), so
a production install serves the mailbox API on a hostname you control, with the
constant-time Bearer-token gate on `/api/*` as the perimeter.

`inbound/wrangler.jsonc` carries a commented `routes` block. Uncomment ONE form,
set your own hostname and zone, and redeploy (`npm run deploy`):

- **Custom Domain** (simplest, no manual DNS): Cloudflare provisions the proxied
  DNS record and the edge certificate for you.
  ```jsonc
  "routes": [ { "pattern": "mail.example.com", "custom_domain": true } ],
  ```
- **Zone route**: use this when you already manage a proxied (orange-cloud) DNS
  record at that hostname in the named zone.
  ```jsonc
  "routes": [ { "pattern": "mail.example.com/*", "zone_name": "example.com" } ],
  ```

The zone must be on the same Cloudflare account that hosts your Email Routing.
After the deploy the API answers at `https://mail.example.com`, and every client
(the Python CLI, MCP, webmail, the IMAP proxy) points at that origin instead of
the workers.dev URL. Leaving `workers_dev` at `false` means the workers.dev URL
stops answering, which is the intended production posture.

## 3. Wire inbound mail (for the receive leg)

In the Dashboard -> Email -> Email Routing -> Routing Rules, route all addresses
(including catch-all) to the deployed Worker. The worker stores every inbound
message, then forwards the original to `FORWARD_TO` if you set one.

**Scripted alternative (#314), for agent-driven or CI installs.** The Dashboard
click-through above is the only step in this guide that a scoped API token
cannot do end to end; `inbound/scripts/setup-email-routing.mjs` closes that gap
by pointing the zone's catch-all rule at the deployed Worker over the API:

```bash
cd inbound
CF_API_TOKEN=<token> CF_ACCOUNT_ID=<account-id> CF_ZONE_ID=<zone-id> \
  node scripts/setup-email-routing.mjs --dry-run   # print the plan first
# drop --dry-run to apply
```

The token needs **Email Routing Rules: Edit** (zone) to write the rule, plus
**Workers Scripts: Read** (account) so the script can resolve the deployed
Worker's `owner_worker_tag`. This still only sets the catch-all rule; remove
any conflicting per-address "Forward to email" rules in the Dashboard so every
address reaches the Worker.

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

## 5. Human doors (optional): webmail and IMAP

Postern is one mailbox reachable two ways: agents speak the structured API
directly, and humans reach the same mailbox through two door *clients* (never a
second store). Both are optional; set up neither, one, or both.

### Webmail

Served by the worker itself at `/webmail`, so there is no separate process to
run. Once the production route is live, open `https://mail.example.com/webmail`
and paste the API origin and your `POSTERN_API_TOKEN` into the page (held in that
one browser tab via `sessionStorage`, nowhere else). Read, thread, and search
work with a read token; supply a send-scoped token as well to compose and reply.
Details: [webmail/README.md](webmail/README.md).

### IMAP proxy

A small separate service that fronts the read API as IMAP, so Thunderbird, mutt,
iOS Mail, or an IMAP-speaking agent can open the mailbox: read, the `\Seen`
read/unread flag, and delete. Sending still goes through the API, never IMAP. The
proxy is a client of the API, keeps no store of its own, and runs wherever you
like (it need not be on Cloudflare).

Fastest self-host, from the clone:

```bash
cd imap
python -m venv .venv && . .venv/bin/activate
pip install -e .
export POSTERN_API_URL=https://mail.example.com
python -m posternimap                 # token mode: no secret held in the proxy
```

It binds `127.0.0.1:1143` by default. Point a mail client at that host and port,
using your mailbox address as the username and your `POSTERN_API_TOKEN` as the
password (`token` mode). To serve IMAPS on `993` instead, set
`POSTERN_IMAP_TLS_CERT` / `POSTERN_IMAP_TLS_KEY` (the listener enforces TLS 1.2+)
or front the loopback listener with stunnel; never expose the plain `1143`
listener off the host. A prebuilt image is published at
`ghcr.io/skyphusion-labs/postern-imap` (serves `993`). Auth modes, folder
mapping, and client notes: [imap/README.md](imap/README.md) and
[docs/IMAP-APPLE-MAIL.md](docs/IMAP-APPLE-MAIL.md).

### Relay (bring-your-own-SMTP), optional

`relay/` is a small Go SMTP daemon for local producers that can only speak SMTP
(cron, backups, CI failure mail): it accepts MIME on a loopback or private
listener and POSTs to the worker API. It is entirely optional and off the default
path; skip it unless you have an SMTP-only producer. Never bind it to a public
interface (it sends as your domain). Bring-up: [relay/README.md](relay/README.md).

## 6. Operating it: backup, restore, monitoring

A deployed mailbox needs a durability and health story: how to back up the D1
store and R2 attachment bytes, restore into a fresh store, and monitor that mail
keeps flowing. That is its own guide: [docs/OPERATIONS.md](docs/OPERATIONS.md).
