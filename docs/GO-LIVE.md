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
  ingress to the fleet arrives at a managed edge that fronts a PRIVATE target;
  **no fleet box ever takes a direct connection from the outside world or binds a
  public port.** Raw-TCP services (the 587/993 mail doors) sit behind a Hetzner
  Cloud L4 load balancer whose target is dischord's PRIVATE vSwitch IP (Phase 2);
  HTTP surfaces (e.g. webmail) use a cloudflared tunnel. The fleet box stays dark
  in every case; the edge (LB or tunnel) is the only public surface. This governs
  every externally-reachable service, not just Postern.
- **One variable at a time. Verify after each step before the next.**
- **Keep a known-good root/console session open on dischord** for the duration (the
  fleet SSH path is LDAP-backed; do not risk locking yourself out mid-change).
- **Each gated item below has: the command, a post-step smoke check, and a
  rollback.** If a smoke check fails, STOP and roll back that step; do not proceed.
- **Deploy ordering is load-bearing:** a consumer is never repointed before its new
  target exists and is verified. `typecheck`/`wrangler deploy --dry-run` will NOT
  catch a dangling worker/route reference; only a real deploy + smoke will.
- The mail edge no longer touches the bastions: lagwagon/face2face are NOT in the
  587/993 path. Their `ip_forward`/MASQ + the bastion fail2ban remain the
  laptop->fleet lifeline -- leave them untouched; this go-live adds NO bastion
  forwarder and NO bastion mail jail.

## Pre-flight (confirm before touching anything)

- [ ] Loopback doors healthy: `postern-imap` on 127.0.0.1:1143, `postern-submission`
      on 127.0.0.1:1587 (if staged), inbound relay on 2525. `systemctl status` green.
- [ ] crew-secrets holds the deploy secrets (presence-check `${VAR:+SET}` only):
      `POSTERN_API_TOKEN` (store-read), `POSTERN_SEND_TOKEN`, `POSTERN_TRANSPORT_TOKEN`.
- [ ] Cloudflare API token available for DNS + Workers (minter tier, on demand).
- [ ] Topology is FIXED (Phase 2): external mail ingress comes via ONE Hetzner
      Cloud L4 load balancer whose target is dischord's PRIVATE vSwitch IP
      (10.1.1.2); no fleet box binds a public port. TLS is end-to-end (terminates
      on dischord; the LB carries no certs); 993 is implicit-TLS AT THE DOOR. No
      edge-TLS / stunnel-on-bastion decision remains -- the only open 993 sub-detail
      is native-IMAPS vs a local stunnel ON DISCHORD (Phase 3b, door-side).
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

## Phase 2 -- the mail edge: ONE L4 load balancer, target dischord PRIVATE (no bastion)

Per the cardinal invariant, external mail ingress arrives at a managed edge that
fronts a PRIVATE target. That edge is **ONE Hetzner Cloud L4 (raw-TCP) load
balancer** fronting BOTH 587 + 993 behind a single public VIP. It targets
**dischord directly over the Hetzner private network / vSwitch** at 10.1.1.2 --
**not** via lagwagon/face2face, and with **no HAProxy/socat forwarder layer**.
dischord stays dark: it binds only its private VLAN interface and is reachable by
the LB over the private network only. The LB is the single public surface.

TLS is **end-to-end**: the LB is a dumb L4 ciphertext pipe (it carries NO certs);
TLS terminates on the dischord doors. The LB enables **PROXY protocol**, which the
doors parse to recover the real client IP.

```
                 mail client (internet)
                        |
                        |  587 (STARTTLS)  /  993 (IMAPS)   -- TLS, opaque to the LB
                        v
        +-------------------------------------+
        |  Hetzner Cloud LB  "postern-edge"   |   single public VIP (A/AAAA)
        |  hel1 (eu-central), L4 raw-TCP      |   PROXY protocol ON, no certs
        |  587 + 993, TCP-connect healthchecks|   target = IP target, dischord priv
        +-------------------------------------+
                        |
                        |  private network / vSwitch bridge (VLAN4000)
                        |  PROXY-wrapped TCP to the door's private IP
                        v
        +-------------------------------------+
        |  dischord  10.1.1.2  (dedicated)    |   binds the PRIVATE VLAN iface only
        |  postern-submission :587 (STARTTLS) |   doors parse PROXY protocol,
        |  postern-imap       :993 (IMAPS)    |   then terminate TLS (cert here)
        +-------------------------------------+
                        |
                        |  HTTPS(443) /api/*  (unchanged)
                        v
                 postern.skyphusion.org
```

**Why the LB can target a dedicated box privately:** a Hetzner Cloud LB targets a
dedicated/robot server by private IP when (1) LB + server share a Cloud Network via
vSwitch, (2) the target IP is inside the vSwitch subnet, and (3) the LB is in the
eu-central zone. All three already hold: network-2 (12319468) has a vswitch subnet
10.1.1.0/24 bridged to robot vSwitch 82645 (VLAN4000), `expose_routes_to_vswitch`
is on, dischord is 10.1.1.2, and the LB is in hel1 (eu-central). The LB IaC and the
full mechanism live in fleet-chezmoi `system/hetzner/postern-edge-lb/`.

