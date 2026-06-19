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
- (optional) uncomment the `vectorize` + `ai` blocks if you created the index.

Apply the schema:

```bash
npx wrangler d1 execute postern --remote --file=schema.sql
```

## 2. Set the API token and deploy

```bash
npx wrangler secret put POSTERN_API_TOKEN   # generate one: openssl rand -hex 32
npm install
npm run deploy
```

`npm run deploy` prints the deployed URL, e.g.
`https://postern.<your-account>.workers.dev`.

## 3. Wire inbound mail (for the receive leg)

In the Dashboard -> Email -> Email Routing -> Routing Rules, route all addresses
(including catch-all) to the deployed Worker. The worker stores every inbound
message, then forwards the original to `FORWARD_TO` if you set one.

## 4. Run the smoke

The smoke takes your own values; it has no built-in domain or account.

```bash
# Outbound + store + reply-threading (no real inbound needed):
POSTERN_BASE_URL=https://postern.<your-account>.workers.dev \
POSTERN_API_TOKEN=<your-token> \
POSTERN_FROM=noreply@<your-domain> \
POSTERN_TO=you@<your-domain> \
node inbound/smoke.mjs

# Full v1.0 acceptance, including a real inbound delivery (step 3 wired):
POSTERN_BASE_URL=https://postern.<your-account>.workers.dev \
POSTERN_API_TOKEN=<your-token> \
POSTERN_FROM=noreply@<your-domain> \
POSTERN_TO=you@<your-domain> \
node inbound/smoke.mjs --expect-inbound --inbound-subject "postern hello"
# then send a real email to an address on your domain with that subject.
```

A green run is the v1.0 launch artifact: deploy -> send -> store -> reply
threads -> inbound arrives and is searchable, all asserted on the structured
store/API, not on prose.
