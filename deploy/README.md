# deploy/: the Postern installer

One command stands Postern up in YOUR OWN Cloudflare account. The same command, run
again, changes nothing. Run against a newer release, it upgrades. Your mail stays in
your account; the installer talks only to the Cloudflare API, with your token.

```bash
git clone https://github.com/skyphusion-labs/postern && cd postern
export CLOUDFLARE_API_TOKEN=...            # see "The token" below; never printed
node deploy/postern.mjs install --domain example.com --dry-run   # the plan, no changes
node deploy/postern.mjs install --domain example.com
node deploy/postern.mjs status  --domain example.com             # read-only report, any time
node deploy/postern.mjs routing --domain example.com             # does every address reach the Worker?
node deploy/postern.mjs uninstall --domain example.com           # remove it; your mail is kept
```

(`example.com` stands for your own domain here. The installer refuses the documentation
domains themselves: an install on one deploys and then refuses every send.)

Needs Node 22 or later. The first run installs the pinned wrangler (`npm ci` in `inbound/`).

## What it does

In this order, and each step only if the live state needs it:

1. D1 database `postern` and R2 bucket `postern-attachments`.
2. Renders your real wrangler config from `inbound/wrangler.jsonc` into the state dir
   (your ids, `ALLOWED_FROM_DOMAIN`, `DEFAULT_FROM=noreply@<domain>`,
   a Custom Domain at `mail.<domain>`). The committed template is never edited.
3. Applies the D1 migrations that are not yet applied.
4. Deploys the Worker, with a generated `POSTERN_API_TOKEN` uploaded in the same step,
   and reads the live deployment back to confirm it serves that version.
5. Email Sending for the domain, plus any DKIM / SPF / bounce record it needs.
6. Email Routing (Cloudflare adds and locks the MX and SPF records), and the catch-all
   rule pointed at the Worker.
7. A DMARC record (`p=none` by default; `--dmarc quarantine|reject`) ONLY if the domain
   has none. An existing DMARC policy is never touched.
8. The first admin login (`admin@<domain>`; `--admin` to change), through the user API
   (`POST /api/admin/users`). It only creates; if that user already exists, it is left
   exactly as it is.

**Webmail sign-in.** An unset `WEBMAIL_AUTH_BACKEND` means sign-in is OFF. A NEW install
sets `WEBMAIL_AUTH_BACKEND=native`, so the first admin can sign in at once. An existing
Worker keeps what it has: `upgrade` never adds the var, and `--adopt` carries the live
value (or its absence) over. Change it with `--var WEBMAIL_AUTH_BACKEND=...`.

