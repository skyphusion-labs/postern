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

## Public IMAPS (later phase, gated)

Exposing IMAP to the internet is out of scope for v1 and is a downtime/exposure
gate (flag before doing it):
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
