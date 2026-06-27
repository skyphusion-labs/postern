# Deploying the Postern 587 submission server on dischord

The self-hosted **send** door for Postern: the Go `relay/` binary in its
authenticated SMTP **submission** role (587), the SMTP companion to the IMAP read
proxy (`imap/DEPLOY.md`). It authenticates an external mail client (Thunderbird,
Apple Mail, mutt, mobile) against Authentik and bridges the message to the worker
`/api/send` seam. Unified-login contract: `docs/AUTH-CONTRACT.md`. This runbook is
reproducible from the docs alone; it installs the server as a hardened systemd unit,
**loopback-only**, additive to a live box.

## Deployment contract (what runs where)

```
mail client / agent ──SMTP submission (STARTTLS + AUTH)──► postern-submission (systemd, dischord)
                                                              │ AUTH: PAM -> nslcd -> Authentik (the user)
                                                              │ HTTPS + Bearer (POSTERN_SEND_TOKEN)
                                                              ▼
                                                   worker /api/send (DKIM-sign + store + MX)
```

- **Host:** dischord (10.1.1.2). Same box as the IMAP proxy, the inbound relay, and
  the Authentik LDAP outpost; PAM auth is a local nslcd hop (no TLS-to-directory
  needed; see AUTH-CONTRACT.md section 3a).
- **Listener (v1):** loopback `127.0.0.1:1587`, STARTTLS + AUTH. AUTH is offered
  ONLY over TLS, so even the loopback listener needs a cert (a self-signed local
  cert is fine for the smoke test). The public 587 listener is **GATED**.
- **Auth = PAM** (`AUTH_BACKEND=system`, `/etc/pam.d/postern`), the fleet default
  and the "PAM on both doors" requirement. Direct-LDAP is the portable alternative
  (AUTH-CONTRACT.md section 5b).
- **No new state.** The server owns no database; it authenticates and forwards.

### This is a SEPARATE instance from the inbound relay

