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
| Account | Email Routing Addresses: Edit|
| Account | Account Settings: Read       |

A token with exactly this set was measured (2026-11-10) on a full install, its re-runs,
an upgrade that applied a migration, and the teardown. A smaller set may work; that has not been measured. Email Sending
is an ACCOUNT permission, even though it is enabled per domain. Scope the zone
permissions to your mail domain only.

The installer probes its permissions with reads before it writes anything. Outbound mail needs
the Workers Paid plan; that is a billing choice, so the installer leaves it to you.

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

## State

`.postern/` (gitignored) holds the account and zone ids, what this installer created, your
`--var` settings, and the upgrade history. Every step re-reads live state, so losing this
directory loses no data. The next run then asks for `--adopt` for the resources it finds,
and the credentials file is gone with it, so keep a copy.

Worker vars: set them with `--var KEY=VALUE`. They are remembered for every later run.
Do not edit vars in the dashboard: each deploy replaces the live vars with the configured
set, so a dashboard-only var is lost at the next upgrade.

## Tests

`node --test deploy/test/*.test.mjs` runs the installer against an in-memory Cloudflare account
(`deploy/test/fake-cloudflare.mjs`): a fresh install, a second run that writes nothing, resume
after a failure at several points, every refusal (each asserted to make zero writes), upgrade,
the migration gate, and rollback. No test talks to Cloudflare.