**Agent reads.** An unset `AGENT_READ_SCOPE` means an agent credential reads the whole
deployment (as before #740). A NEW install sets `AGENT_READ_SCOPE=granted`, so an agent
reads its own address plus the addresses an operator grants it. `upgrade` never adds the
var, and `--adopt` carries the live value over, the same as `WEBMAIL_AUTH_BACKEND`. See
[DELEGATION.md](../docs/DELEGATION.md) section 4.

Every line of output says `created`, `updated`, `unchanged` or `kept`, and names the
resource. Secrets go to `.postern/postern.<domain>.credentials.env` (mode 600). The output
prints that path, never the values.

## It refuses, and changes nothing, when

All refusals are collected and shown together before any write:

- the domain is a documentation placeholder (`example.com`, `example.net`, `example.org`,
  `*.example`, `*.invalid`, `*.localhost`), or a `--var` moves `ALLOWED_FROM_DOMAIN` or
  `DEFAULT_FROM` off `--domain`;
- the token lacks a permission the run needs (the permission is named);
- the domain is not a zone this token can see;
- the domain already receives mail elsewhere (an MX record not pointing at Cloudflare);
- an Email Routing rule, or the catch-all, already sends mail somewhere other than Postern;
- the domain has an SPF record without `include:_spf.mx.cloudflare.net` (merge it by hand:
  changing SPF changes who may send as you);
- the web hostname already has a DNS record;
- a Worker, D1 database or R2 bucket of the same name exists that this installer did not
  create (pass `--adopt` if it is your earlier Postern install).

A run that stops partway (a network blip, a slow certificate, a permission found missing
at a write) says what it finished. Re-run the same command to resume; it does not
duplicate anything.

## The token

Create a Cloudflare API token (My Profile, or the account's API Tokens page) scoped to your
account and the one zone, with:

| Scope   | Permission                   |
|---------|------------------------------|
| Zone    | Zone: Read                   |
| Zone    | DNS: Edit                    |
| Zone    | Email Routing Rules: Edit    |
| Zone    | Workers Routes: Edit         |
| Zone    | Zone Settings: Edit          |
| Account | Workers Scripts: Edit        |
| Account | D1: Edit                     |
| Account | Workers R2 Storage: Edit     |
| Account | Email Sending: Edit          |
| Account | Account Settings: Read       |

A token with this set plus Account: Email Routing Addresses: Edit was measured (2026-11-10) on
a full install, its re-runs, an upgrade that applied a migration, and the teardown. No command
reads or writes Email Routing destination addresses, so that permission is not needed and is
left out here. A smaller set may work; that has not been measured. Email Sending
is an ACCOUNT permission, even though it is enabled per domain. Scope the zone
permissions to your mail domain only.

The installer probes its permissions with reads before it writes anything. Outbound mail needs
the Workers Paid plan; that is a billing choice, so the installer leaves it to you.

## Is my mail reaching Postern? (the routing report)

`node deploy/postern.mjs routing --domain example.com` is read-only. It lists every Email
Routing rule on the zone and names each address that does NOT land on the Worker
(`--name`, default `postern`). A per-address rule beats the catch-all, so one forwarding
rule removes that address from Postern while deploys, health checks and smoke tests all stay
green. The report prints how many rules it examined, so a clean result is a count, not a
bare OK:

```
Email Routing on example.com -> Worker postern: enabled, 3 rule(s) examined (1 disabled, ignored)
  ok   rule "agent" agent@example.com -> worker postern
  off  rule "old forward" old@example.com -> forward x@elsewhere.example
  ok   catch-all "catch-all" (every unmatched address) -> worker postern
result: all 2 enabled rule(s) land on Worker postern; no address is routed around it.
```

It exits 0 when every address reaches the Worker, and 1 when one does not. It also exits 1
when it could not make a reading: if the token cannot see whether Routing is enabled, the
report says `NOT MEASURED` and never reads as clean. It exits 3 when the token cannot read
the rules at all. It needs only **Zone: Read**, **Email Routing Rules: Read** and **Zone
Settings: Read**. The settings read (is Routing enabled?) takes Zone Settings, not an
Email Routing permission. `status` prints the same report first. It never changes a rule:
fix one in the dashboard or with your own IaC, then run it again. The `routing-report`
workflow runs it from GitHub Actions (on demand, and weekly when the repo variable
`ROUTING_REPORT_DOMAIN` is set).

## Names, and running beside other Workers

The Worker, D1 database and R2 bucket are named from `--name` (default `postern`; the bucket
is `<name>-attachments`). `--prefix <p>` puts `<p>` in front of all three. Use it to stand a
test install up in an account that already runs other things. The installer never writes an
account resource under any other name.

## What to expect on a new domain

Measured on a fresh throwaway zone (2026-11-10): the install itself took 22 seconds.
Cloudflare then took about a minute before it accepted the first send from the newly
enabled domain (`E_SENDER_DOMAIN_NOT_AVAILABLE` until then). After that, a message sent to
an address on the domain was stored as inbound about 2 seconds later.

Enabling Email Sending makes Cloudflare add its own DKIM, SPF and bounce records
(locked), and a `_dmarc` record with `p=reject` if the domain has none. The installer
writes your `--dmarc` choice first, so the policy is yours.

## Upgrade and rollback

```bash
git fetch --tags && git checkout vX.Y.Z
node deploy/postern.mjs upgrade --domain example.com --dry-run
node deploy/postern.mjs upgrade --domain example.com
```

`upgrade` is `install` against the newer tree, with two extra guarantees. On a store that
already holds mail, a migration that is not purely additive does NOT auto-apply: the same
gate the release pipeline uses (`.github/scripts/d1-migration-gate.mjs`) refuses it. Before
it migrates, `upgrade` records a D1 Time Travel bookmark and the Worker version it replaces.

```bash
node deploy/postern.mjs rollback --domain example.com             # Worker back to the previous version
node deploy/postern.mjs rollback --domain example.com --restore-db # and D1 back to the bookmark
```

`rollback` touches only the Worker version and, with `--restore-db`, the D1 store. It never
changes Email Routing or DNS. That is deliberate: **disabling Email Routing deletes the MX,
SPF and DKIM records it manages** (measured 2026-11-10), so a zone's mail would stop
arriving. If you ever disable Routing yourself, first save what
`GET /zones/<zone>/email/routing/dns` returns, so that you can re-create those records.

`--restore-db` LOSES mail stored after the upgrade. Use it only when the new schema is the
problem. Most rollbacks need only the Worker. Migrations are additive, so the older Worker
runs against the newer schema. After a rollback, check out the older tag before the next
`install` or `upgrade`, or that run deploys the newer code again.

## Uninstall

```bash
node deploy/postern.mjs uninstall --domain example.com --dry-run   # what it would remove
node deploy/postern.mjs uninstall --domain example.com             # keeps your mail
node deploy/postern.mjs uninstall --domain example.com --delete-data --confirm-delete example.com
```

Uninstall removes only what this installer's state file records creating (or adopting with
`--adopt`). In order:

1. **The catch-all rule** stops pointing at the Worker (it is disabled, action drop).
   **Email Routing itself stays ON.** Turning Routing off makes Cloudflare delete the zone's
   MX, SPF and DKIM records (measured in pt1110), which would also take away mail you may
   want to receive some other way. Turn it off yourself, knowing that, if you mean to.
2. **The Worker's custom domain**, then **the Worker**.
3. **Email Sending** for the domain, but only if this installer enabled it. Cloudflare's
   DELETE also removes the Sending DNS records it added (per the API reference).
4. **Your mail (D1 and R2) is kept** unless you pass `--delete-data` AND
   `--confirm-delete <domain>`, with the domain typed out. Then D1 is first exported with
   `wrangler d1 export` to `<state-dir>/<name>.<domain>.export-<time>.sql` (mode 600).
   D1 is deleted only after that file exists and is not empty. An R2 bucket is deleted only
   if it is empty (Cloudflare refuses otherwise). If it still holds attachments, uninstall
   says so and keeps it.

It never changes your DMARC record or any DNS record it did not create. A second run changes
nothing. The credentials file stays; delete it yourself when you no longer need it.

## Output never carries a secret

Every line the installer prints, and every error message, passes through one redactor. It
replaces the Cloudflare token, every secret the run generated, and every token or password
in the credentials file with `[redacted]`. So "never printed" does not depend on what
wrangler or the API happens to echo back.

## State

`.postern/` (gitignored) holds the account and zone ids, what this installer created, your
`--var` settings, and the upgrade history. Every step re-reads live state, so losing this
directory loses no data. The next run then asks for `--adopt` for the resources it finds,
and the credentials file is gone with it, so keep a copy.

Worker vars: set them with `--var KEY=VALUE`. They are remembered for every later run.
Do not edit vars in the dashboard: each deploy replaces the live vars with the configured
set, so a dashboard-only var is lost at the next upgrade. `POSTERN_TEST_PBKDF2_ITERATIONS`
is test-only and lowers password hashing strength; the installer refuses it in the
rendered config vars and in the Worker secret list.

## Tests

`node --test deploy/test/*.test.mjs` runs the installer against an in-memory Cloudflare account
(`deploy/test/fake-cloudflare.mjs`): a fresh install, a second run that writes nothing, resume
after a failure at several points, every refusal (each asserted to make zero writes), upgrade,
the migration gate, and rollback. No test talks to Cloudflare.
