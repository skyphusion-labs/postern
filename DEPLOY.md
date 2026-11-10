# Deploying Postern

Postern runs in YOUR OWN Cloudflare account. Your mail, your store, and your keys never
leave it. One command sets it up, and the same command keeps it current.

## Before you start

- A Cloudflare account, and a domain on it that uses Cloudflare DNS.
- The **Workers Paid** plan (USD 5/month) if you want to SEND mail. Cloudflare Email
  Sending requires it. Receiving through Email Routing works on the free plan. The
  installer does not change your plan; that is your billing choice.
- Node 22 or later, and a clone of this repository.
- A Cloudflare API token for your account. The permissions it needs are listed in
  [deploy/README.md](deploy/README.md#the-token). The installer checks each one and
  names any that is missing before it changes anything.

## 1. Install

```bash
git clone https://github.com/skyphusion-labs/postern && cd postern
export CLOUDFLARE_API_TOKEN=<your token>     # read from the environment, never printed

node deploy/postern.mjs install --domain example.com --dry-run   # the plan; changes nothing
node deploy/postern.mjs install --domain example.com
```

The installer creates the D1 store and the R2 attachment bucket, and applies the schema.
It deploys the Worker at `https://mail.example.com`, with a mailbox token it generates.
It turns on Email Sending and Email Routing, adds the DNS records they need (MX, SPF,
DKIM, and DMARC if you have none), and routes every address on the domain to the Worker.
Then it creates your first admin login through the user API (`POST /api/admin/users`),
and turns on webmail sign-in (`WEBMAIL_AUTH_BACKEND=native`) for a new install. It does
not need, and does not set, the first-run setup secret (see section 4, "First run in the
browser"): it already holds the mailbox token, so it creates the admin directly.

**DMARC.** If your domain has no DMARC record, the installer writes `v=DMARC1; p=none`
(or your `--dmarc` choice) BEFORE it enables Email Sending. It has to come first:
enabling Sending on a domain without DMARC makes Cloudflare write `p=reject` itself.
Cloudflare recommends `p=reject`; use `--dmarc reject` if only Postern sends as your
domain. An existing DMARC record is never changed. Every line of output names one resource and says
`created`, `updated`, `unchanged` or `kept`.

Options: `--hostname` (default `mail.<domain>`), `--admin` (default `admin@<domain>`),
`--var KEY=VALUE` for any Worker var (remembered for later runs), and `--dmarc`.
All of them are in [deploy/README.md](deploy/README.md).

**It refuses, and changes nothing,** when the install would break something you already
have. That includes a domain that already receives mail elsewhere, an Email Routing rule
that sends mail somewhere else, an SPF record that needs a hand merge, a hostname already
in use, or a missing token permission. All refusals are listed together, so you fix them
in one pass. A run that stops partway (a network error, a certificate that is not ready
yet) says what it finished. Run the same command again to resume.

**Your credentials** are in `.postern/postern.<domain>.credentials.env` (mode 600,
gitignored). It holds the API URL, the mailbox token, and the admin login. The installer
prints the path, never the values. Keep a copy somewhere safe.

## 2. Check that mail flows

- **Webmail:** open `https://mail.example.com/webmail` and sign in with
  `POSTERN_ADMIN_USERNAME` / `POSTERN_ADMIN_PASSWORD` from the credentials file.
- **Send:** right after the install, Cloudflare refuses sends from a newly enabled
  domain with `E_SENDER_DOMAIN_NOT_AVAILABLE` for up to about a minute. The installer
  says so in its output. Wait about 60 seconds before the first send.
- **Receive:** send a message from any outside mailbox to any address on your domain.
  It shows up in webmail.
- **The scripted acceptance smoke** (outbound, store, threading, inbound):

```bash
set -a; . .postern/postern.example.com.credentials.env; set +a
cd inbound
POSTERN_BASE_URL=$POSTERN_API_URL POSTERN_FROM=noreply@example.com \
POSTERN_TO=you@example.com node smoke.mjs --expect-inbound --inbound-subject "postern hello"
# then send a real email with that subject to an address on your domain
```

**What we measured** on a fresh throwaway domain (2026-11-10): the install took 22
seconds. The first send was accepted about a minute after Sending was enabled. A message
sent to an address on the domain was stored as inbound 2 seconds later.

### Troubleshooting

- **"did not answer yet"**: a new Custom Domain can take a few minutes to get its
  certificate. Wait, then run the install command again. It resumes where it stopped.
- **"this machine cannot resolve mail.example.com yet"**: the record exists in
  Cloudflare, but your resolver cached "no such host" from a lookup made a moment before
  the record existed. It keeps that answer for up to the zone's negative TTL (often 30
  minutes). Check with `dig +short mail.example.com` (it asks the DNS servers directly).
  Then either wait, or flush your resolver cache, and run the install command again.
- **`E_SENDER_DOMAIN_NOT_AVAILABLE` on the first sends**: Email Sending is still
  propagating. Wait about a minute.

## 3. Keep it current: upgrade and rollback

```bash
git fetch --tags && git checkout vX.Y.Z
node deploy/postern.mjs upgrade --domain example.com --dry-run
node deploy/postern.mjs upgrade --domain example.com
```

`upgrade` applies only the migrations that are new, then deploys the new Worker. On a
store that already holds mail, a migration that is not purely additive does NOT
auto-apply. The upgrade stops and tells you to back up and apply it by hand
([docs/OPERATIONS.md](docs/OPERATIONS.md)). Before it migrates, the upgrade records a D1
Time Travel bookmark and the Worker version it replaces.

```bash
node deploy/postern.mjs rollback --domain example.com              # previous Worker version
node deploy/postern.mjs rollback --domain example.com --restore-db # and D1 to the bookmark
```

`rollback` changes only the Worker version and, with `--restore-db`, the D1 store. It
never touches Email Routing or DNS, because **disabling Email Routing deletes the MX, SPF
and DKIM records it manages**, and mail to your domain then stops arriving. Do not
disable Routing by hand to "undo" an install. If you must, first save what
`GET /zones/<zone>/email/routing/dns` returns, so you can re-create those records.

`--restore-db` loses the mail stored after the upgrade. Use it only when the new schema
is the problem. After a rollback, check out the older tag before you run `install` or
`upgrade` again.

**Worker vars:** set them with `--var KEY=VALUE`, not in the dashboard. Each deploy
replaces the live vars with the configured set, so a var set only in the dashboard is
lost at the next upgrade.

## Why there is no "Deploy to Cloudflare" button

We checked Cloudflare's Deploy to Cloudflare button documentation
(developers.cloudflare.com/workers/platform/deploy-buttons, read 2026-11-10). The button
can create the D1 database and the R2 bucket, ask for secrets, and run the D1 migrations
from a `deploy` script. It cannot do the parts that make Postern a mail server:

- It does not set up **Email Routing** or its catch-all rule, so no mail would arrive.
- It does not create **DNS records** (MX, SPF, DKIM, DMARC), and it does not turn on
  **Email Sending**, so no mail could leave. `send_email` is not on its list of bindings
  it provisions.
- It does not attach a **Custom Domain**, and it deploys the repository's `vars` as they
  are. Postern needs `ALLOWED_FROM_DOMAIN` set to YOUR domain; with the template value,
  every send is refused.
- It does not fully support repositories with several projects. The Worker lives in
  `inbound/` beside other components, and it clones the whole repository into your Git
  account.

So the button would leave a Worker that can neither receive nor send. The installer above
does every one of those steps with your own token. We will check the button again when
Cloudflare adds Email Routing to it.

## Agents, scripts and more people

**Agent and script clients** (no clone required):

```bash
# MCP (Cursor / Claude Code): npx -y @skyphusion/postern-mcp with POSTERN_API_URL + POSTERN_API_TOKEN
npm install -g @skyphusion/postern-mcp   # optional global install

# Python CLI + library
pip install postern-client
export POSTERN_API_URL=https://mail.example.com   # POSTERN_API_URL in your credentials file
export POSTERN_API_TOKEN=<your-token>
postern ping
```

For **more than one person or agent**, mint a per-identity registry token with
`"scopes": ["read"]` (or `["read","send"]`) and put **that** token in each client's
`POSTERN_API_TOKEN` -- do not share the estate API token. Register identities in
`POSTERN_SEND_IDENTITIES` (config var; see
[docs/SEND-IDENTITIES.md](docs/SEND-IDENTITIES.md) section 7). MCP send opt-in:
`POSTERN_SEND_TOKEN` or `POSTERN_MCP_SEND=1` ([mcp/README.md](mcp/README.md)).

See [docs/INTEGRATION.md](docs/INTEGRATION.md), [mcp/README.md](mcp/README.md), and
[clients/python/README.md](clients/python/README.md).


**Read this before you hand a credential to an agent.** If you give an agent a
per-identity registry entry whose `scopes` include `read` (see
[docs/SEND-IDENTITIES.md](docs/SEND-IDENTITIES.md)), **that agent reads the mail addressed
to every human on this deployment.** It is on by default, there is no key that narrows it,
and you inherit it on first run.

That is deliberate: Postern is email for agents and humans, and an agent that cannot read
the humans' mail does not deliver the product. But if you are standing this up for a
family, a team or anyone whose mail is not yours to read, decide it on purpose:

- An entry whose `scopes` omits `read` is refused on every read route. That is the
  supported way to run an agent that can send and cannot read.
- The widening is READ only. Marking read, flagging, filing, and what a reply or forward
  may quote all stay bound to the agent's own address.
- **The widening follows the CREDENTIAL, not the person.** This is the part most likely to
  surprise you. A cookie SESSION is scoped exactly as before, to that person plus any role
  queue they are on, but sessions exist only when you set `WEBMAIL_AUTH_BACKEND = "native"`.
  **Unset is the default, and the default webmail is BYO-token**, which sends an
  `Authorization: Bearer` header. So a human who pastes a read-capable registry token into
  webmail is a registry Bearer as far as the worker is concerned, and reads the estate. If
  you want a person scoped to their own mail, give them a session or give them a token whose
  `scopes` omit `read`; do not assume the browser makes them a human.
- Every read response carries `identityScope`, so you can confirm what a credential
  actually reaches: `curl -sH "authorization: Bearer <token>" "$BASE/api/whoami"` reports
  it directly.

## 4. Human doors (optional): webmail and IMAP

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

#### Optional: username/password sign-in (session mode, #351)

Webmail can also mint a short-lived, HttpOnly-cookie **session** from a
username/password (the same `smtp_credentials` login you provision for SMTP
submission), instead of pasting a token. It is **off by default** so that
enabling this build changes nothing on an existing deployment; turn it on with an
explicit config var (a plain `vars` entry, not a secret; it holds no credential).
The installer (section 1) turns it on for a new install and creates the first login:

```jsonc
// wrangler config "vars"
"WEBMAIL_AUTH_BACKEND": "native",          // unset/"off" (default) = BYO-token only
// optional session windows (seconds):
"WEBMAIL_SESSION_IDLE_SECONDS": "1800",     // sliding idle window (default 30 min)
"WEBMAIL_SESSION_ABSOLUTE_SECONDS": "43200" // absolute cap (default 12 h)
```

With `native`, users sign in with a username and password you create through the user
API (`POST /api/admin/users` with the `both` token, or `postern admin users create`
from the Python CLI); the same login works for SMTP submission and IMAP. Unset stays
`off` on every upgrade: a deploy that already has logins does not turn sign-in on by
itself. The session grants read + send + delete
(browse, compose, organize, and empty its own Trash), and sign-out revokes it
instantly server-side. Directory
(`ldap`/`system`) sign-in is designed but deferred, so those deployments keep using
BYO-token webmail. Details: [webmail/README.md](webmail/README.md).

#### First run in the browser (optional)

A deploy with no users yet can create its first user from the webmail page, so nobody has
to paste a token. It is armed only while ALL THREE hold:

1. `WEBMAIL_AUTH_BACKEND` is explicitly `"native"` (unset or `"off"` disarms it),
2. the Worker secret `POSTERN_SETUP_TOKEN` is set, at least 32 characters (a shorter
   value is treated as unset), and
3. there are zero users (a disabled user still counts, so setup never re-opens).

```bash
( umask 077; openssl rand -base64 33 | tr -d "\n" > setup-token.txt )   # 44 characters, mode 600
npx wrangler secret put POSTERN_SETUP_TOKEN < setup-token.txt
```

`setup-token.txt` holds the value you type on the setup screen. Open `/webmail`: it shows the first-run form,
which asks for the setup token, a username and a password. The first user is created and
signed in, and setup closes for good (a second attempt answers `409 E_SETUP_COMPLETE`).
**Then delete the secret**, once an unauthenticated `GET /api/session` reports
`"setupRequired": false`:

```bash
npx wrangler secret delete POSTERN_SETUP_TOKEN
rm setup-token.txt
```

The server refuses setup once a user exists even if the secret stays, but one less
credential at rest is better. The installer (section 1) does not use this path.

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

## 5. Operating it: backup, restore, monitoring

A deployed mailbox needs a durability and health story: how to back up the D1
store and R2 attachment bytes, restore into a fresh store, and monitor that mail
keeps flowing. That is its own guide: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## 6. Try it locally (no Cloudflare account needed)

Everything except real mail delivery runs on your machine under `wrangler dev`,
with local D1 and R2: the API, the smoke, simulated inbound mail, webmail, the
IMAP proxy, and the MCP / Python clients. It is a quick way to see the product
work before you onboard a domain or pay for Workers Paid. The shipped
`wrangler.jsonc` works as-is for this; no edits needed.

```bash
cd inbound
npm ci
printf 'POSTERN_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars   # gitignored; local secrets
npx wrangler d1 migrations apply postern --local
npx wrangler dev                                                        # serves http://localhost:8787
```

In a second terminal, also in `inbound/`:

```bash
TOKEN=$(sed -n 's/^POSTERN_API_TOKEN=//p' .dev.vars)

# the acceptance smoke (outbound + store + threading + filters + attachments)
POSTERN_BASE_URL=http://localhost:8787 POSTERN_API_TOKEN=$TOKEN \
POSTERN_FROM=noreply@example.com POSTERN_TO=you@example.com node smoke.mjs

# simulate an inbound delivery, then find it
printf 'From: a@sender.example\r\nTo: you@example.com\r\nSubject: postern hello\r\nMessage-ID: <1@sender.example>\r\n\r\nhi\r\n' \
  | curl --data-binary @- 'http://localhost:8787/cdn-cgi/handler/email?from=a@sender.example&to=you@example.com'
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:8787/api/search?q=hello'
```

Webmail is at `http://localhost:8787/webmail` (origin `http://localhost:8787`, the
token above). Outbound sends are not delivered locally: wrangler writes each one
to a file under `.wrangler/tmp/email/` and logs the path. Vectorize / Workers AI
(semantic search) have no local equivalent, so search is full-text only here.

## Appendix A: manual install, step by step

This is what the installer does, written out as commands. Use it to understand the
installer, or to install somewhere it cannot reach. If you install by hand, the
installer can take over your install later with `--adopt`.

**Dashboard steps on this path.** Onboard the domain to Email Sending
(Dashboard -> Compute & AI -> Email Service -> Email Sending -> Onboard Domain), and turn
on Email Routing with MX pointed at Cloudflare (Dashboard -> Email -> Email Routing).
From `inbound/`, `npx wrangler email sending enable <domain>` and
`npx wrangler email routing` do the same from the command line.

### A1. Create the storage resources

The store (D1 + R2, optionally Vectorize) is per-account; there is no shared
default. Create your own:

Every command in this guide runs from `inbound/` unless it says otherwise.

```bash
cd inbound
npm ci                                       # installs the pinned wrangler; do this before any npx wrangler
npx wrangler login
npx wrangler d1 create postern --binding DB  # writes database_id into the existing DB block
npx wrangler r2 bucket create postern-attachments --binding ATTACHMENTS
# optional (semantic search):
#   npx wrangler vectorize create postern-vec --dimensions=768 --metric=cosine --binding VECTORIZE
```

Pass `--binding` exactly as shown. Without it, wrangler asks "Would you like
Wrangler to add it on your behalf?" and, if you accept its defaults, APPENDS a
second `d1_databases` entry named `postern` while the `DB` entry the Worker
actually uses keeps its `<your-d1-database-id>` placeholder (the R2 command
likewise appends a stray `postern_attachments` binding). With `--binding` it
fills in the existing entry instead. Either way wrangler rewrites the file with
tab indentation; that is cosmetic.

Edit `inbound/wrangler.jsonc`:
- check the `DB` entry in `d1_databases` now carries your real `database_id`
  (if you created the database without `--binding DB`, paste the id in by hand and
  delete any extra entry wrangler appended),
- set `DEFAULT_FROM`, `DEFAULT_FROM_NAME`, `ALLOWED_FROM_DOMAIN` to your domain
  (`ALLOWED_FROM_DOMAIN` is required; there is no built-in default, and sends refuse
  without it),
- to reach the worker over `https://postern.<subdomain>.workers.dev` (the URL the
  webmail and smoke steps below use), set `"workers_dev": true`. The shipped
  default is `false` (secure-by-default: no public door; a production install
  instead adds a token-gated custom route on your own domain), so with the
  default left in place `npm run deploy` gives you no reachable URL to smoke.
- (optional) if you created the index, uncomment the `ai` block (the
  `vectorize create ... --binding VECTORIZE` above already added the `vectorize`
  entry).

Build the store:

```bash
npx wrangler d1 migrations apply postern --remote
```

This runs the migration chain under `inbound/migrations/` against the empty
database and records each file in wrangler's `d1_migrations` table, so a later CI
deploy applies only migrations that are new. `schema.sql` produces the same
tables, indexes, and columns in one file, but using it means baseline-seeding
`d1_migrations` by hand before any CI deploy (next section).

### A2. Set the API token and deploy

```bash
npm run deploy   # first deploy creates the Worker; secret put below needs it to exist
npx wrangler secret put POSTERN_API_TOKEN   # generate one: openssl rand -hex 32
```

**Scoped tokens (optional).** `POSTERN_API_TOKEN` alone is a `both`-scoped key and works
for everything below; split it only if you want narrower blast radius per consumer.
Each is its own Worker secret holding a value you generate (`openssl rand -hex 32`);
full table in [docs/AUTH-CONTRACT.md](docs/AUTH-CONTRACT.md):

```bash
# read-only: list/search/get. What a read-only agent, script, or webmail tab should hold
npx wrangler secret put POSTERN_API_TOKEN_READ
# send-only: /api/send + /api/reply (compose in webmail, MCP send opt-in)
npx wrangler secret put POSTERN_API_TOKEN_SEND
# EXPUNGE-only (hard delete), separate from the read token (#278); used by the IMAP door
npx wrangler secret put POSTERN_API_TOKEN_DELETE
# imap-scoped (IMAP door): durable Drafts + Trash/Junk/Archive APPEND import (#352);
# unset means those writes refuse rather than silently no-op
npx wrangler secret put POSTERN_API_TOKEN_IMAP
# organize-only: mark read, set flags, move between folders (#692). Not read, not
# send, not delete, and NOT the folder list, which is a read. What a filing bot or a
# CI probe holds when it must file mail and must not read it
npx wrangler secret put POSTERN_API_TOKEN_ORGANIZE
```

See "Agents, scripts and more people" above before you hand a token to an agent.

With `workers_dev` enabled (above), `npm run deploy` prints the deployed URL, e.g.
`https://postern.<your-subdomain>.workers.dev`. Allow up to a minute after the
first deploy for the workers.dev route to go live before you smoke it.

Open `https://postern.<your-subdomain>.workers.dev/webmail` to browse the mailbox
in a browser (paste that origin + your `POSTERN_API_TOKEN`). That workers.dev URL
is the smoke posture; a production install serves the API on a hostname you
control (see "Production door" below) and stands up the human doors (webmail
compose, the IMAP proxy) per section 4.

#### Production door: the API on your own domain

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

### A2b. Create the first user

Sessions (webmail sign-in) and SMTP submission both need a user. Pick ONE way:

- **With the mailbox token** (what the installer does). Use the `both` token from A2:
  ```bash
  printf "%s" "{\"username\":\"admin@example.com\",\"displayName\":\"Admin\"}" | \
    curl -sS -X POST "https://mail.example.com/api/admin/users" \
      -H "authorization: Bearer $POSTERN_API_TOKEN" -H "content-type: application/json" --data-binary @-
  ```
  The answer is `201` with the user and a generated password, shown ONCE (pass
  `"password"` to choose one: 12 to 256 characters, not the username). A repeat answers
  `409 E_CONFLICT` and changes nothing. A username is a login of `a-z 0-9 . _ -`
  (1 to 64 characters), optionally `@example.com`; anything else is `400 E_INVALID_USERNAME`.
  The CLI equivalent is `postern admin users create admin@example.com --name Admin`.
- **In the browser**, with no token at hand: set `WEBMAIL_AUTH_BACKEND = "native"`, put
  the `POSTERN_SETUP_TOKEN` secret, and follow section 4, "First run in the browser".
  Delete the secret afterwards.

To turn webmail sign-in on, set `WEBMAIL_AUTH_BACKEND = "native"` in the config `vars`
and redeploy. Unset means `off`.

### A3. Wire inbound mail (for the receive leg)

In the Dashboard -> Email -> Email Routing -> Routing Rules, route all addresses
(including catch-all) to the deployed Worker. The worker stores every inbound
message, then forwards the original to `FORWARD_TO` if you set one.

**Scripted alternative (#314), for agent-driven or CI installs.** The installer does
this step for you. To do only this step over the API,
`inbound/scripts/setup-email-routing.mjs` sets it by pointing the zone's catch-all rule at the deployed Worker over the API:

```bash
CF_API_TOKEN=<token> CF_ACCOUNT_ID=<account-id> CF_ZONE_ID=<zone-id> \
  node scripts/setup-email-routing.mjs --dry-run   # print the plan first
# drop --dry-run to apply
```

The account and zone ids are on your domain's Overview page in the Dashboard.
`--dry-run` applies nothing, but it still calls the API to resolve the Worker, so
it needs the same token.

The token needs **Email Routing Rules: Edit** (zone) to write the rule, plus
**Workers Scripts: Read** (account) so the script can resolve the deployed
Worker's `owner_worker_tag`. This still only sets the catch-all rule; remove
any conflicting per-address "Forward to email" rules in the Dashboard so every
address reaches the Worker.

### A4. Run the smoke

The smoke takes your own values; it has no built-in domain or account.

```bash
# Outbound + store + reply-threading (no real inbound needed):
POSTERN_BASE_URL=https://postern.<your-subdomain>.workers.dev \
POSTERN_API_TOKEN=<your-token> \
POSTERN_FROM=noreply@<your-domain> \
POSTERN_TO=you@<your-domain> \
node smoke.mjs

# Full v1.0 acceptance, including a real inbound delivery (A3 wired):
POSTERN_BASE_URL=https://postern.<your-subdomain>.workers.dev \
POSTERN_API_TOKEN=<your-token> \
POSTERN_FROM=noreply@<your-domain> \
POSTERN_TO=you@<your-domain> \
node smoke.mjs --expect-inbound --inbound-subject "postern hello"
# then send a real email to an address on your domain with that subject.
```

A green run is the v1.0 launch artifact: deploy -> send -> store -> reply
threads -> inbound arrives and is searchable, all asserted on the structured
store/API, not on prose.

## Appendix B: deploy from CI (GitHub Actions)


The deploy workflow (`.github/workflows/deploy.yml`) is **tag-gated**: it
runs on a pushed SemVer tag (`v*`), never on a merge to `main`. When it runs, it
applies `wrangler d1 migrations apply DB --remote` before the inbound deploy, so
a schema change ships with its code. Wrangler tracks which migration files have
already run in a `d1_migrations` table and applies only the pending ones.

**Repository secrets it reads** (GitHub: Settings -> Secrets and variables ->
Actions):

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token that can deploy Workers and edit
  D1 on your account (the "Edit Cloudflare Workers" template plus D1 Edit).
- `CLOUDFLARE_ACCOUNT_ID`: your account id (Dashboard, your domain's Overview page).
- `POSTERN_INBOUND_WRANGLER`: your complete real `wrangler.jsonc` (comments are
  fine). CI deploys THIS, not the committed template, and `wrangler deploy`
  replaces vars wholesale, so it must carry your real ids and every var you rely
  on. Without it CI deploys the committed template, whose placeholder
  `database_id` cannot deploy.
- `POSTERN_SMOKE_*` (optional): see below.

**What the tag gate checks first.** Every tag-triggered workflow (deploy, the
GitHub Release, the PyPI publish, both door images) starts with one shared
preflight, `.github/scripts/tag-preflight.sh`, and refuses the whole set if the
tag is not shippable. Before you push `vX.Y.Z`, make sure that commit is on your
default branch and carries the same version in all three pins
(`clients/python/pyproject.toml`, `clients/python/postern_client/__init__.py`,
`inbound/package.json`) and in `inbound/src/version.ts` (what `/health` reports), plus a non-empty `## vX.Y.Z` section in `CHANGELOG.md`.
This is deliberate: it exists because a tag once deployed production while the
release and publish jobs failed on missing pins. If you run your own fork on your
own version numbers, bump those three pins and `inbound/src/version.ts`, and add your CHANGELOG section in the
same commit you tag.

**In a fork, a `v*` tag fires more than the deploy.** The same tag also triggers
the GitHub Release (`release.yml`), the PyPI publish of `postern-client`
(`publish-pypi.yml`), and the two door-image workflows (`imap-image.yml`,
`relay-image.yml`, which also run on pushes to `main` that touch `imap/` or
`relay/`). Those publish to the upstream project's PyPI name and
`ghcr.io/skyphusion-labs/*` and will fail in a fork. If you only want your Worker
deployed, disable those four workflows in your fork (Actions -> the workflow ->
"Disable workflow"), or skip CI entirely and install with the installer (section 1) or by hand (Appendix A).

After the deploy, the workflow verifies the ARTIFACT rather than trusting a green
run: it reads the live deployment back out of the API and asserts the Worker is
serving the version that run just uploaded. Set the optional `POSTERN_SMOKE_*`
secrets (same ones `smoke-staging.yml` uses) and it also runs
`inbound/smoke.mjs` against your live instance on each release.

**If you built the store from `schema.sql` instead** (`npx wrangler d1 execute
postern --remote --file=schema.sql` in place of `migrations apply`): the schema is
already current, but `d1_migrations` is still empty. The first CI deploy will try to re-apply
`0001_attachments_fts_dmarc.sql` and later files against an already-built store
and fail (for example `duplicate column name`). The migration gate (#112) may
catch this with a clearer message, but the fix is the same: **baseline-seed**
`d1_migrations` once so the pipeline sees every migration through the current
schema as already applied.

After `schema.sql` succeeds, run `d1 migrations list` first: the
`d1_migrations` tracking table does not exist yet on a fresh store, and this
is what creates it (wrangler makes the table on first list/apply against a
database that lacks one). Only then insert each migration filename (exactly
as on disk under `inbound/migrations/`) as already applied. Do not hand-copy the
filename list (it drifts as migrations are added); generate the INSERTs from the files
actually on disk:

```bash
npx wrangler d1 migrations list postern --remote   # creates d1_migrations, lists all as pending
for f in migrations/*.sql; do
  name=$(basename "$f")
  npx wrangler d1 execute postern --remote --command "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${name}')"
done
```

Verify nothing is pending:

```bash
npx wrangler d1 migrations list postern --remote
```

**Migrations path (the default in A1):** migration `0000_base_schema.sql`
creates the base `messages` table, so the full chain (every file under
`inbound/migrations/`) bootstraps an empty store on its own; wrangler creates
`d1_migrations` and records each file as it runs, and CI then no-ops until a new
migration lands. Use this OR the `schema.sql` + baseline-seed path above, never
both. (`0000` is `CREATE TABLE IF NOT EXISTS`, so it is also a harmless no-op on
a store already built by `schema.sql`.)

**Existing store / offline migration (0005 pattern):** when a migration must be
applied manually (core-table rebuild, backup-first operation), back up first
(see [docs/OPERATIONS.md](docs/OPERATIONS.md)), apply it by hand with
`npx wrangler d1 execute postern --remote --file=migrations/<file>.sql`, verify,
then baseline-seed **only that migration name**
(or the full set through your current schema revision) before merging code that
expects it. Do not rely on CI to auto-apply destructive migrations; the gate
blocks them unless the file carries an explicit `-- postern:allow-destructive`
marker reviewed for online apply.

When new migrations ship in the repo, CI applies only the ones not yet in
`d1_migrations`; additive migrations pass the gate automatically.
