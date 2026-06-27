# Deploying postern-imap on dischord

The self-hosted **read** door for Postern: the Twisted IMAP4 proxy (`imap/`,
package `posternimap`) fronting the Postern mailbox read API. It is the IMAP
companion to the SMTP `relay/` that already runs on dischord. This runbook is
reproducible from the docs alone (no host-specific magic); it installs the proxy
as a hardened systemd unit, loopback-only, additive to a live box.

## Deployment contract (what runs where)

```
mail client / agent ──IMAP (loopback/VLAN)──► postern-imap (systemd, dischord)
                                                  │ HTTPS + Bearer (caller token)
                                                  ▼
                                       Postern mailbox read API (the inbound/store worker)
                                                  │
                                       D1 + R2 + Vectorize   (proxy never touches these)
```

- **Host:** dischord (10.1.1.2). Reach it over the private estate via the
  lagwagon bastion (`ssh -J lagwagon dischord`); public :22 is closed.
- **Listener (v1):** loopback `127.0.0.1:1143`, plaintext IMAP. The proxy carries
  a real credential (the caller's Postern API token as the IMAP password), so it
  must run **behind TLS or on loopback** (`imap/README.md`, "Auth model"). v1 is
  loopback-only; crew reach it over the private estate (SSH local-forward or
  sshuttle), so no port is exposed to the internet.
- **No new state.** The proxy owns no database; `token` mode stores no secret.

### Ports (additive, no collisions)
| Port | Owner | Notes |
|---|---|---|
| 2525 | live `skyphusion-email-relay` | SMTP inbound bridge -- do NOT touch |
| 1143 | postern-imap (this unit) | new, loopback only |

`143`/`993`/`1143` are all free on dischord today; this unit does not change the
relay or any other dischord service (CoreDNS, Authentik LDAP, Gatus, ntfy, Swarm).

## Prerequisites (verified on dischord)
- Python 3.12 (present: 3.12.3). On Debian/Ubuntu, `python3 -m venv` needs the
  `python3.12-venv` package (it carries `ensurepip`); install it first
  (`sudo apt-get install -y python3.12-venv`) or venv creation fails.
- The Postern read API origin (`POSTERN_API_URL`). See "Read-API endpoint" below.

## Read-API endpoint (POSTERN_API_URL)

The proxy is a client of the Postern mailbox read API (`/api/messages`,
`/api/messages/{id}`, `/api/threads/{id}`, `/api/search`), which is served by the
inbound/store worker. Set `POSTERN_API_URL` to that worker's origin. Resolve the
current value before install (the repo template `https://postern.example` is a
placeholder). A custom domain (e.g. `postern.skyphusion.org`) is preferred over a
`*.workers.dev` URL so the endpoint is stable IaC; if the custom domain is not yet
provisioned, the deployed worker origin is the interim value.

**As deployed (v1 stopgap):**
`POSTERN_API_URL=https://skyphusion-email-inbound.skyphusion.workers.dev` (the
live inbound/store worker; `/health` 200, `/api/*` token-gated 401/403). The
`postern.skyphusion.org` custom domain is intentionally HELD: standing it up means
redeploying the live inbound worker (a downtime gate on live email), so it waits
for a supervised window. Swap `POSTERN_API_URL` to the custom domain when it lands;
nothing else changes.

## 1. Install the code (venv at /opt/postern-imap)

```bash
sudo install -d -o root -g root /opt/postern-imap
# copy the imap/ package tree (posternimap/, pyproject.toml) into /opt/postern-imap,
# e.g. from a clone on the box or rsync from your workstation:
#   sudo rsync -a --delete imap/ /opt/postern-imap/
sudo python3 -m venv /opt/postern-imap/.venv
sudo /opt/postern-imap/.venv/bin/pip install --upgrade pip
sudo /opt/postern-imap/.venv/bin/pip install /opt/postern-imap   # installs Twisted
```

The unit runs under `DynamicUser=yes`, so `/opt/postern-imap` must stay
world-readable (the default). The proxy never writes there.

## 2. Configure the EnvironmentFile (no secret in token mode)

```bash
sudo install -m 0600 /dev/null /etc/postern-imap.env
sudoedit /etc/postern-imap.env
```

Minimum (token mode, the default; nothing secret stored here):

```
POSTERN_API_URL=https://<the-postern-read-api-origin>
POSTERN_IMAP_AUTH_MODE=token
POSTERN_IMAP_HOST=127.0.0.1
POSTERN_IMAP_PORT=1143
```

See `imap/.env.example` for every variable. In `token` mode each IMAP session
carries the user's own Postern API token as the password and the proxy validates
it live at login; the file holds no secret, so 0600 is belt-and-suspenders.
`fixed` mode (proxy holds the token, clients use a normal password) DOES put the
token in this file -- if you use it, keep 0600 and treat the file as a secret.

## 2a. Auth backends and the secret posture (#77)

A normal mail client uses ONE credential for BOTH doors (IMAP receive + SMTP
send). The SMTP `relay/` already authenticates that credential three ways
(`native`/`ldap`/`system`); the proxy mirrors those backends so the SAME login
opens the read door. Pick the backend with `POSTERN_IMAP_AUTH_MODE`.

**The posture shift (state it plainly).** In `token` mode the proxy holds NO
secret: the user's own API token rides in on every login. In `native`/`ldap`/
`system` the proxy authenticates the USER and then reads the store with a
**per-function SERVICE token it holds** -- so the proxy goes from holding nothing
to holding a long-lived secret. That is a real change in blast radius; treat the
EnvironmentFile as a secret and scope the token to exactly this function.

The auth-the-user step and the read-the-store step are deliberately separate (see
`auth.py`): a bad login is rejected BEFORE the service token is ever used, and the
service token never authenticates a client.

| mode | secret(s) the proxy holds | function of each | where stored |
|---|---|---|---|
| `token` | none | -- | -- (each session carries the user's own token) |
| `fixed` | `POSTERN_API_TOKEN` | the login token AND the read token | EnvironmentFile, 0600 |
| `native` | `POSTERN_API_TOKEN` (service) + `POSTERN_TRANSPORT_TOKEN` | read the store / call `POST /api/smtp-auth` to verify the user | EnvironmentFile, 0600 |
| `ldap` | `POSTERN_API_TOKEN` (service) + (search+bind only) `LDAP_BIND_PASSWORD` | read the store / bind the LDAP service account | EnvironmentFile, 0600 |
| `system` | `POSTERN_API_TOKEN` (service) | read the store | EnvironmentFile, 0600 |

**Per-function tokens, labeled, age-encrypted.** The service `POSTERN_API_TOKEN`
and the `POSTERN_TRANSPORT_TOKEN` are issued specifically for THIS proxy (own
token per consumer, house rule), labeled by function (e.g.
`postern-imap-proxy-service-token`, `postern-transport`), and at deploy they are
materialized from the age-encrypted secret store into `/etc/postern-imap.env`
(0600) by the deploy step -- **never committed in plaintext to git**. The
`native` transport token is the SAME transport-seam credential the relay uses for
`POST /api/smtp-auth`; reuse the relay's value so one credential gates that seam.
Rotation: rotate the service token at the worker, re-encrypt, redeploy the
EnvironmentFile, restart the unit; no client is affected (clients authenticate
with their own user credential, not the service token).

**Worker-side token scopes (#85, optional hardening).** The inbound worker can
gate its `/api/*` surface with per-function SCOPED tokens, each independently
rotatable, so a leaked token's blast radius is bounded. The proxy's service token
(`native`/`ldap`/`system` modes) only ever READS the store (`GET /api/messages`,
`/api/search`, `/api/threads`, attachment bytes), so it should hold the
read-scoped value -- it then physically cannot send mail even if the
EnvironmentFile leaks. The worker resolves the presented bearer to its scope and
authorizes per route; scopes are defined worker-side by which secret is set:

| worker secret | scope | reaches | held by |
|---|---|---|---|
| `POSTERN_API_TOKEN` (or `RELAY_TOKEN`) | `both` | read + send + credential-admin | default single-token deployments; any full-trust client |
| `POSTERN_API_TOKEN_READ` | `read` | `GET /api/messages`/`search`/`threads`/`.../attachments/...` ONLY | the IMAP read-door proxy (this service) and the read-only webmail |
| `POSTERN_API_TOKEN_SEND` | `send` | `POST /api/send`/`reply` ONLY | a send-only client (e.g. an alerts/notify sender) |

A presented token matching none of the configured secrets is `401`; a known token
used outside its scope is `403`. Credential-admin routes
(`POST`/`DELETE /api/admin/smtp-credentials`) are the most privileged and are
reachable ONLY by a `both` token. This is OPTIONAL: with only `POSTERN_API_TOKEN`
set, that lone token is `both` and the whole surface behaves exactly as before --
the egalitarian single-key posture is a first-class supported mode, not something
to "fix". To put the proxy on a read-only token, set this unit's
`POSTERN_API_TOKEN` to the VALUE provisioned worker-side as `POSTERN_API_TOKEN_READ`
(the proxy presents whatever token VALUE it holds; the worker classifies it). The
worker secrets are set with `wrangler secret put <NAME>`.

**Optional dependencies.** `ldap` needs `ldap3`, `system` needs `python-pam`
(both pure-Python, no C build step, imported lazily). Install the extra alongside
the package on the box:

```bash
sudo /opt/postern-imap/.venv/bin/pip install '/opt/postern-imap[ldap]'   # ldap mode
sudo /opt/postern-imap/.venv/bin/pip install '/opt/postern-imap[pam]'    # system mode
```

`native` and `token`/`fixed` need nothing beyond the base install.

## 3. Install and enable the unit

```bash
sudo install -m 0644 imap/systemd/postern-imap.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now postern-imap
systemctl status postern-imap --no-pager
```

## 4. Smoke (loopback)

```bash
# on dischord
ss -tlnp | grep 1143        # expect 127.0.0.1:1143 LISTEN
python3 - <<'PY'
import imaplib
c = imaplib.IMAP4("127.0.0.1", 1143)
c.login("agent@skyphusion.org", "<your-POSTERN_API_TOKEN>")
print(c.select("INBOX"))
print(c.search(None, "ALL"))
c.logout()
PY
```

A clean `LOGIN -> SELECT INBOX -> SEARCH ALL` against the live store is the
deploy artifact. A bad token must fail the login (token mode validates live).

## 5. Reaching it from a workstation (v1, private)

No public listener. Tunnel over the bastion, then point a mail client at the
local end:

```bash
ssh -J lagwagon -L 1143:127.0.0.1:1143 dischord    # local 1143 -> dischord 1143
# or: sshuttle --dns -r conrad@lagwagon.internal 10.1.0.0/16  (then 10.1.1.2:1143)
```

Mail client: server `127.0.0.1`, port `1143`, no TLS (the SSH tunnel is the
transport security); username = your mailbox label, password = your Postern API
token.

## LDAP / PAM mode posture (per #75 / #77)

v1 above is `token` mode: the proxy holds **no** secret; each IMAP session carries
the user's own Postern API token and the proxy validates it live. The unified
mail-auth contract (`docs/AUTH-CONTRACT.md`) adds `ldap` / `pam` modes so a user
logs in with their **Authentik** credential (the same login as the 587 submission
server and crew SSH). That changes the secret posture of this box:

- The proxy authenticates the **human** against the directory (PAM ->
  `/etc/pam.d/postern` -> nslcd -> Authentik, the fleet default; or a direct LDAP
  bind, the portable alternative).
- But the proxy still must **read the store** (the inbound/store worker, D1/R2) over
  the Postern API, which is gated by the mailbox API token. So in `ldap`/`pam` mode
  the proxy reads the store with a **per-function SERVICE credential** it holds:
  `POSTERN_API_TOKEN`, decoupled from the human's login.
- Net: the proxy moves from "holds no secret" (token mode) to "holds a
  per-function, labelled, age-encrypted service token" (`ldap`/`pam` mode).

**What secret this component holds, by function, and where:**

| Secret | Function | Where stored |
|---|---|---|
| `POSTERN_API_TOKEN` | postern-imap reads the store (`/api/messages`, `/search`) | crew-secrets (age-encrypted) -> appended to `/etc/postern-imap.env` (root 0600) at deploy; **never** committed |

This is the same single mailbox API token the 587 submission server uses for its
`/api/send` hand-off in v1 (scoped/per-function-distinct tokens are post-v1; see
`docs/AUTH-CONTRACT.md` section 7). Presence-check it with `${POSTERN_API_TOKEN:+SET}`
only. The hardened unit must allow `AF_UNIX` in `RestrictAddressFamilies` for the
PAM path (pam_ldap talks to the nslcd socket) -- see `docs/AUTH-CONTRACT.md` and the
submission unit for the same requirement.

LDAP bind details (base, user DN shape, the `mail-users` authorization gate, the
search filter) are in `docs/AUTH-CONTRACT.md` and are identical to what the 587
submission server consumes, by design (one contract, both doors).

## Public IMAPS (later phase, HARD GATE on Conrad)

Exposing IMAP to the internet is out of scope for v1 and is a **hard gate: do not
provision a public cert or open 993 without Conrad's direct word.** It is both a
downtime/exposure change on a live box and the point where the proxy's held
service token (section 2a) becomes reachable from outside loopback.

993 IMAPS uses the existing `POSTERN_IMAP_TLS_CERT` / `POSTERN_IMAP_TLS_KEY` knobs
(set both -> the listener serves implicit TLS). For local verification you may
generate a **self-signed cert and test on loopback ONLY**:

```bash
# loopback test only -- NOT a public cert, NOT exposed
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout /tmp/imaps-test.key -out /tmp/imaps-test.crt -subj "/CN=localhost"
# point POSTERN_IMAP_TLS_CERT/KEY at these, restart, then imaplib.IMAP4_SSL on 127.0.0.1
```

Provisioning a real cert and opening the port is the gated path below (flag before
doing it):
1. DNS: add an A record for the mail host (e.g. `imap.skyphusion.org`) in
   Cloudflare DNS (IaC, not the dashboard). Cloudflare does not proxy IMAP except
   via Spectrum (paid), so this is a grey-cloud record to the box.
2. TLS: a real cert for that hostname (Let's Encrypt via DNS-01 against the
   Cloudflare DNS API). Set `POSTERN_IMAP_TLS_CERT`/`POSTERN_IMAP_TLS_KEY` for
   native IMAPS, or front loopback:1143 with stunnel on 993.
3. Firewall: open 993 in ufw/iptables scoped as tightly as the use case allows.
   This is the change that touches a live box's exposure -- do not do it silently.

## Rollback

```bash
sudo systemctl disable --now postern-imap
sudo rm /etc/systemd/system/postern-imap.service
sudo systemctl daemon-reload
# /opt/postern-imap and /etc/postern-imap.env can stay or be removed.
```

Nothing here mutates the relay, the store, or any other dischord service, so
rollback is a clean removal of an additive unit.