HTTP surfaces are different: if **webmail** (or any HTTP UI) is ever exposed, the
sanctioned pattern is a **cloudflared tunnel**, never a fleet-box public port and
never an LB pointed at a public fleet port. Out of scope for this mail go-live;
noted so the invariant is not violated when webmail comes up.

### What this RETIRES from the old plan

The previous bastion-front design is dead. Specifically retired:
- the lagwagon/face2face **userspace TCP forwarder** (HAProxy / socat / stunnel);
- **fail2ban on the bastion** for the mail ports (no bastion mail jail is added);
- the **dual / bastion-targeted A records** -- DNS now points at the LB VIP only;
- any **edge-TLS** termination -- TLS is end-to-end on dischord in all cases.

lagwagon's `ip_forward` + MASQ + SSH jail remain the laptop->fleet lifeline and are
**untouched** by this go-live (the mail path no longer goes through them).

NB: Hetzner blocks OUTBOUND 25/465/587 on the fleet, but these are INBOUND
listeners (clients connect IN to the LB, which forwards over the private network),
which is unaffected. The send hand-off to the worker is HTTPS(443), which is open.

---

## Phase 3 -- stand up the LB-direct mail edge

Order: bring up dischord's doors on the PRIVATE interface WITH PROXY-protocol
parsing, verify privately, THEN provision the LB (gated), THEN DNS (dead-last).
The PROXY-protocol parsing on the doors is a HARD prerequisite for the LB's
`proxyprotocol` flag: enabling it against a door that does NOT parse PROXY protocol
renders the service inaccessible (Hetzner is explicit on this).

### 3a. dischord doors bind the PRIVATE vSwitch interface + parse PROXY protocol

The doors must be reachable from the LB over the private network, NOT from the
internet. Bind them to dischord's VLAN IP (10.1.1.2), never 0.0.0.0:

- postern-submission: listen `10.1.1.2:587` (STARTTLS), **PROXY protocol v1/v2
  parsing enabled** on that listener (Rollins, 587 Go door).
- postern-imap: listen `10.1.1.2:993` (IMAPS), **PROXY protocol v1/v2 parsing
  enabled** on that listener (Joan, 993 Python door).
- dischord ufw: allow 587 + 993 **FROM the LB's private source ONLY** (the estate
  `10.1.0.0/16`; tighten to the LB's pinned private IP if one is set). **No public
  change on dischord.**

- **Smoke:** from another estate host, a PROXY-protocol-prefixed TCP connection to
  `10.1.1.2:587` / `:993` is accepted and the door logs the REAL client IP from the
  PROXY header; a connection from a public host does NOT reach the door.
- **Rollback:** revert the doors to loopback (`127.0.0.1:1587/1143`) and drop the
  dischord ufw allow.

### 3b. TLS model -- end-to-end, terminated AT THE DOOR (FIXED, no longer a choice)

TLS is end-to-end: the LB is an L4 passthrough that sees only ciphertext, and the
**dischord doors hold the cert and terminate TLS**. 587 keeps STARTTLS; 993 is
implicit IMAPS at the door. The cert (`smtp.` / `imap.skyphusion.org`) is
provisioned on dischord via DNS-01 (a TXT record; no port/exposure needed).

The only remaining door-side sub-detail is **native IMAPS vs a local stunnel ON
DISCHORD** for the 993 listener (Joan's lane: serve TLS natively in the Python
door, or front the loopback proxy with stunnel on dischord). Either keeps TLS on
dischord; neither involves the edge. The old edge-TLS / stunnel-on-bastion option
is GONE.

### 3c. Provision the LB (GATED -- SPEND + first public exposure)

Apply the staged LB IaC in fleet-chezmoi `system/hetzner/postern-edge-lb/` (or the
equivalent hcloud-API path documented there). It creates: the LB `postern-edge`
(hel1, `lb11`), the network-2 attachment, the 587 + 993 TCP services with
**`proxyprotocol` ON** and TCP-connect health checks, and the **IP target
`10.1.1.2`**.

- **HARD ORDER:** 3a (doors parsing PROXY protocol, bound private) MUST be verified
  before this step. The `proxyprotocol` flag against a non-parsing door = dead
  service.
- **Smoke:** the LB target health shows dischord HEALTHY on 587 + 993; `terraform
  output lb_public_ipv4` (or the API read) returns the VIP. From the estate, the LB
  private IP reaches the doors.
- **Rollback:** `terraform destroy` (or delete the LB via API). Deleting an LB is
  free and stops billing; the doors stay private.

NB on the TCP health check: a bare TCP-connect probe carries NO PROXY header. A
strict PROXY parser will drop the headerless probe after connect -- fine for the
health verdict (connect succeeded), but confirm with Rollins/Joan that a headerless
health connection is treated benignly (NOT logged as an auth error, NOT throttled).

### 3d. Public DNS (DEAD-LAST)

