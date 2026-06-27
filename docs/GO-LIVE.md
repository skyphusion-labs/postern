# Postern go-live runbook (SUPERVISED, Conrad-executed)

Status: **runbook only. Every step here is GATED and waits for Conrad's supervised
window.** Nothing in this file has been run. It is the turnkey sequence to flip
Postern from "loopback/mesh-only, built + tested" to "publicly reachable mail," in
the order that does not break live email or expose a half-built endpoint.

Read first: `docs/AUTH-CONTRACT.md` (the auth bindings), `imap/DEPLOY.md`,
`relay/SUBMISSION-DEPLOY.md` (the two doors, already deployed loopback-only), and
skyphusion-labs/postern#74 (the deploy drift this fixes).

**Phase 0 (below) is the PREREQUISITE hardened-set mesh deploy** -- it ships the
current box binaries, the per-function tokens, and the 0005 store rebuild over
loopback/VLAN, with NO public exposure. It runs and is signed off BEFORE the public
edge (Phases 1-4).

## Operating rules for the window (aviation discipline)

- **CARDINAL FLEET INGRESS INVARIANT (period, no exceptions).** ALL external
  ingress to the fleet arrives via EITHER a cloudflared tunnel OR the bastion
  (lagwagon). **No fleet box ever takes a direct connection from the outside
  world or binds a public port.** Raw-TCP services (the 587/993 mail doors) use
  the bastion (Phase 2); HTTP surfaces (e.g. webmail) use a cloudflared tunnel.
  This governs every externally-reachable service, not just Postern.
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
- [ ] Topology is FIXED by the fleet ingress invariant (Phase 2): external mail
      ingress comes via the bastion (lagwagon); no fleet box binds a public port.
      The only open window decisions are the TLS termination point (end-to-end vs
      edge) and native-IMAPS vs stunnel for 993 (Phase 3b).
- [ ] A non-fleet host (the laptop) ready for external smoke checks.

---

## Phase 0 -- Hardened-set mesh deploy (PREREQUISITE; mesh-internal, NO public exposure)

Status: **runbook only, GATED.** This phase ships the hardened box services + the
0005 store rebuild + the per-function tokens to dischord, all over loopback/VLAN.
It precedes the public edge (Phases 1-4) and touches NO public surface: no DNS, no
lagwagon, no ufw, no fleet-ingress change. It is the "get the doors current and
least-privilege, offline" pass so the exposure flip later is purely a networking
step.

**Gates (all must hold before starting):**
- [ ] Conrad's supervised window open (this restarts live services + rebuilds the
      live store).
- [ ] #106 (TLS 1.2+ floor on the Python IMAPS 993 listener) MERGED. It changes the
      proxy's TLS posture, so it must be in the binary we deploy here. (Open as of
      writing -- HARD prerequisite for step 0.4.)
- [ ] #105 (587 AUTH + 993 LOGIN brute-force throttle) merged (code is in; this phase
      configures its knobs).
- [ ] #118 (migration 0005) reviewed and ready, NOT yet merged (it merges at the END
      of step 0.5, after the offline apply).
- [ ] Known-good root/console session held on dischord (LDAP-backed SSH; do not risk
      lockout mid-restart). Hetzner vKVM reachable.
- [ ] A fresh backup target for the D1 store (step 0.5 takes the authoritative one).

