# Postern go-live runbook (SUPERVISED, Conrad-executed)

Status: **runbook only. Every step here is GATED and waits for Conrad's supervised
window.** Nothing in this file has been run. It is the turnkey sequence to flip
Postern from "loopback/mesh-only, built + tested" to "publicly reachable mail," in
the order that does not break live email or expose a half-built endpoint.

Read first: `docs/AUTH-CONTRACT.md` (the auth bindings), `imap/DEPLOY.md`,
`relay/SUBMISSION-DEPLOY.md` (the two doors, already deployed loopback-only), and
skyphusion-labs/postern#74 (the deploy drift this fixes).

## Operating rules for the window (aviation discipline)

- **One variable at a time. Verify after each step before the next.**
- **Keep a known-good root/console session open on dischord** for the duration (the
  fleet SSH path is LDAP-backed; do not risk locking yourself out mid-change).
- **Each gated item below has: the command, a post-step smoke check, and a
  rollback.** If a smoke check fails, STOP and roll back that step; do not proceed.
- **Deploy ordering is load-bearing:** a consumer is never repointed before its new
  target exists and is verified. `typecheck`/`wrangler deploy --dry-run` will NOT
  catch a dangling worker/route reference; only a real deploy + smoke will.
- Do NOT touch lagwagon `ip_forward`/MASQ, and fail2ban stays lagwagon-only.

## Pre-flight (confirm before touching anything)

- [ ] Loopback doors healthy: `postern-imap` on 127.0.0.1:1143, `postern-submission`
      on 127.0.0.1:1587 (if staged), inbound relay on 2525. `systemctl status` green.
- [ ] crew-secrets holds the deploy secrets (presence-check `${VAR:+SET}` only):
      `POSTERN_API_TOKEN` (store-read), `POSTERN_SEND_TOKEN`, `POSTERN_TRANSPORT_TOKEN`.
- [ ] Cloudflare API token available for DNS + Workers (minter tier, on demand).
- [ ] Decide the **exposure topology** (Phase 3 decision A vs B) BEFORE starting.
- [ ] A non-fleet host (the laptop) ready for external smoke checks.

---

## Phase 1 -- #74: deploy the renamed worker + custom domain (LIVE EMAIL, downtime-aware)

This is the foundation: both mail doors point at `https://postern.skyphusion.org`
for their store-read / send hand-off. Today the inbound/store worker is still
deployed under the OLD name `skyphusion-email-inbound`, and there is no `postern`
worker. Repo config: `inbound/wrangler.jsonc` name=`postern`,
`worker/wrangler.jsonc` name=`postern-send`.

Order matters: **create the new target, verify it, THEN repoint the live routing**,
so inbound email keeps flowing the whole time.

### 1.1 Deploy the inbound/store worker under the name `postern`

```bash
cd inbound
npm run typecheck
npx wrangler d1 migrations apply postern --remote   # apply migrations to the bound D1 first
npx wrangler deploy                                 # creates the NEW worker `postern`
```

- **Smoke:** `curl -fsS https://postern.<account>.workers.dev/health` returns 200;
  `/api/*` returns 401/403 without a token. The OLD `skyphusion-email-inbound` is
  still serving live email at this point (we have NOT repointed routing yet).
- **Rollback:** the new `postern` worker is additive; delete it
  (`npx wrangler delete --name postern`) if you abort. Live email untouched.

### 1.2 Attach the custom domain `postern.skyphusion.org`

Prefer IaC (a `routes` / custom-domain entry in `inbound/wrangler.jsonc`, then
`wrangler deploy`); the dashboard is the fallback. The custom domain creates the
orange-cloud hostname bound to the `postern` worker.

- **Smoke:** `curl -fsS https://postern.skyphusion.org/health` returns 200 (DNS +
  cert provision by CF can take a minute). `/api/*` 401/403 without a token.
- **Rollback:** remove the custom-domain binding; the `*.workers.dev` URL still works.

### 1.3 Repoint Email Routing to the `postern` worker

CF Email Routing rules currently route inbound mail to `skyphusion-email-inbound`.
Repoint ALL routing rules (including catch-all) to the `postern` worker.