The existing `skyphusion-email-relay` (inbound SMTP -> `/ingest`, loopback 2525)
**stays untouched** (skyphusion #74 / its fleet record). The submission server is a
second systemd unit running the **PAM-tagged** build of the same relay code under a
distinct binary name and a distinct env file. Ports must not collide:

| Port | Owner | Notes |
|---|---|---|
| 2525 | live `skyphusion-email-relay` | inbound SMTP bridge -- do NOT touch |
| 1143 | `postern-imap` | IMAP read proxy (loopback) |
| 1587 | `postern-submission` (this unit) | submission listener (loopback, v1) |
| 2587 | `postern-submission` inbound stub | see the "submission-only wart" below |

### The submission-only wart (read before deploy)

The relay binary **always** starts an inbound SMTP listener and **always** requires
an inbound destination, even when you only want submission (`relay/smtp.go run()`;
`relay/config.go loadConfig()`). So the submission instance must also set a harmless
`SMTP_LISTEN` (a dead loopback port, `127.0.0.1:2587`, NOT the live 2525) and a real
`POSTERN_INGEST_URL` + `POSTERN_TRANSPORT_TOKEN`. The clean end-state is an
"empty `SMTP_LISTEN` = submission-only, no inbound destination required" relay flag;
that is a small relay change tracked under #76. Until it lands, the dead-port stub is
the documented workaround.

## Prerequisites
- Go >= 1.22 and **libpam headers** (`libpam0g-dev`) to build `-tags pam`; `libpam`
  + `libpam-ldapd` (nslcd) at runtime (already present on dischord).
- `nslcd` running and `getent group mail-users` resolving (verified on dischord).
- The PAM service file `/etc/pam.d/postern` installed (fleet-chezmoi
  `system/pam.d/postern`).
- The worker send origin (`POSTERN_SEND_URL`) reachable. v1 uses
  `https://postern.skyphusion.org` once the custom domain lands (#74); interim, the
  live worker origin.

## 1. Build the PAM-tagged binary

```bash
git clone https://github.com/skyphusion-labs/postern && cd postern/relay
go build -tags pam -o postern-submission .     # PAM needs cgo + libpam headers
go vet -tags pam ./...
sudo install -m 0755 postern-submission /usr/local/bin/
```

The cgo-free inbound relay stays at `/usr/local/bin/skyphusion-email-relay`; this
PAM build is a distinct binary at `/usr/local/bin/postern-submission`.

## 2. Install the PAM service file

```bash
# from fleet-chezmoi:
sudo install -m 0644 system/pam.d/postern /etc/pam.d/postern
```

It gates on `mail-users` then delegates to `common-auth` (where pam_ldap lives). See
`docs/AUTH-CONTRACT.md` section 4.

## 3. Configure the EnvironmentFile (secrets injected, never committed)

```bash
sudo install -m 0600 /dev/null /etc/postern-submission.env
# seat the NON-SECRET lines from relay/postern-submission.env.example, then append
# the secrets decrypted from crew-secrets (root 0600), e.g.:
#   POSTERN_SEND_TOKEN=<mailbox API token>
#   POSTERN_TRANSPORT_TOKEN=<transport token>
sudoedit /etc/postern-submission.env
```

Named secrets (by function; full inventory in AUTH-CONTRACT.md section 7):
- `POSTERN_SEND_TOKEN` -- the worker `/api/send` mailbox API token (the send door).
- `POSTERN_TRANSPORT_TOKEN` -- the transport token for the mandatory inbound stub.

Both are age-encrypted in crew-secrets; presence-check with `${VAR:+SET}` only. In
v1 both `POSTERN_SEND_TOKEN` and the IMAP proxy's store-read token resolve to the
single mailbox API token (per-function split is post-v1; AUTH-CONTRACT.md section 7).

## 4. Loopback TLS cert (for the smoke test only)

```bash
sudo install -d -m 0755 /etc/postern-submission
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/postern-submission/key.pem \
  -out   /etc/postern-submission/cert.pem -subj /CN=localhost
sudo chmod 0644 /etc/postern-submission/cert.pem   # DynamicUser must read the PEMs
sudo chmod 0644 /etc/postern-submission/key.pem    # loopback self-signed only
```

The **public** cert for the real hostname is GATED (do not provision until the
exposure flip; see section 8 of AUTH-CONTRACT.md).

## 5. Install and enable the unit

```bash
sudo install -m 0644 relay/systemd/postern-submission.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now postern-submission
systemctl status postern-submission --no-pager
```

## 6. Smoke (loopback, PAM auth)

```bash
ss -tlnp | grep 1587        # expect 127.0.0.1:1587 LISTEN
# A STARTTLS + AUTH PLAIN submission as a mail-users account; From must equal the
# bound identity (<login>@skyphusion.org). swaks makes this one line:
swaks --server 127.0.0.1:1587 --tls --auth PLAIN \
      --auth-user conrad --auth-password '<directory password>' \
      --from conrad@skyphusion.org --to you@example.com \
      --header 'Subject: submission smoke' --body 'hello via 587'
```

A clean `STARTTLS -> AUTH -> 250 sent` is the deploy artifact. A non-`mail-users`
account, a bad password, or a `From` != bound identity must be rejected (535/550).

## 7. Reaching it from a workstation (v1, private)

No public listener. Tunnel over the bastion and point a client at the local end:

```bash
ssh -J lagwagon -L 1587:127.0.0.1:1587 dischord
# Thunderbird: outgoing SMTP 127.0.0.1:1587, STARTTLS, normal password; username =
# your short login (or full address), password = your Authentik password.
```

## Public 587 submission (later phase, GATED)

Exposing 587 to the internet is out of scope for v1 (AUTH-CONTRACT.md section 8):
1. DNS: `smtp.skyphusion.org` A record in Cloudflare DNS (IaC; grey-cloud, CF does
   not proxy SMTP except via Spectrum).
2. TLS: a real cert for that hostname (Let's Encrypt DNS-01 via the CF DNS API);
   set `SUBMISSION_TLS_CERT`/`_KEY`, the daemon hot-reloads on renewal.
3. Listener: `SUBMISSION_LISTENERS=587:starttls,465:implicit`.
4. Firewall: open 587 (and 465) in ufw scoped as tightly as the use case allows.
   This touches a live box's exposure -- do not do it silently.

NB: Hetzner blocks outbound 25/465/587 on the fleet, but these are INBOUND
submission listeners (clients connect IN), which is unaffected. The send hand-off to
the worker is HTTPS(443), which is open (the same reason the inbound relay exists).

## Rollback

```bash
sudo systemctl disable --now postern-submission
sudo rm /etc/systemd/system/postern-submission.service
sudo systemctl daemon-reload
# /usr/local/bin/postern-submission, /etc/postern-submission.env, /etc/pam.d/postern,
# and /etc/postern-submission/ can stay or be removed.
```

Nothing here mutates the inbound relay, the store, the IMAP proxy, or the IdP, so
rollback is a clean removal of an additive unit.