**Build provenance:** every box binary is built from the SAME merged `main` commit
(record the SHA in the window log). Relay (`relay/`) and IMAP proxy (`imap/`) carry:
`LDAP_TIMEOUT` (#88, default 10s, both doors), attachments (relay #89/#92), the #105
throttle, and the #106 TLS floor (proxy). Verify locally first: `cd relay && go build
./... && go vet ./... && go test ./...`; `cd imap && python -m mypy && python -m
twisted.trial posternimap.tests`.

### 0.1 Pre-flight snapshot (record current live state; change nothing)

Capture the before-state so every later step has a known-good baseline + rollback ref.

```bash
# On dischord (read-only):
systemctl status skyphusion-email-relay postern-submission postern-imap --no-pager
ss -ltnp | grep -E ':2525|:2587|:1587|:1143|:587|:993'   # current binds
# Record each EnvironmentFile's current values (root, 0600):
for f in /etc/skyphusion-email-relay.env /etc/postern-submission.env /etc/postern-imap.env; do
  echo "== $f =="; sudo grep -vE '^\s*#|^\s*$' "$f"
done
```

- **Smoke:** all three units `active (running)`; binds match the recorded baseline
  (relay intake `127.0.0.1:2525` + the stale `172.17.0.1:2525` to be removed in 0.2;
  submission `10.1.1.2:587` + loopback intake `127.0.0.1:2587`; imap proxy `:1143`).
- **Rollback:** none (read-only).

### 0.2 SMTP_LISTEN loopback cleanup -- REQUIRED, and it gates the relay restart

The live relay still binds `172.17.0.1:2525` (docker0 bridge) alongside loopback. The
new relay binary ENFORCES loopback-only intake (#93 / #104 audit F4): it REFUSES to
start if any intake bind is non-loopback. So this one-line edit is NOT optional and
MUST land BEFORE the new binary restarts, or the relay fails to boot.

Verified safe (no caller): the `172.17.0.1:2525` bind has had zero client sessions
across the full relay journal retention; the only intake traffic is a loopback health
probe. (See the #116 mesh verify.)

```bash
# /etc/skyphusion-email-relay.env: drop the docker-bridge bind, keep loopback only.
#   SMTP_LISTEN=172.17.0.1:2525,127.0.0.1:2525   ->   SMTP_LISTEN=127.0.0.1:2525
sudo sed -i 's#^SMTP_LISTEN=.*#SMTP_LISTEN=127.0.0.1:2525#' /etc/skyphusion-email-relay.env
sudo grep '^SMTP_LISTEN=' /etc/skyphusion-email-relay.env   # confirm == 127.0.0.1:2525
```

- **Smoke:** the value reads exactly `127.0.0.1:2525`.
- **Rollback:** restore the prior `SMTP_LISTEN=172.17.0.1:2525,127.0.0.1:2525` line.
- **NB:** do not restart the relay yet on the OLD binary -- the old binary is fine with
  loopback-only too, but the restart belongs to 0.3 so binary + config flip together.

### 0.3 Deploy the box binaries + restart (one service at a time, verify between)

Install the freshly built binaries, then restart each unit and verify before the next.
Each unit keeps its existing EnvironmentFile (tokens are narrowed later in 0.4; running
on the existing `both` token in between is a SAFE intermediate state).

```bash
# Install (mirror the existing install path; built from the recorded main SHA):
sudo install -m0755 relay/dist/skyphusion-email-relay /usr/local/bin/skyphusion-email-relay
sudo install -m0755 relay/dist/postern-submission     /usr/local/bin/postern-submission   # -tags pam build
sudo /opt/postern-imap/.venv/bin/pip install --upgrade '/opt/postern-imap[pam]'            # proxy + pam extra

# Restart in dependency-safe order, verifying each:
sudo systemctl restart skyphusion-email-relay && systemctl status skyphusion-email-relay --no-pager
sudo systemctl restart postern-submission     && systemctl status postern-submission --no-pager
sudo systemctl restart postern-imap           && systemctl status postern-imap --no-pager
```

- **Smoke (per unit):**
  - relay: `active`, startup log shows intake on `127.0.0.1:2525` ONLY (no
    `172.17.0.1`, no `WARNING: SMTP_LISTEN ... intake DISABLED`); loopback
    `swaks --server 127.0.0.1:2525 --to test@skyphusion.org --body t` is accepted.
  - postern-submission: `active`; loopback 587 STARTTLS+AUTH still logs in
    (SUBMISSION-DEPLOY.md step 6); a bad password / `From != identity` is rejected;
    the #105 throttle trips after N rapid bad AUTHs.
  - postern-imap: `active`; loopback `1143` (or 993) IMAP login + SELECT INBOX
    (imap/DEPLOY.md step 4); LDAP/PAM bind respects `LDAP_TIMEOUT`; #106 TLS floor:
    `openssl s_client -connect <door> -tls1_1` is REFUSED, `-tls1_2` succeeds.
- **Rollback:** reinstall the prior binary from `/usr/local/bin/*.prev` (keep a copy
  before `install`), restore the EnvironmentFile, `systemctl restart`. One unit at a
  time, so a failure is isolated to that door.

### 0.4 Provision the #85 per-function scoped tokens (mint -> worker -> crew-secrets -> EnvironmentFiles)

The worker classifies a presented bearer by which secret VALUE it matches:
`POSTERN_API_TOKEN_READ` = read door only, `POSTERN_API_TOKEN_SEND` = send door only,
`POSTERN_API_TOKEN` = `both` (read+send+credential-admin). Goal: the proxy + MCP hold
the READ value (physically cannot send), the 587 submission holds the SEND value.

Crew mints the token VALUES (opaque random bearers; no Conrad ask). Do NOT write a
plaintext value into any tracked file; store in crew-secrets age-encrypted, labelled
by function, via PR (not direct push).

```bash
# 1. Mint two opaque values (e.g. `openssl rand -hex 32` each): READVAL, SENDVAL.
# 2. Set them worker-side (skyphusion-email-inbound):
cd inbound
printf '%s' "$READVAL" | npx wrangler secret put POSTERN_API_TOKEN_READ -c <real-config>
printf '%s' "$SENDVAL" | npx wrangler secret put POSTERN_API_TOKEN_SEND -c <real-config>
# 3. Store in crew-secrets (age, PR): POSTERN_API_TOKEN_READ + POSTERN_API_TOKEN_SEND.
# 4. Wire the consumer EnvironmentFiles (the proxy presents whatever VALUE it holds;
#    the worker classifies it -- so the proxy's var name stays POSTERN_API_TOKEN):
#    /etc/postern-imap.env        -> POSTERN_API_TOKEN=<READVAL>     (read door)
#    /etc/postern-submission.env  -> POSTERN_SEND_TOKEN=<SENDVAL>    (send door)
#    MCP server env               -> POSTERN_API_TOKEN=<READVAL>     (read-only)
sudo systemctl restart postern-imap postern-submission   # pick up narrowed tokens
```

- **Smoke (scope enforcement is the point):**
  - proxy with READ value: IMAP fetch still works; a direct `POST /api/send` with that
    same value returns **403** (scope), not 200. Same check for the MCP read token.
  - 587 with SEND value: a submission send succeeds; a `GET /api/messages` with the
    SEND value returns **403**.
  - an unknown value -> **401**.
- **TOKEN CUSTODY -- RATIFIED (Mackaye 2026-06-27):** the `both` `POSTERN_API_TOKEN`
  stays set worker-side and its value lives in crew-secrets **minter-tier ONLY** -- out
  of EVERY box EnvironmentFile. Each box holds ONLY its scoped token (read -> imap proxy
  + the Postern MCP; send -> 587 submission). The `both` token is used ONLY for admin
  ops (smtp-credential mint, the reindex route) by Mackaye/crew, NEVER projected onto a
  box. This is the per-function-keys / least-privilege end state -- locked, not a window
  decision.
- **Rollback:** restore each EnvironmentFile to `POSTERN_API_TOKEN` / `POSTERN_SEND_TOKEN`
  = the prior `both` value; `systemctl restart`. The worker secrets can stay (additive).

### 0.5 Migration 0005 (messages.id AUTOINCREMENT) -- OFFLINE apply on the live store

A core-table rebuild on the live D1 (`skyphusion-mail`). #118 is held `DO NOT MERGE`
precisely because `deploy.yml` would otherwise auto-apply it online with no backup.
Apply order is fixed (the migration header is authoritative):

```text
back up  ->  quiesce writers  ->  apply 0005 offline  ->  verify  ->  seed d1_migrations  ->  merge #118
```

```bash
# 1. BACK UP first (authoritative copy of skyphusion-mail before any write):
npx wrangler d1 export skyphusion-mail --remote --output skyphusion-mail.pre0005.sql -c <real-config>
# 2. QUIESCE writers (see decision below) so the rebuild has NO concurrent INSERT.
# 3. APPLY offline (this single migration only, not the whole apply path):
npx wrangler d1 execute skyphusion-mail --remote --file inbound/migrations/0005_messages_id_autoincrement.sql -c <real-config>
# 4. VERIFY (all three must pass):
#    - row count + id set preserved 1:1 vs the backup (no id changed);
#    - messages_fts integrity intact (external-content keyed on messages.id, NOT rebuilt):
#        SELECT * FROM messages_fts WHERE messages_fts MATCH 'the' LIMIT 1;  -- returns
#        INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');   -- no error
#    - AUTOINCREMENT high-water seeded: SELECT seq FROM sqlite_sequence WHERE name='messages';
#      (>= current MAX(id)); a fresh insert gets MAX(id)+1, never a reused id.
# 5. SEED the migration ledger so the next deploy no-ops (same baseline pattern as 0001-0003):
npx wrangler d1 execute skyphusion-mail --remote -c <real-config> \
  --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0005_messages_id_autoincrement.sql', CURRENT_TIMESTAMP);"
# 6. UN-quiesce writers. THEN merge #118 (so the next CI deploy sees 0005 already applied).
```

- **Smoke:** `wrangler d1 migrations list skyphusion-mail --remote` shows 0005 applied;
  a new inbound message lands with `id = prior_max+1`; IMAP UID = that id, stable under
  a constant `UIDVALIDITY`; existing messages still searchable (FTS).
- **DECISION TO FLAG (Conrad): how to quiesce inbound writers for the apply window.**
  The store is fed by CF Email Routing -> the worker (writes can arrive anytime). The
  rebuild needs NO concurrent writer. Options: (a) temporarily disable the catch-all /
  point Email Routing at a hold rule for the (short) apply window -- inbound mail queues
  at the sending MX and redelivers after; (b) a brief maintenance window accepting that
  any mail arriving mid-rebuild is the only risk. Recommend (a): clean, no lost mail,
  fully reversible. Strummer wires the routing pause/restore; Conrad approves the window.
- **Rollback:** if any verify fails, RESTORE from `skyphusion-mail.pre0005.sql` (the
  step-1 backup), do NOT seed d1_migrations, do NOT merge #118. The store returns to its
  pre-rebuild state; the held PR stays held.

### 0.6 Enable Joan's Stage-1 measurement (IMAP proxy)

With the proxy on the read-scoped token and 0005 applied (stable UIDs), turn on Joan's
Stage-1 measurement instrumentation per her proxy measurement doc. This is additive
(measurement only; no behaviour change to the read path).

- **Smoke:** Stage-1 metrics populate for a loopback IMAP session (fetch/SELECT) with
  no errors in the proxy log; UID stability holds across reconnect.
- **Rollback:** disable the Stage-1 flag; the proxy reverts to plain read-proxy.
- **FLAG:** Stage-1's exact enable switch + metric sink are Joan's lane -- confirm the
  toggle name + destination with Joan before the window; this step is the hook, not the
  spec.

### Phase 0 exit criteria (all green before Phase 1)

- [ ] Three doors `active`, on the recorded main SHA, loopback/VLAN only (no public bind).
- [ ] Relay intake loopback-only (`172.17.0.1` gone); F4 guard satisfied.
- [ ] Proxy + MCP on the READ token, 587 on the SEND token; cross-scope calls 403.
- [ ] 0005 applied + verified (ids 1:1, FTS intact, high-water seeded); #118 merged.
- [ ] `LDAP_TIMEOUT`, #105 throttle, #106 TLS floor all live and smoke-verified.
- [ ] Joan's Stage-1 measuring. Known-good dischord session still open.

---

## Phase 1 -- #74: custom domain LIVE; retire the legacy send worker (cosmetic rename DEFERRED)

**Reconciled to live reality (2026-06-27).** The user-facing goal of #74 -- a stable
`https://postern.skyphusion.org` origin for both doors' store-read / send hand-off --
is **DONE**. The inbound/store worker is live as `skyphusion-email-inbound` with the
custom domain `postern.skyphusion.org` attached and serving (verified during #116);
there is NO `postern`-named worker. Creating one is **not worth doing**: a Cloudflare
Worker cannot be renamed in place, so "renaming" means recreate-and-migrate (re-attach
the custom domain, re-point the Email Routing catch-all, re-`wrangler secret put` the
API tokens, re-bind D1/R2/Vectorize/AI/send_email) on Conrad's LIVE mail store, for a
PURELY cosmetic gain -- the domain works regardless of the worker's internal name.

So 1.1-1.3 are **DONE / moot**, kept only as the historical record + rollback ref. The
remaining REAL work in this phase is OUTBOUND: repoint the relay off the legacy
`skyphusion-email` send worker onto `postern-send`, then retire the legacy workers
(1.4 + 1.6). The repo template `inbound/wrangler.jsonc` still says name=`postern`;
treat it as the public template's example name (operators set their own) or reconcile
it to `skyphusion-email-inbound` -- a docs-only follow-up, no live impact.

### 1.1 Inbound/store worker -- DONE (live as `skyphusion-email-inbound`)

Live and serving; custom domain attached. The cosmetic rename to `postern` is DEFERRED
(not worth a live recreation, see above). No action.

### 1.2 Custom domain `postern.skyphusion.org` -- DONE

Attached to `skyphusion-email-inbound` (orange-cloud, cert provisioned): `/health` 200,
`/api/*` 401/403 without a token. No action.

### 1.3 Email Routing -- DONE (already routes to the live worker)

The catch-all already delivers `@skyphusion.org` to `skyphusion-email-inbound` (the
inbound copy in the #116 test arrived this way). No repoint is needed because the
worker is NOT being renamed. If the cosmetic rename were ever done, THIS would be the
downtime-critical switch -- deferred with the rename.

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

## Phase 2 -- the mail edge: bastion-front (per the fleet ingress invariant)

Per the cardinal invariant above, external mail ingress comes in via the bastion.
Public 587/993 terminate/forward at **lagwagon**, forwarded over the private mesh to
dischord's doors. **No fleet box ever binds a public port** -- dischord stays dark,
reachable only over the private estate. This is not a choice between alternatives;
binding 587/993 (or any public port) directly on a fleet box is FORBIDDEN.

```
mail client (internet)
      |  587 / 993 (TLS)
      v
  lagwagon   (bastion edge; userspace TCP forwarder, strictly additive)
      |  private mesh hop (lagwagon -> dischord VLAN IP 10.1.1.2)
      v
  dischord   doors: postern-submission (587/1587) + postern-imap (993/1143)
      |  HTTPS(443) to the worker /api/*  (unchanged)
      v
  postern.skyphusion.org
```

HTTP surfaces are different: if the **webmail** (or any other HTTP UI) is ever
exposed, the sanctioned pattern is a **cloudflared tunnel** to it, never a fleet-box
public port and never the raw-TCP bastion forwarder. That is out of scope for this
mail go-live; noted here so the invariant is not violated when webmail exposure
comes up.

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

NB: Hetzner blocks OUTBOUND 25/465/587 on the fleet, but these are INBOUND listeners
(clients connect IN to lagwagon), which is unaffected. The send hand-off to the
worker is HTTPS(443), which is open.

---

## Phase 3 -- stand up the bastion-front mail edge

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

**TLS-E2E. End-to-end passthrough (lagwagon = dumb TCP pipe).** lagwagon forwards raw TCP
587/993 to dischord; **dischord holds the cert and terminates TLS**. lagwagon sees
only ciphertext. Preserves 587 STARTTLS and native IMAPS unchanged. Forwarder =
HAProxy (TCP mode) or `socat`. Cert (`smtp.`/`imap.skyphusion.org`) provisioned on
dischord via DNS-01 (a TXT record; no port/exposure needed).
  - Pro: TLS end-to-end; the edge cannot read mail. Con: the cert lives on a fleet
    box; lagwagon has no auth visibility (drives the fail2ban design, 3d).

**TLS-EDGE. Edge-terminate (lagwagon terminates TLS).** lagwagon terminates **implicit
TLS** (465 for SMTP, 993 for IMAP) with **the cert on lagwagon** (stunnel or HAProxy)
and forwards PLAINTEXT over the trusted mesh to the dischord door.
  - Pro: cert + renewal at the edge; no fleet box holds it. Con: plaintext mail on
    the mesh hop (trusted private estate, but not end-to-end); STARTTLS 587 does not
    edge-terminate cleanly, so this model uses implicit-TLS ports (465/993).

Sub-decision (wherever TLS terminates): **native IMAPS vs stunnel for 993** -- either
the door serves IMAPS natively with the cert, or stunnel fronts the loopback proxy.
Write both; Conrad picks.

Recommendation (noted, NOT baked): **TLS-E2E end-to-end + native door TLS** keeps mail
unreadable by the edge and preserves 587 STARTTLS; **TLS-EDGE** simplifies cert ops at the
cost of plaintext on the mesh. Conrad's call at the window.

### 3c. lagwagon edge forwarder (userspace, additive; NEVER ip_forward/MASQ)

Install the chosen userspace forwarder on lagwagon (HAProxy TCP mode or `socat` for
TLS-E2E; stunnel for TLS-EDGE), listening on the PUBLIC interface (`:587`/`:993` for TLS-E2E,
`:465`/`:993` for TLS-EDGE), target = dischord `10.1.1.2:<door>`. Run it as a hardened
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

- **ufw on lagwagon:** open 587/993 (or 465/993 for TLS-EDGE) on the PUBLIC interface,
  scoped as tightly as the audience allows. lagwagon is most-careful; vKVM open.
  ```bash
  ufw allow proto tcp to any port 587 comment 'postern submission (edge)'
  ufw allow proto tcp to any port 993 comment 'postern imaps (edge)'
  ```
- **DNS (last):** grey-cloud A records `smtp.skyphusion.org` + `imap.skyphusion.org`
  -> **lagwagon's PUBLIC IP** (NOT dischord). CF does not proxy SMTP/IMAP except via
  Spectrum, so these are grey-cloud (DNS-only). IaC via the CF DNS API, not the dash.
- **Autodiscovery SRV records (RFC 6186), created at THIS step:** let mail clients
  auto-configure from just `user@skyphusion.org`. SRV records cannot be proxied
  (CF proxies only A/AAAA/CNAME), so they are DNS-only by nature. **The targets are
  the bastion mail edge host names (the A records above, -> lagwagon public IP),
  NEVER a fleet box** -- this is the cardinal ingress invariant applied to
  autodiscovery. Records (`_service._proto name TTL IN SRV prio weight port target`):
  ```
  _submission._tcp.skyphusion.org.  300  IN  SRV  0 1 587  smtp.skyphusion.org.
  _imaps._tcp.skyphusion.org.        300  IN  SRV  0 1 993  imap.skyphusion.org.
  _imap._tcp.skyphusion.org.         300  IN  SRV  0 0 0    .
  ```
  - **`_submission` (587)** is the STARTTLS submission door (RFC 6186). **NO 465 /
    `_submissions` record:** Hetzner blocks 465 and submission is 587-only
    (postern-mail-access-architecture).
  - **`_imap` vs `_imaps` -- FLAG FOR CONRAD (tied to the still-open 993 TLS
    decision).** RFC 6186: `_imaps._tcp` = implicit-TLS on 993; `_imap._tcp` =
    plain/STARTTLS on 143. Our 993 door is implicit-TLS in BOTH 993 options (native
    IMAPS or stunnel), so the RFC-correct positive record is **`_imaps._tcp ... 993`**
    regardless of which 993 TLS path is chosen. We do NOT offer plaintext/143, so the
    `_imap._tcp ... 0 0 0 .` line is the RFC negative ("service not available"),
    which steers clients off plaintext IMAP. Conrad asked for "_imap"; this implements
    it RFC-correctly as `_imaps` positive + `_imap` negative. If Conrad instead wants a
    literal `_imap._tcp` positive, that would mean offering STARTTLS-on-143, which is a
    separate door we have not built -- confirm before deviating.
  - (Optional, not created unless Conrad asks: negative `_submissions._tcp ... 0 0 0 .`
    and `_pop3._tcp`/`_pop3s._tcp ... 0 0 0 .` to advertise "no 465 / no POP".)
  - Apply as code (CF DNS API, not the dashboard) -- the staged source +
    apply script is fleet-chezmoi `system/cloudflare/mail-dns/`.
- **Smoke (the go-live artifact):** from the laptop (off-fleet), a real mail client
  (Thunderbird: IMAPS `imap.skyphusion.org:993` + submission `smtp.skyphusion.org:587`,
  ONE Authentik login for BOTH doors) fetches INBOX and sends a message. A
  non-`mail-users` account / bad password / `From != identity` is rejected at the
  dischord door.
- **SRV smoke:** `dig +short SRV _submission._tcp.skyphusion.org` ->
  `0 1 587 smtp.skyphusion.org.` and `dig +short SRV _imaps._tcp.skyphusion.org` ->
  `0 1 993 imap.skyphusion.org.`. CRITICAL invariant check: the targets resolve to
  the BASTION, not a fleet box -- `dig +short smtp.skyphusion.org` and
  `imap.skyphusion.org` both == lagwagon's public IP. Then confirm a client's
  autodiscovery (Thunderbird "find config" from just `user@skyphusion.org`) lands on
  587 submission + 993 IMAPS.
- **Rollback:** remove the A records AND the SRV records (`_submission._tcp`,
  `_imaps._tcp`, `_imap._tcp`); close lagwagon public ufw 587/993. The forwarder +
  dischord doors can stay (private) or be torn down per 3c/3a.

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
