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
- [ ] Exposure topology is DECIDED: **Option B, lagwagon-front** (Phase 2). The
      only open window decisions left are the TLS model (B1 end-to-end vs B2
      edge-terminate) and native-IMAPS vs stunnel for 993 (Phase 3b).
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

## Phase 2 -- exposure topology: Option B, lagwagon-front (CHOSEN)

Conrad's decision: **Option B.** Public 587/993 terminate/forward at **lagwagon**
(the cloud edge / NAT gateway), forwarded over the private mesh to dischord's doors.
**No fleet box ever binds a public port** -- dischord stays dark, reachable only over
the private estate. That isolation is the entire point of B.

```
mail client (internet)
      |  587 / 993 (TLS)
      v
  lagwagon   (PUBLIC edge; userspace TCP forwarder, strictly additive)
      |  private mesh hop (lagwagon -> dischord VLAN IP 10.1.1.2)
      v
  dischord   doors: postern-submission (587/1587) + postern-imap (993/1143)
      |  HTTPS(443) to the worker /api/*  (unchanged)
      v
  postern.skyphusion.org
```

### lagwagon guardrails (READ FIRST -- lagwagon is the SPOF for ALL off-fleet access)

- lagwagon's `ip_forward` + the POSTROUTING **MASQ** rule + the SSH/bastion path ARE
  the entire laptop->fleet lifeline. **NEVER touch them.** The mail edge is a
  **userspace TCP forwarder** (accept on the public port, open a NEW connection to
  dischord) -- it needs NO kernel forwarding, NO DNAT, NO change to the MASQ/NAT
  rules. If a step would edit `net.ipv4.ip_forward` or a POSTROUTING/DNAT rule, STOP:
  you are doing it wrong.
- Strictly **additive**: a new userspace listener + a new ufw allow on the public
  iface + (optionally) a new fail2ban jail. Nothing existing is modified.
- lagwagon is **most-careful, vKVM-open, dead-LAST**. Bring the dischord side up and
  verify it over the mesh BEFORE adding any public surface on lagwagon. Keep the
  Hetzner vKVM console open the whole time.

### Option A (dischord-direct) -- NOT chosen, recorded for completeness

Binding 587/993 on dischord's public interface (grey-cloud A record -> dischord
public IP) is simpler but puts the first public port on a fleet box. Conrad chose B
to keep fleet boxes dark. If B is ever abandoned, A is the fallback: cert + listener
+ ufw + DNS all on dischord, same per-step shape (cert -> listener -> ufw -> DNS ->
external smoke), the doors binding 0.0.0.0 instead of the VLAN IP.

NB: Hetzner blocks OUTBOUND 25/465/587 on the fleet, but these are INBOUND listeners
(clients connect IN to lagwagon), which is unaffected. The send hand-off to the
worker is HTTPS(443), which is open.

---

## Phase 3 -- stand up the lagwagon-front mail edge (B)

Order: bring up dischord's doors on the PRIVATE interface, verify lagwagon reaches
them over the mesh, design the fail2ban scoping, THEN add public surface on lagwagon
(dead-last), THEN DNS.

### 3a. dischord doors bind the PRIVATE mesh interface (no public exposure)

The doors must be reachable from lagwagon over the private estate, NOT from the
internet. Bind them to dischord's VLAN IP (10.1.1.2), never 0.0.0.0:

- postern-submission: `SUBMISSION_LISTENERS=10.1.1.2:587:starttls` (or keep the
  loopback 1587 and have the forwarder target 1587 -- either works).
- postern-imap: `POSTERN_IMAP_HOST=10.1.1.2`, `POSTERN_IMAP_PORT=993` (or keep 1143).
- dischord ufw: allow these ports **FROM the lagwagon mesh source ONLY** (the private
  range), NOT from any. **No public change on dischord.**

- **Smoke:** from lagwagon, `nc -vz 10.1.1.2 587` and `:993` connect; from a public
  host they do NOT.
- **Rollback:** revert the doors to loopback (127.0.0.1:1587/1143), drop the dischord
  ufw allow.