- **Smoke (downtime-critical):** send a test email from an external account to a
  `@skyphusion.org` address; confirm it lands in the store via
  `curl -H "Authorization: Bearer $POSTERN_API_TOKEN" https://postern.skyphusion.org/api/messages`
  (most recent message is the test). Send a SECOND test to confirm steady state.
- **Rollback:** repoint the routing rules back to `skyphusion-email-inbound`
  (still deployed). This is the single reversible switch for live inbound email;
  do not delete the old worker until Phase 2 confirms nothing references it.

### 1.4 Deploy `postern-send` and repoint the relay's send path

`postern-send` may already be live; ensure it is current, then repoint the inbound
relay from the old `skyphusion-email` `/send` to `postern-send`.

```bash
cd ../worker && npm run typecheck && npx wrangler deploy   # ensure postern-send current
```

Then on dischord edit `/etc/skyphusion-email-relay.env`:
`EMAIL_WORKER_URL=https://postern-send.<account>.workers.dev/send` (or the custom
domain when bound), `systemctl restart skyphusion-email-relay`.

- **Smoke:** `swaks --server 127.0.0.1:2525 --from cron@skyphusion.org --to <you> --body test`
  delivers and appears sent via `postern-send` (check the worker logs /
  observability). 
- **Rollback:** restore the prior `EMAIL_WORKER_URL`, restart the relay.

### 1.5 Repoint the loopback mail doors to the custom domain

Now that `postern.skyphusion.org` is the verified live origin, move the doors off
the stopgap `*.workers.dev` URL (one env line each + restart; reversible):

- `postern-imap`: `/etc/postern-imap.env` -> `POSTERN_API_URL=https://postern.skyphusion.org`
- `postern-submission`: `/etc/postern-submission.env` ->
  `POSTERN_SEND_URL=https://postern.skyphusion.org/api/send`,
  `POSTERN_INGEST_URL=https://postern.skyphusion.org/ingest`
- `systemctl restart postern-imap postern-submission`

- **Smoke:** loopback IMAP login + SELECT INBOX (imap/DEPLOY.md step 4); loopback
  587 STARTTLS+AUTH send (SUBMISSION-DEPLOY.md step 6). Both still pass.
- **Rollback:** restore the prior URL value, restart the unit.

### 1.6 Retire the old workers (only after nothing references them)

Confirm no consumer still points at `skyphusion-email-inbound` or `skyphusion-email`
(routing rules repointed, relay repointed, doors repointed). Then delete them.

- **Smoke:** live inbound + outbound still work after deletion (repeat 1.3 / 1.4
  smokes). 
- **Rollback:** redeploy from the repo if a forgotten consumer surfaces (hence:
  delete LAST, after a soak).

---

## Phase 2 -- decide the exposure topology (do this BEFORE Phase 3)

The mail doors live on **dischord**, a fleet box whose public interface is closed
(ufw scoped to the VLAN + bastion). Exposing 587/993 is the first public-facing
service on a fleet box. Two options; pick one for the window:

- **Option A (direct):** open 587/993 on dischord's public interface; grey-cloud
  DNS A records point at dischord's public IP. Simplest; what the DEPLOY docs assume.
- **Option B (fronted):** terminate 587/993 on **lagwagon** (already the public
  edge) and proxy to dischord over the VLAN, keeping fleet boxes off the public
  internet. More aviation-grade isolation, more moving parts (a TCP proxy on
  lagwagon; do NOT touch its ip_forward/MASQ). **Flag for Conrad's call.**

The rest of Phase 3 is written for Option A; for Option B the same steps apply but
the listener + cert + ufw live on lagwagon and the A record points at lagwagon.

NB: Hetzner blocks OUTBOUND 25/465/587 on the fleet, but these are INBOUND
submission/IMAP listeners (clients connect IN), which is unaffected. The send
hand-off to the worker is HTTPS(443), which is open.

---

## Phase 3 -- expose the mail doors (per door: cert -> listener -> ufw -> DNS -> smoke)