Only after 3a-3c verify:

- **DNS:** grey-cloud A/AAAA records `smtp.skyphusion.org` + `imap.skyphusion.org`
  -> **the LB public VIP** (NOT dischord, NOT a bastion). A SINGLE record per host;
  no dual-A scheme. CF does not proxy SMTP/IMAP except via Spectrum, so these are
  grey-cloud (DNS-only). IaC via the CF DNS API, not the dash.
- **Autodiscovery SRV records (RFC 6186):** let clients auto-configure from just
  `user@skyphusion.org`. SRV cannot be proxied (CF proxies only A/AAAA/CNAME), so
  DNS-only by nature. **The targets are the door host names (the A records above,
  -> the LB VIP), NEVER a fleet box** -- the ingress invariant applied to
  autodiscovery. Records:
  ```
  _submission._tcp.skyphusion.org.  300  IN  SRV  0 1 587  smtp.skyphusion.org.
  _imaps._tcp.skyphusion.org.        300  IN  SRV  0 1 993  imap.skyphusion.org.
  _imap._tcp.skyphusion.org.         300  IN  SRV  0 0 0    .
  ```
  - **`_submission` (587)** is the STARTTLS submission door (RFC 6186). **NO 465 /
    `_submissions` record:** Hetzner blocks 465 and submission is 587-only.
  - **`_imaps` (993) positive + `_imap` (143) negative.** Our 993 door is
    implicit-TLS, so the RFC-correct positive is `_imaps._tcp ... 993`; we offer no
    plaintext/143, so `_imap._tcp ... 0 0 0 .` is the RFC negative that steers
    clients off plaintext IMAP. (Conrad asked for "_imap"; this implements it
    RFC-correctly. A literal `_imap._tcp` positive would mean a STARTTLS-on-143
    door we have not built -- confirm before deviating.)
  - (Optional, not created unless Conrad asks: negative `_submissions._tcp ... 0 0 0 .`
    and `_pop3._tcp` / `_pop3s._tcp ... 0 0 0 .` to advertise "no 465 / no POP".)
  - Apply as code (CF DNS API, not the dashboard) -- staged source + apply script:
    fleet-chezmoi `system/cloudflare/mail-dns/`.
- **Smoke (the go-live artifact):** from the laptop (off-fleet), a real mail client
  (Thunderbird: IMAPS `imap.skyphusion.org:993` + submission
  `smtp.skyphusion.org:587`, ONE Authentik login for BOTH doors) fetches INBOX and
  sends a message. A non-`mail-users` account / bad password / `From != identity`
  is rejected at the dischord door. The door logs show the REAL client IP (PROXY
  protocol parsed end-to-end), not the LB private source.
- **SRV smoke:** `dig +short SRV _submission._tcp.skyphusion.org` ->
  `0 1 587 smtp.skyphusion.org.` and `dig +short SRV _imaps._tcp.skyphusion.org` ->
  `0 1 993 imap.skyphusion.org.`. CRITICAL invariant check: the targets resolve to
  the LB VIP, not a fleet box -- `dig +short smtp.skyphusion.org` and
  `imap.skyphusion.org` both == the LB public VIP. Then confirm a client's
  autodiscovery (Thunderbird "find config" from just `user@skyphusion.org`) lands on
  587 submission + 993 IMAPS.
- **Rollback:** remove the A/AAAA records AND the SRV records (`_submission._tcp`,
  `_imaps._tcp`, `_imap._tcp`); `terraform destroy` the LB (3c). The doors stay
  private.

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
      and 587 submission (Phase 3).
- [ ] A non-`mail-users` account is rejected on both doors.
- [ ] `gatus`/monitoring green for the new endpoints.
- [ ] Only now: close the known-good safety sessions.

## Master rollback order (if the window must be aborted)

Reverse of go-live: the public EDGE comes down first, then the dischord doors,
then live-email routing LAST (so live email is restored most carefully):

1. **DNS first:** remove the A/AAAA records (`smtp.` / `imap.`) and the SRV records
   (`_submission._tcp`, `_imaps._tcp`, `_imap._tcp`). New client lookups stop
   resolving the edge immediately.
2. **LB next:** `terraform destroy` (or delete the LB via the API). The public VIP
   is gone and billing stops. The bastions were never in this path, so lagwagon
   `ip_forward` / MASQ / SSH jail / ignoreip are untouched throughout.
3. **dischord doors:** revert the doors to loopback (`127.0.0.1:1587/1143`), drop
   the dischord LB-source ufw allow. (Doors back to private.)
4. If Phase 4 was touched: remove 636 + the scoped `cn=postern-mail-ro` account.
5. If the doors' origin was moved: repoint `POSTERN_API_URL` / `POSTERN_SEND_URL`
   back.
6. **Live email LAST:** only if Phase 1 itself is being reverted, repoint the Email
   Routing rules + `EMAIL_WORKER_URL` back to the old workers (still present until 1.6).

Live inbound email is the most sensitive surface; its switch (1.3) is a single
reversible routing change and the old worker stays deployed until a soak passes.