### 3b. TLS model -- Conrad's call at the window (write both)

Both models keep the public listener on lagwagon and the door on dischord; they
differ in WHERE TLS terminates, and therefore WHAT lagwagon can see.

**B1. End-to-end passthrough (lagwagon = dumb TCP pipe).** lagwagon forwards raw TCP
587/993 to dischord; **dischord holds the cert and terminates TLS**. lagwagon sees
only ciphertext. Preserves 587 STARTTLS and native IMAPS unchanged. Forwarder =
HAProxy (TCP mode) or `socat`. Cert (`smtp.`/`imap.skyphusion.org`) provisioned on
dischord via DNS-01 (a TXT record; no port/exposure needed).
  - Pro: TLS end-to-end; the edge cannot read mail. Con: the cert lives on a fleet
    box; lagwagon has no auth visibility (drives the fail2ban design, 3d).

**B2. Edge-terminate (lagwagon terminates TLS).** lagwagon terminates **implicit
TLS** (465 for SMTP, 993 for IMAP) with **the cert on lagwagon** (stunnel or HAProxy)
and forwards PLAINTEXT over the trusted mesh to the dischord door.
  - Pro: cert + renewal at the edge; no fleet box holds it. Con: plaintext mail on
    the mesh hop (trusted private estate, but not end-to-end); STARTTLS 587 does not
    edge-terminate cleanly, so this model uses implicit-TLS ports (465/993).

Sub-decision (wherever TLS terminates): **native IMAPS vs stunnel for 993** -- either
the door serves IMAPS natively with the cert, or stunnel fronts the loopback proxy.
Write both; Conrad picks.

Recommendation (noted, NOT baked): **B1 end-to-end + native door TLS** keeps mail
unreadable by the edge and preserves 587 STARTTLS; **B2** simplifies cert ops at the
cost of plaintext on the mesh. Conrad's call at the window.

### 3c. lagwagon edge forwarder (userspace, additive; NEVER ip_forward/MASQ)

Install the chosen userspace forwarder on lagwagon (HAProxy TCP mode or `socat` for
B1; stunnel for B2), listening on the PUBLIC interface (`:587`/`:993` for B1,
`:465`/`:993` for B2), target = dischord `10.1.1.2:<door>`. Run it as a hardened
systemd unit (DynamicUser where the tool allows; mirror the door units). It is a
userspace process: it does NOT and MUST NOT touch `ip_forward`, DNAT, or the
POSTROUTING MASQ rule.

- **Smoke:** with the forwarder up but the public ufw still CLOSED, from lagwagon
  itself `nc -vz 127.0.0.1 587`/`:993` reaches the forwarder -> dischord door (a
  local test on lagwagon; the public iface is still firewalled).
- **Rollback:** `systemctl disable --now` the forwarder; remove its unit. Nothing
  else changes.

### 3d. fail2ban (lagwagon-ONLY) -- scope it so it can NEVER cause a fleet lockout

fail2ban runs ONLY on lagwagon (a fleet-box jail would ban the masq source 10.1.0.3
= total lockout) and today jails SSH. Public 587/993 adds brute-force surface.
Design the mail protection ISOLATED from the SSH jail and unable to ban the
internal/masq source:

- **ignoreip MUST include** `127.0.0.1/8 10.1.0.3 10.1.0.0/16 10.1.1.0/24` (+ the
  mesh range). This guarantees no jail (SSH or mail) ever bans the masq source or a
  fleet box. Add it to the mail jail AND confirm it on the existing SSH jail.
- A **separate** `postern-mail` jail: own filter, own `port = 587,993`, own
  `f2b-postern-mail` chain. NEVER edit the SSH jail. The action is fail2ban's
  standard multiport iptables action scoped to the mail ports on the PUBLIC interface
  only; it inserts into its own chain, NOT POSTROUTING, so MASQ/forward are untouched.