Do the SMTP door fully (3a) and verify before starting the IMAP door (3b). For each
door the order is: provision the cert (no exposure), wire the listener (no
exposure), open the firewall (scoped), then add DNS last so the name only resolves
once the port actually serves.

### 3a. SMTP submission (587 / optional 465)

1. **TLS cert (no exposure yet).** DNS-01 against the CF DNS API issues a cert for
   `smtp.skyphusion.org` without opening a port or needing an A record:
   ```bash
   certbot certonly --dns-cloudflare \
     --dns-cloudflare-credentials /root/.cf-dns.ini -d smtp.skyphusion.org
   ```
   Point `SUBMISSION_TLS_CERT`/`SUBMISSION_TLS_KEY` at
   `/etc/letsencrypt/live/smtp.skyphusion.org/{fullchain,privkey}.pem` (world-read
   the PEMs or ACL them for the DynamicUser). Set up auto-renew (daemon hot-reloads).
   - **Smoke:** `openssl x509 -in fullchain.pem -noout -subject -dates` shows the
     right name + validity. No exposure changed.

2. **Listener (no exposure yet).** `/etc/postern-submission.env` ->
   `SUBMISSION_LISTENERS=587:starttls,465:implicit`, `systemctl restart
   postern-submission`.
   - **Smoke:** `ss -tlnp | grep -E ':587|:465'` shows the binds. Local STARTTLS+AUTH
     still works. ufw still blocks external (next step opens it).
   - **Rollback:** revert to `SUBMISSION_LISTENERS=127.0.0.1:1587:starttls`, restart.

3. **Firewall (scoped).** Open 587 (and 465 if used) in ufw. A public submission
   service is `from any`; if the audience is restricted, scope the source tighter.
   ```bash
   ufw allow proto tcp to any port 587 comment 'postern submission'
   # ufw allow proto tcp to any port 465 comment 'postern implicit-tls submission'
   ```
   - **Smoke:** from the laptop, `nc -vz <dischord-public-ip> 587` connects.
   - **Rollback:** `ufw delete allow ... 587` (and 465). Re-verify external is blocked.

4. **Public DNS (last).** Add a grey-cloud A record `smtp.skyphusion.org` ->
   dischord public IP (IaC: CF DNS API, not the dashboard). CF does not proxy SMTP
   except via Spectrum, so it MUST be grey-cloud (DNS-only).
   - **Smoke (the real artifact):** from the laptop,
     ```bash
     swaks --server smtp.skyphusion.org:587 --tls --auth PLAIN \
       --auth-user conrad --auth-password '<directory pw>' \
       --from conrad@skyphusion.org --to <external> --header 'Subject: go-live 587' --body hi
     ```
     A clean `STARTTLS -> AUTH -> 250` from OUTSIDE the fleet is the go-live proof.
     A non-`mail-users` account / bad password / `From != identity` must be rejected.
   - **Rollback:** remove the A record; the port stays open but unresolvable, then
     close ufw if fully aborting.

### 3b. IMAP (993 IMAPS)

Same sequence for the read door. Two ways to serve TLS (pick one):

- **Native IMAPS:** set `POSTERN_IMAP_TLS_CERT`/`POSTERN_IMAP_TLS_KEY` (cert for
  `imap.skyphusion.org`), set `POSTERN_IMAP_HOST=0.0.0.0` `POSTERN_IMAP_PORT=993`,
  restart `postern-imap`.
- **stunnel front:** keep the proxy loopback 1143, front it with stunnel on 993
  using the cert. (Useful if you want the proxy itself to stay loopback-only.)

1. **Cert:** DNS-01 for `imap.skyphusion.org` (as 3a.1).
2. **Listener:** native 993 or stunnel; restart.
   - **Smoke:** `ss -tlnp | grep :993`; local `openssl s_client -connect 127.0.0.1:993`
     presents the cert; an IMAPS login + SELECT INBOX works.
3. **Firewall:** `ufw allow proto tcp to any port 993 comment 'postern imaps'`.
   - **Smoke:** laptop `nc -vz <dischord-public-ip> 993` connects.
