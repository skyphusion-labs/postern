# Unified mail-auth contract (IMAP read + SMTP submission, one login)

Status: **contract / design of record**. The code that consumes it is tracked in
skyphusion-labs/postern#76 (Go 587 submission server) and #77 (IMAP `ldap`/`pam`
mode); the umbrella is #75. This document is the single source the two consumers
read from, so a binding never gets invented per-component. It is reproducible from
the docs alone (ICD discipline): every DN, base, filter, attribute, and token here
was verified read-only against the live Authentik directory on dischord.

## 1. The requirement

An external mail client (Thunderbird, Apple Mail, mutt, mobile) configures **one
username and one password**, and it authenticates **both** doors:

- **Read** door: IMAP, served by the `imap/` proxy (`posternimap`).
- **Send** door: SMTP submission on 587, served by the Go `relay/` binary in its
  submission role.

Both doors verify the **same** end-user credential against the **same** directory,
so a credential can never drift between protocols. The directory is the same
Authentik instance that backs crew SSH, so there is one identity per human.

## 2. The directory (verified ground truth)

Authentik LDAP outpost on **dischord** (`ghcr.io/goauthentik/ldap:2024.12.3`),
published on the VLAN:

| Fact | Value |
|---|---|
| Primary LDAP URI | `ldap://10.1.1.2:389` (dischord) |
| Failover LDAP URI | `ldap://10.1.1.3:389` (fugazi) |
| Transport offered | **plaintext 389 only** (no 636, no StartTLS today; see section 6) |
| Base DN | `dc=ldap,dc=goauthentik,dc=io` |
| Users OU | `ou=users,dc=ldap,dc=goauthentik,dc=io` |
| Groups OU | `ou=groups,dc=ldap,dc=goauthentik,dc=io` |
| User DN shape | `cn=<username>,ou=users,dc=ldap,dc=goauthentik,dc=io` |
| Login attributes | `cn` (short username, == SSH login), `mail` (full address), `sAMAccountName` |
| Bound-identity attribute | `mail` (e.g. `conrad@skyphusion.org`) |
| Mailbox authorization group | `cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io` (gid 24352) |
| Scoped-search group (exists) | `cn=authentik Read-only,ou=groups,...` |
| Admin group (do NOT bind as) | `cn=authentik Admins,ou=groups,...` |

Anonymous bind is refused (`Insufficient access (50)`); the directory only answers
an authenticated bind. The existing fleet bind account `cn=ldap-svc` is a member of
**`authentik Admins`** and is used by nslcd/SSH; **it must not be reused as a mail
bind account** (coupling mail to an admin-grade, SSH-critical credential violates
per-function-key discipline and widens blast radius).

### Authorization gate

Membership in `cn=mail-users` is the gate for "this account may use mail." It is a
real, nss-visible group (`getent group mail-users` resolves on dischord) and today
contains `conrad`. Adding a mailbox user = add them to `mail-users` (additive
Authentik blueprint edit, supervised). Both doors enforce this gate (section 4/5).

## 3. The two backends, and why PAM is the fleet default

Both consumers can authenticate a user two ways. They are equivalent in result
(same directory, same bound identity); they differ in the path to it.

### 3a. PAM (`system` mode) -- the fleet default

The box already speaks to the directory: dischord runs `nslcd` (libpam-ldapd), and
`/etc/pam.d/common-auth` chains `pam_unix` then `pam_ldap` (`minimum_uid=1000
use_first_pass`). PAM auth for an Authentik account therefore flows
**process -> pam_ldap -> nslcd -> LDAP bind**. nslcd already holds the bind
credential, so:

- **No new mail bind service account** is needed (nslcd binds, not Postern).
- **No TLS-to-directory mutation** is needed: nslcd uses plaintext 389 over the
  trusted VLAN, the posture already accepted fleet-wide for nss/SSH.
- The bind credential is the existing `ldap-svc` (already IaC, already rotatable
  via `system/provision/RUNBOOK-rotate-ldap-bind-pw.md` in fleet-chezmoi).

This is why **PAM is the recommended backend for both doors on dischord**, and it
is the posture Conrad asked for ("PAM on both doors"). The PAM service file is
`/etc/pam.d/postern` (section 4).