- **Auth-failure signal lives on dischord** (the door logs 535/LOGIN failures after
  TLS terminates), but the jail must run on lagwagon. Two tiers:
  - **Baseline (pure lagwagon-local):** a connection-RATE jail on the public mail
    ports (port-flood filter) -- catches floods without reading encrypted auth.
  - **Recommended enhancement:** forward dischord's postern door auth-fail log lines
    to lagwagon over syslog; the lagwagon `postern-mail` jail matches THOSE and bans
    the real public client IP at the edge. Keeps fail2ban lagwagon-only AND gets
    auth-based banning. (Caveat: the forwarded log must carry the real client IP; if
    the forwarder masks it to the lagwagon source, fall back to the rate tier so a
    ban can never land on 10.1.0.3 -- which ignoreip blocks regardless.)
- **Smoke:** trip the filter from a throwaway public IP -> it bans on the public
  iface; confirm `fail2ban-client status postern-mail` shows the ban, confirm
  10.1.0.3 and a fleet box are STILL reachable (ignoreip working), confirm the SSH
  jail is untouched and the laptop->fleet path still works.
- **Rollback:** `fail2ban-client stop` the postern-mail jail; remove its jail.d
  file. The SSH jail + ignoreip stay.

### 3e. Public DNS + lagwagon ufw (DEAD-LAST)

Only after 3a-3d verify over the mesh:

- **ufw on lagwagon:** open 587/993 (or 465/993 for B2) on the PUBLIC interface,
  scoped as tightly as the audience allows. lagwagon is most-careful; vKVM open.
  ```bash
  ufw allow proto tcp to any port 587 comment 'postern submission (edge)'
  ufw allow proto tcp to any port 993 comment 'postern imaps (edge)'
  ```
- **DNS (last):** grey-cloud A records `smtp.skyphusion.org` + `imap.skyphusion.org`
  -> **lagwagon's PUBLIC IP** (NOT dischord). CF does not proxy SMTP/IMAP except via
  Spectrum, so these are grey-cloud (DNS-only). IaC via the CF DNS API, not the dash.
- **Smoke (the go-live artifact):** from the laptop (off-fleet), a real mail client
  (Thunderbird: IMAPS `imap.skyphusion.org:993` + submission `smtp.skyphusion.org:587`,
  ONE Authentik login for BOTH doors) fetches INBOX and sends a message. A
  non-`mail-users` account / bad password / `From != identity` is rejected at the
  dischord door.
- **Rollback:** remove the A records; close lagwagon public ufw 587/993. The
  forwarder + dischord doors can stay (private) or be torn down per 3c/3a.

### Auth backend at go-live

Unchanged: the doors run **PAM mode** (`AUTH_BACKEND=system` / IMAP `pam` mode,
`AUTH_SYSTEM_PAM_SERVICE=postern`) -- the unified Authentik login over the existing
nslcd chain, **no IdP change**. Phase 4 (direct-LDAP) is NOT required for go-live.

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

Reverse of go-live: the EDGE (lagwagon) comes down first, then the dischord doors,
then live-email routing LAST (so live email is restored most carefully):

1. **lagwagon edge first:** remove the DNS A records (`smtp.`/`imap.`), close the
   lagwagon public ufw 587/993, `systemctl disable --now` the forwarder, stop the
   `postern-mail` fail2ban jail. lagwagon is now back to its pre-go-live state --
   ip_forward / MASQ / SSH jail / ignoreip all untouched throughout.
2. **dischord doors:** revert the doors to loopback (127.0.0.1:1587/1143), drop the
   dischord mesh-scoped ufw allow. (Doors back to private.)
3. If Phase 4 was touched: remove 636 + the scoped `cn=postern-mail-ro` account.
4. If the doors' origin was moved: repoint `POSTERN_API_URL` / `POSTERN_SEND_URL`
   back.
5. **Live email LAST:** only if Phase 1 itself is being reverted, repoint the Email
   Routing rules + `EMAIL_WORKER_URL` back to the old workers (still present until 1.6).

Live inbound email is the most sensitive surface; its switch (1.3) is a single
reversible routing change and the old worker stays deployed until a soak passes.