4. **DNS (last):** grey-cloud A `imap.skyphusion.org` -> dischord public IP.
   - **Smoke (artifact):** from the laptop, a real mail client (Thunderbird:
     IMAPS imap.skyphusion.org:993 + SMTP smtp.skyphusion.org:587, one Authentik
     login for both) fetches INBOX and sends a message.
   - **Rollback:** remove A record; close ufw 993; revert listener to loopback.

### Auth backend at go-live

The doors deploy in **PAM mode** (`AUTH_BACKEND=system` / IMAP `pam` mode,
`AUTH_SYSTEM_PAM_SERVICE=postern`): the unified Authentik login over the existing
nslcd chain, **no IdP change**. Phase 4 (direct-LDAP) is NOT required for go-live.

---

## Phase 4 -- OPTIONAL: off-fleet direct-LDAP (only if PAM is ever insufficient)

Not needed for the fleet go-live (PAM covers it). Do this only if a non-fleet /
no-nslcd consumer must bind the directory directly. It is an **IdP mutation** ->
supervised, with a rollback ready.

1. **Scoped bind account `cn=postern-mail-ro`** (read-only, member of
   `authentik Read-only`, NEVER `authentik Admins`). Add as an additive Authentik
   blueprint (mirror `system/stacks/dischord/auth/blueprints/ldap-svc.yaml`: set
   only password via `!Env POSTERN_LDAP_BIND_PASSWORD`, no `groups` clobber). Seed
   `POSTERN_LDAP_BIND_PASSWORD` in crew-secrets (PR, age-encrypted).
   - **Smoke:** `ldapsearch -x -H ldap://10.1.1.2:389 -D
     cn=postern-mail-ro,ou=users,dc=ldap,dc=goauthentik,dc=io -y /root/.pw
     -b ou=users,dc=ldap,dc=goauthentik,dc=io
     "(&(mail=conrad@skyphusion.org)(memberOf=cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io))" mail`
     returns exactly one entry with `mail`. Confirm the account CANNOT write
     (read-only group).
   - **Rollback:** remove the blueprint entry + redeploy the auth worker; revoke
     the crew-secrets value.

2. **636 + TLS on the LDAP provider.** Issue an internal cert (SAN
   `dischord.internal` + `10.1.1.2`), bind a certificate-keypair to the Authentik
   LDAP provider, publish 636 (compose port map + provider config in
   `system/stacks/dischord/auth/`). 
   - **Smoke:** `ldapsearch -x -H ldaps://dischord.internal:636 ...` (as above)
     succeeds over TLS; `openssl s_client -connect dischord.internal:636` shows the
     cert chain.
   - **Rollback:** remove the 636 port map + provider cert binding; clients fall
     back to PAM (which never depended on this).

3. Point the relevant consumer at `LDAP_URL=ldaps://dischord.internal:636` and the
   `LDAP_*` knobs from `docs/AUTH-CONTRACT.md` section 5c.

---

## Final verification (whole system, from outside)

- [ ] External email to `@skyphusion.org` lands in the store (Phase 1.3).
- [ ] Outbound/relay send works (Phase 1.4).
- [ ] From the laptop: Thunderbird with ONE Authentik login does both IMAPS fetch
      and 587 submission (Phases 3a/3b).
- [ ] A non-`mail-users` account is rejected on both doors.
- [ ] `gatus`/monitoring green for the new endpoints.
- [ ] Only now: close the known-good safety sessions.

## Master rollback order (if the window must be aborted)

Reverse of go-live, doors first then email routing (so live email is restored last
and most carefully):

1. Remove DNS A records (`smtp.`/`imap.`), close ufw 587/993, revert listeners to
   loopback. (Doors back to private.)
2. If Phase 4 was touched: remove 636 + the scoped account.
3. Repoint the doors' `POSTERN_API_URL`/`POSTERN_SEND_URL` back if needed.
4. Email routing + relay: only if Phase 1 itself is being reverted, repoint routing
   rules + `EMAIL_WORKER_URL` back to the old workers (still present until 1.6).

Live inbound email is the most sensitive surface; its switch (1.3) is a single
reversible routing change and the old worker stays deployed until a soak passes.