Hardening note (load-bearing): the hardened unit runs `DynamicUser` +
`NoNewPrivileges=yes`. That is compatible with the **pam_ldap** path (it only
connects to the `nslcd` socket; no setuid, no `/etc/shadow` read). It is **not**
compatible with verifying a purely-local `/etc/shadow` password (that needs the
setuid `unix_chkpwd` helper, which `NoNewPrivileges` blocks). On the fleet the mail
accounts are LDAP accounts (uid >= 1000), so the pam_ldap path is the one taken and
the hardening stands. Do not "fix" a local-shadow login by dropping
`NoNewPrivileges`; mail accounts live in the directory.

### 3b. Direct LDAP (`ldap` mode) -- portable / off-fleet

The Go relay (`auth_ldap.go`) and the Python proxy (#77) can also bind the
directory directly (pure-Go `go-ldap`; Python `ldap3`/equivalent). This is the
right path for a non-fleet operator (a clone with no nslcd). On dischord it is the
**alternative**, gated behind one IdP change: the relay's LDAP backend **mandates
TLS** (`ldap auth requires TLS`), but the outpost offers plaintext 389 only.
Enabling direct-LDAP on the fleet therefore requires section 6 (provision 636 + a
cert on the LDAP provider) and a scoped read-only bind account. Until then, use
PAM on the fleet.

The direct-LDAP env (consumed identically by #76 and #77) is in section 5b.

## 4. PAM service file (`/etc/pam.d/postern`)

Tracked as IaC in fleet-chezmoi at `system/pam.d/postern` (deployed to
`/etc/pam.d/postern`, root 0644). Both doors name this service:

- Go submission: `AUTH_SYSTEM_PAM_SERVICE=postern` (default).
- Python IMAP `pam` mode (#77): the same service name.

Contents and rationale live with the file; the shape is: gate on
`pam_succeed_if user ingroup mail-users`, then delegate to the system
`common-auth` / `common-account` (which is where pam_ldap lives). Gating on
`mail-users` means a valid directory password for a non-mail account still cannot
open a mail door.

## 5. The exact bindings each consumer reads

### 5a. PAM path (fleet default)

Go submission server (`relay/`, built `-tags pam`):

```
AUTH_BACKEND=system
AUTH_SYSTEM_DOMAIN=skyphusion.org      # bound identity = <login>@skyphusion.org
AUTH_SYSTEM_PAM_SERVICE=postern        # -> /etc/pam.d/postern
```

Python IMAP proxy (`imap/`, #77 `pam` mode): same PAM service `postern`, same
resulting identity. The proxy still needs the store-read service token (section 7).

Login: the user types their **short username** (`conrad`) or full address; PAM
resolves it. Bound/From identity = `<login-localpart>@skyphusion.org`.

### 5b. Direct-LDAP path (portable; fleet only after section 6)

Search+bind is the contract shape (it lets the user log in with their email
address and reads `mail` with a low-privilege account). The filter encodes the
`mail-users` authorization gate. Note the Go backend substitutes the username into
the filter **exactly once** (`fmt.Sprintf` with one arg), so the filter uses
exactly one `%s`:

```
AUTH_BACKEND=ldap                       # (Go) ; POSTERN_IMAP_AUTH_MODE=ldap (Python)
LDAP_URL=ldaps://dischord.internal:636  # TLS mandatory; see section 6
# (or LDAP_URL=ldap://10.1.1.2:389 + LDAP_STARTTLS=true once StartTLS is provisioned)
LDAP_BIND_DN=cn=postern-mail-ro,ou=users,dc=ldap,dc=goauthentik,dc=io
LDAP_BIND_PASSWORD=${POSTERN_LDAP_BIND_PASSWORD}    # secret; section 7
LDAP_SEARCH_BASE=ou=users,dc=ldap,dc=goauthentik,dc=io
LDAP_SEARCH_FILTER=(&(mail=%s)(memberOf=cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io))
LDAP_MAIL_ATTR=mail
```

`cn=postern-mail-ro` is a **new, scoped, read-only** bind account (member of
`authentik Read-only`, never `authentik Admins`), used only to search. Creating it
is an IdP mutation -- **staged, gated for Conrad** (section 8). Simple-bind
(`LDAP_BIND_DN_TEMPLATE=cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io`, login = short
username, no service account) is a fallback, but it depends on a bound user being
able to read their own `mail` attribute through the outpost (verify during
bring-up; if the search returns nothing the identity cannot be resolved).

**Per-door difference (verified against the #77 IMAP code).** The `mail`-attribute
resolution above is the **SMTP relay's** need: the relay uses `mail` as the
authenticated From and enforces `From == mail`, so it MUST read it (and the
simple-bind caveat applies to the relay). The **IMAP proxy does NOT read `mail`**:
simple-bind checks only that the bind succeeds, and search+bind uses only the
matched entry's DN to rebind the user; the bound identity is the login as a
display/log label, and the store is read with `POSTERN_API_TOKEN`, not the
directory identity. So for the IMAP proxy a successful BIND is the whole pass
criterion -- simple-bind is sufficient and has no own-`mail`-read dependency.
`LDAP_SEARCH_FILTER`/`LDAP_MAIL_ATTR` still matter to the proxy only for the
`mail-users` authorization gate, not for identity.

**TLS is mandatory on BOTH doors for direct-LDAP.** The relay and the IMAP proxy
each refuse a plaintext `ldap://10.1.1.2:389` bind unless `LDAP_STARTTLS=true` (or
an `ldaps://` URL). A bind carries the password, so it never crosses cleartext.
That is why direct-LDAP on the fleet is gated on the section 6 work (636 or
StartTLS on the outpost) for BOTH doors, while PAM (section 3a) needs none of it.

Failover: list both directories where the client supports it
(`ldaps://dischord.internal:636 ldaps://fugazi.internal:636`); the current Go
backend dials a single `LDAP_URL`, so fleet HA for direct-LDAP is a follow-up.

## 5c. Shared env namespace (cross-component contract)

The Go relay (`relay/config.go`) and the Python IMAP proxy mirror the SAME env-var
names, so these names ARE the contract. Deploy EnvironmentFiles MUST use them
verbatim; do not rename per component.

| Env knob | Read by | Meaning |
|---|---|---|
| `AUTH_BACKEND` (Go) / `POSTERN_IMAP_AUTH_MODE` (Python) | both | mode selector: `native`/`ldap`/`system` (Go), `token`/`fixed`/`ldap`/`pam` (Python). Proxy-local name differs because the Python proxy also has token/fixed modes. |
| `AUTH_SYSTEM_PAM_SERVICE` | both | PAM service name. Value: **`postern`**. |
| `AUTH_SYSTEM_DOMAIN` | Go (PAM) | bound identity domain. Value: **`skyphusion.org`**. |
| `POSTERN_SMTP_AUTH_URL` | Go (native) | worker `/api/smtp-auth` endpoint (native backend). |
| `POSTERN_TRANSPORT_TOKEN` | Go | transport-seam bearer (native auth + inbound). |
| `POSTERN_SEND_TOKEN` / `POSTERN_SEND_URL` | Go (submission) | worker `/api/send` hand-off + its mailbox token. |
| `POSTERN_API_TOKEN` | Python proxy | the proxy's per-function **store-read** service token (in `ldap`/`pam` mode). |
| `POSTERN_API_URL` | Python proxy | the Postern store origin the proxy reads. |
| `LDAP_URL` | both | `ldap://10.1.1.2:389` (+ `10.1.1.3` failover); `ldaps://dischord.internal:636` when TLS is provisioned. |
| `LDAP_STARTTLS` | both | upgrade an `ldap://` conn before binding (needs section 6). |
| `LDAP_TLS_CA` | Go (today); Python (follow-on) | PEM CA bundle to trust the directory cert; when set it is the ONLY trust anchor (an exact pin, NOT added to the system roots). The crew-ownable alternative to provisioning 636 + a chained cert (section 6): pin the outpost's existing self-signed CA, no IdP mutation. Strict verification against a pinned root, never an insecure-skip. |
| `LDAP_TLS_SERVER_NAME` | Go (today); Python (follow-on) | name verified against the cert SANs; set when `LDAP_URL` dials an IP (e.g. `10.1.1.2`) but the cert names a host. Defaults to the `LDAP_URL` host. Required with `LDAP_TLS_CA` when the dialed host is not on the cert (go-ldap's StartTLS does not derive it). |
| `LDAP_TLS_PIN_SHA256` | Go (today); Python (follow-on) | exact-leaf SHA-256 pin (hex, colons optional, any case), SAN-independent. THE mechanism for Authentik's default outpost cert (bare-`*` SAN, unverifiable by CA-pin). A NON-secret public value (plain env, not a swarm secret). Mutually exclusive with `LDAP_TLS_CA`. Under the hood: `InsecureSkipVerify` + an exact-leaf check = stricter than a CA, not a bypass. |
| `LDAP_BIND_DN_TEMPLATE` | both | simple-bind DN template: **`cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io`**. |
| `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD` | both | search+bind service account DN + password. DN: **`cn=postern-mail-ro,ou=users,dc=ldap,dc=goauthentik,dc=io`** (staged). |
| `LDAP_SEARCH_BASE` | both | **`ou=users,dc=ldap,dc=goauthentik,dc=io`**. |
| `LDAP_SEARCH_FILTER` | both | **`(&(mail=%s)(memberOf=cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io))`** (single `%s`). |
| `LDAP_MAIL_ATTR` | both | **`mail`**. |
| `LDAP_TIMEOUT` | both | integer **seconds**, default **`10`**; bounds the directory connect AND every bind/search. `0` disables (no timeout). Symmetric across both doors: Go relay sets the `net.Dialer` timeout + conn read deadline (`relay/auth_ldap.go`); Python proxy sets `connect_timeout` + `receive_timeout` (`imap/posternimap/auth.py`). |

Crew-secrets storage labels are per-function and may differ from the env knob; the
deploy maps label -> knob in the 0600 EnvironmentFile. The only such mapping today:
crew-secrets `POSTERN_LDAP_BIND_PASSWORD` (labelled, direct-LDAP only) is written as
`LDAP_BIND_PASSWORD=` in the file. `POSTERN_API_TOKEN`, `POSTERN_SEND_TOKEN`, and
`POSTERN_TRANSPORT_TOKEN` are stored and consumed under the same name.

Timeouts: the Python proxy has `POSTERN_API_TIMEOUT` (store API). `LDAP_TIMEOUT`
(integer seconds, default `10`, `0` disables) bounds the directory auth path and is
implemented on BOTH doors, keeping connect/bind/search bounded symmetrically: Go
relay (`relay/config.go` + `relay/auth_ldap.go`) and Python proxy
(`imap/posternimap/config.py` + `imap/posternimap/auth.py`). The Python side rejects
a negative value (`LDAP_TIMEOUT must be >= 0`).

## 6. TLS-to-directory (only for direct-LDAP on the fleet)

The outpost publishes `10.1.1.2:389` (plaintext) only, and the direct-LDAP backend
requires TLS. There are two ways to satisfy that; the first is crew-ownable today.

### 6a. Pin the directory cert in the Go door (crew-ownable, no IdP mutation) -- BUILT

Authentik's LDAP outpost serves StartTLS on 389 with its DEFAULT self-signed cert:
`CN=authentik default certificate`, and its ONLY SAN is the bare wildcard `DNS:*`.
That SAN is the deciding constraint. In modern Go (verified on 1.26) a wildcard must
be the left-most label of a `>=2`-label name (`*.example`); a BARE `*` matches no DNS
name and is not an IP SAN. So `crypto/tls` hostname verification fails against this
cert under EVERY `LDAP_TLS_SERVER_NAME` (single-label, multi-label, or IP), and an
empty ServerName is not allowed without skipping verification. **The CA-pin
(`LDAP_TLS_CA` + `LDAP_TLS_SERVER_NAME`) therefore cannot verify this exact cert.**

The door-side mechanism for the default cert is the **fingerprint-pin**: pin the
EXACT leaf by its SHA-256, which is SAN-independent.

1. Capture the leaf fingerprint -- a NON-secret public value, so it is a plain env,
   not a swarm secret:
   `openssl s_client -connect 10.1.1.2:389 -starttls ldap </dev/null 2>/dev/null | openssl x509 -fingerprint -sha256 -noout`
2. Set `LDAP_URL=ldap://10.1.1.2:389` + `LDAP_STARTTLS=true` and
   `LDAP_TLS_PIN_SHA256=<the fingerprint>` (colon-separated or bare hex, any case).
   Leave `LDAP_TLS_CA` unset (the two are mutually exclusive; setting both is a
   startup error).

Under the pin the door sets `InsecureSkipVerify=true` and installs a
`VerifyPeerCertificate` callback that constant-time-compares the presented leaf's
SHA-256 to the pin. **`InsecureSkipVerify` here is an EXACT PIN, not a bypass:** it
trusts one specific certificate (stricter than CA verification, which trusts anything
a CA signed) and is MITM-resistant -- a swapped cert fails the match. A gosec G402 or
CodeQL `InsecureSkipVerify` finding at that call site is a JUSTIFIED suppression
(annotated `#nosec G402` in `relay/auth_ldap.go`), expected, not a real issue.

**Threat model.** The door dials dischord's own `:389` from a container ON dischord
(same box, same VLAN), so this verification is belt-and-suspenders hardening, not
load-bearing against a realistic MITM. The fingerprint-pin is cheap and strictly
stronger than the IMAP proxy's `CERT_NONE` (#153), so it is the go-live posture (and
that door can adopt the same pin as a follow-on).

**Re-pin runbook (the pinning tradeoff).** A leaf pin breaks if Authentik
REGENERATES its default cert (expiry, rotation, reinstall): the new leaf has a new
SHA-256, the pin stops matching, and 587 LDAP auth fails closed. This is DOOR-SIDE
ONLY -- crew SSH rides the same outpost but does not pin, so it is unaffected.
Recover (no code change, no IdP touch):
1. Re-capture the leaf fingerprint (the `openssl ... -fingerprint -sha256` above).
2. Update `LDAP_TLS_PIN_SHA256` in the 587 door's env and roll the service
   (`docker service update --force postern-submission_postern-submission`).
This fragility is the accepted tradeoff for pinning the default cert without an IdP
mutation; 6b (a properly-named cert) removes it for both doors.

For a directory cert with a USABLE name (the future 6b path), use the CA-pin instead:
`LDAP_TLS_CA=/run/secrets/postern_ldap_ca` (the PEM becomes the ONLY trust anchor) +
`LDAP_TLS_SERVER_NAME=<the cert name>`. Strict verification against a private root,
never an insecure-skip; no relay code change.

### 6b. Provision 636 + a chained cert (later hardening, retires #87/#153) -- GATED

1. Issue an internal cert with SAN `dischord.internal` (+ `10.1.1.2`); a real cert
   via DNS-01 against the Cloudflare DNS API for an internal name is cleanest.
2. Bind a certificate-keypair to the Authentik LDAP provider and publish 636 (or
   enable StartTLS on 389): an edit to `system/stacks/dischord/auth/` (compose port
   map + provider config) -- an **IdP-stack change, supervised**.
3. Point `LDAP_URL` at `ldaps://dischord.internal:636`; no relay code change.

6b is the cleaner long-term shape (it retires #87/#153 for BOTH doors) but is a
Conrad-gated IdP mutation; 6a unblocks the Go door's Wave-B logins without it. PAM
(section 3a) needs neither.

## 7. Token / secret inventory (by function, by location)

Every secret each component holds, labelled by function. All values are
age-encrypted in **crew-secrets** (PR, never direct-push) and projected to a
root-`0600` EnvironmentFile at deploy. None is ever committed in cleartext.
Presence-check with `${VAR:+SET}` only.

| Secret (env var) | Function | Held by | Stored | Gate |
|---|---|---|---|---|
| `POSTERN_TRANSPORT_TOKEN` | transport seam (`/ingest`, `/dispatch`, native `/api/smtp-auth`) | relay (inbound + native submission) | crew-secrets -> `/etc/...env` 0600 | exists |
| `POSTERN_SEND_TOKEN` | submission hand-off to worker `/api/send` (DKIM-sign + store) | 587 submission server | crew-secrets -> `/etc/postern-submission.env` 0600 | exists; holds a `send`-scoped value once provisioned (worker `POSTERN_API_TOKEN_SEND`, #85) |
| `POSTERN_API_TOKEN` (store-read) | IMAP proxy reads the store (`/api/messages`, `/search`) in `ldap`/`pam` mode | postern-imap | crew-secrets -> `/etc/postern-imap.env` 0600 | exists; holds a `read`-scoped value once provisioned (worker `POSTERN_API_TOKEN_READ`, #85) |
| `POSTERN_LDAP_BIND_PASSWORD` | scoped read-only LDAP search bind (`cn=postern-mail-ro`) | relay + proxy, **direct-LDAP only** | crew-secrets (staged) | section 8, gated |
| `SUBMISSION_TLS_CERT` / `_KEY` | public TLS for the submission hostname | 587 submission server | crew-secrets / cert store (staged) | **gated** (exposure) |

**Worker-side scope secrets (#85).** The two consumer env vars above present a
token VALUE; the inbound worker classifies that value by which of ITS secrets it
equals. The worker secrets (set via `wrangler secret put`) define the scopes:

| Worker secret | Scope | Reaches |
|---|---|---|
| `POSTERN_API_TOKEN` (or `RELAY_TOKEN`) | `both` | read + send + credential-admin (the egalitarian single-key default) |
| `POSTERN_API_TOKEN_READ` | `read` | `GET /api/messages`/`search`/`threads`/`.../attachments/...` only |
| `POSTERN_API_TOKEN_SEND` | `send` | `POST /api/send`/`reply` only (un-bound From) |
| `POSTERN_SEND_IDENTITIES` (registry, #28) | `send` + bound From | `POST /api/send`/`reply` as the token's OWN identity |

Unknown token -> `401`; known token outside its scope -> `403`. Credential-admin
(`/api/admin/smtp-credentials`) is reachable ONLY by a `both` token. Provisioning
the two scoped secrets is OPTIONAL and non-breaking: with only `POSTERN_API_TOKEN`
set, every consumer keeps using that one `both` value exactly as before.

**Per-identity send registry (#28) -- one scope, many identities.** The scope split
above bounds a leaked token to a FUNCTION; the registry adds WHO. The optional worker
secret `POSTERN_SEND_IDENTITIES` is a JSON map of `sha256hex(token) -> { from, displayName? }`:
many send-scoped tokens, each the SAME `send` scope but a DISTINCT, authoritative From.
The worker hashes the presented Bearer, looks it up, and on `/api/send` + `/api/reply`
OVERRIDES the From to the bound identity (a token cannot send as anyone else). It stores
token HASHES, never raw tokens. Additive and back-compat: the static
`POSTERN_API_TOKEN_SEND` keeps working as the un-bound send token (From falls back to the
caller / `DEFAULT_FROM`). Full contract, JSON shape, and the operator registration
recipe: **`docs/SEND-IDENTITIES.md`**.

**Token custody after the split (RATIFIED, Mackaye 2026-06-27).** Once the scoped
values are provisioned (#85), the `both` `POSTERN_API_TOKEN` lives worker-side and in
crew-secrets **minter-tier ONLY** -- never in any box EnvironmentFile. Each box holds
ONLY its scoped value: the IMAP proxy and the Postern MCP hold the `read` value, the
587 submission server holds the `send` value. The `both` token is reserved for
credential-admin ops (`/api/admin/smtp-credentials`, the reindex route) run by
Mackaye/crew, never projected onto a box -- so a leaked box EnvironmentFile is bounded
to exactly one scope.

**Posture change to bake in (per #75).** The IMAP proxy moves from "holds no
secret" (token mode: each session carries the user's own token) to "holds a
per-function service token" (`ldap`/`pam` mode: the proxy authenticates the human
against the directory, then reads the store with its OWN labelled service token).
This must be stated in `imap/DEPLOY.md` (it is).

**v1 reality vs end state (honest).** Postern is one mailbox, and the egalitarian
single-key posture (one `both` token sends AND receives) is a first-class supported
mode, not a deficiency. Worker-side per-function scoping landed in #85, so the
"store-read" and "send" functions CAN now be two distinct, independently-rotatable
secrets (`POSTERN_API_TOKEN_READ` / `POSTERN_API_TOKEN_SEND`). Until an operator
provisions those distinct values, every consumer still presents the SAME single
`POSTERN_API_TOKEN` (`both`) value -- so do not pretend the two labels are isolated
in a deployment that has not provisioned the scoped secrets; they share one value
until it is split. The split is optional hardening to bound a leaked credential's
blast radius (a stolen read-door token cannot send), never a per-principal or
human-vs-agent two-tier default.

## 8. What is staged / gated for Conrad (do NOT do unattended)

- Provision public **TLS certs** for the mail hostname(s); **open 587/993 in ufw**;
  add **public DNS A records** for the mail host. (Exposure flip, #75/#76/#77 HARD
  GATE.)
- Create the scoped `cn=postern-mail-ro` LDAP bind account in Authentik
  (blueprint + secret) -- only needed for direct-LDAP; PAM does not need it.
- Provision **636 + a cert** on the Authentik LDAP provider (section 6) -- only for
  direct-LDAP on the fleet.
- The #74 deploy-drift fix (inbound rename + `postern.skyphusion.org` custom
  domain): a downtime gate on live email.

Everything else (PAM file, hardened units, deploy runbooks, the contract, loopback
build + test) is buildable/testable now without touching exposure or the IdP.
