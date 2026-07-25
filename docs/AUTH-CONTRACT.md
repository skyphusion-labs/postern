# Unified mail-auth contract (IMAP read + SMTP submission, one login)

Status: **contract / design of record, portable**. This document is the single
source both door consumers read from (the Go `relay/` submission server and the
Python `imap/` proxy), so a binding never gets invented per-component. It is
written for ANY operator: every value below is a placeholder (`example.org`,
`directory.example.internal`, RFC 5737 addresses) that you substitute for your
own. The reference deployment's directory-specific record (verified instance
facts, staged rollout steps) is maintained out-of-tree in the operators' private
infrastructure repository, with the same section skeleton as this file.

Section numbers are load-bearing: code comments and sibling docs cite them
("section 5b", "section 7"). Do not renumber.

## 1. The requirement

An external mail client (Thunderbird, Apple Mail, mutt, mobile) configures **one
username and one password**, and it authenticates **both** doors:

- **Read** door: IMAP, served by the `imap/` proxy (`posternimap`).
- **Send** door: SMTP submission on 587 (STARTTLS) and optionally 465 (implicit
  TLS), served by the Go `relay/` binary in its submission role. The port set is
  the operator's `SUBMISSION_LISTENERS` choice; edge exposure of any port is an
  operator decision (hosting-provider port policy varies), not a daemon
  constraint.

Both doors verify the **same** end-user credential against the **same**
directory, so a credential can never drift between protocols. Pointing them at
the directory that already backs your other logins (SSH, SSO) gives one identity
per human.

Postern also has directory-free auth modes (the worker-native
`smtp_credentials` store via `/api/smtp-auth`, and the IMAP proxy's
`token`/`fixed` modes); this contract covers the directory-backed one-login
model. Webmail's cookie-session door is section 7's last paragraph.

## 2. The directory (what postern needs from it)

Any LDAP directory (or a PAM stack that reaches one) works if it provides:

| Need | Meaning |
|---|---|
| A per-user bind path | a DN template the door can bind as, e.g. `cn=<login>,ou=users,...` |
| A mail attribute | the user's full address (`mail`); the submission door binds From to it |
| An authorization group | membership gates "this account may use mail" (e.g. `cn=mail-users,ou=groups,...`) |
| Group membership on self-read | the bound user can read its OWN entry's group attribute (`memberOf`) |

Worked example (the default DIT shape of an Authentik LDAP outpost; substitute
your directory's):

| Fact | Example value |
|---|---|
| LDAP URI | `ldap://directory.example.internal:389` (192.0.2.10; failover 192.0.2.11) |
| Base DN | `dc=ldap,dc=goauthentik,dc=io` |
| User DN shape | `cn=<username>,ou=users,dc=ldap,dc=goauthentik,dc=io` |
| Login attributes | `cn` (short username), `mail` (full address) |
| Bound-identity attribute | `mail` (e.g. `ada@example.org`) |
| Mailbox authorization group | `cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io` |

Two rules that are contract, not taste:

- **Do not reuse an admin-grade or infrastructure-critical bind account as a
  mail bind account.** Coupling mail to a credential your SSH/nss stack depends
  on violates per-function-key discipline and widens blast radius. (Under the
  direct-bind model in 5b no service account exists at all.)
- **Membership in the authorization group is the gate** for "this account may
  use mail". Both doors enforce it (sections 4/5); a valid directory password
  for a non-member still cannot open a mail door. Adding a mailbox user = adding
  them to the group.

## 3. The two backends

Both consumers can authenticate a user two ways. They are equivalent in result
(same directory, same bound identity); they differ in the path to it.

### 3a. PAM (`system` mode) -- when the host already speaks to the directory

If the box already runs an LDAP-backed PAM stack (e.g. `nslcd` + `pam_ldap`
chained in `common-auth`), PAM auth flows **process -> pam_ldap -> nslcd ->
LDAP bind**. The PAM stack already holds the bind credential, so:

- **No new mail bind account** is needed (the PAM stack binds, not Postern).
- **No TLS-to-directory work** is needed: the door inherits whatever posture the
  host's PAM/LDAP stack already has.

This is the recommended backend on a host that is already directory-joined. The
PAM service file is `/etc/pam.d/postern` (section 4).

Hardening note (load-bearing): a hardened unit running `DynamicUser` +
`NoNewPrivileges=yes` is compatible with the **pam_ldap** path (it only connects
to the `nslcd` socket; no setuid, no `/etc/shadow` read). It is **not**
compatible with verifying a purely-local `/etc/shadow` password (that needs the
setuid `unix_chkpwd` helper, which `NoNewPrivileges` blocks). Keep mail accounts
in the directory; do not "fix" a local-shadow login by dropping
`NoNewPrivileges`.

### 3b. Direct LDAP (`ldap` mode) -- portable / standalone

The Go relay (`auth_ldap.go`) and the Python proxy can bind the directory
directly (pure-Go `go-ldap`; Python `ldap3`). This is the right path for a host
with no PAM/LDAP stack. The LDAP backend **mandates TLS** (`ldap auth requires
TLS`); if your directory offers plaintext 389 only, section 6 covers the two
ways to close that gap. The env contract is section 5b/5c.

## 4. PAM service file (`/etc/pam.d/postern`)

Keep it in your configuration management (root 0644). Both doors name this
service:

- Go submission: `AUTH_SYSTEM_PAM_SERVICE=postern` (default).
- Python IMAP `pam` mode: the same service name.

The shape: gate on `pam_succeed_if user ingroup mail-users`, then delegate to
the system `common-auth` / `common-account` (which is where pam_ldap lives).
Gating on the group inside the PAM service means a valid directory password for
a non-mail account still cannot open a mail door.

## 5. The exact bindings each consumer reads

### 5a. PAM path

Go submission server (`relay/`, built `-tags pam`):

```
AUTH_BACKEND=system
AUTH_SYSTEM_DOMAIN=example.org         # bound identity = <login>@example.org
AUTH_SYSTEM_PAM_SERVICE=postern        # -> /etc/pam.d/postern
```

Python IMAP proxy (`imap/`, `pam` mode): same PAM service `postern`, same
resulting identity. The proxy still needs the store-read service token
(section 7).

Login: the user types their **short username** (`ada`) or full address; PAM
resolves it. Bound/From identity = `<login-localpart>@AUTH_SYSTEM_DOMAIN`.

### 5b. Direct-LDAP path: direct-bind + self-read (the model of record)

The door binds DIRECTLY to the directory as the authenticating user
(`cn=<login>,ou=users,...` with the user's submitted password), and auth success
IS bind success. There is **no privileged service account**. The door then
**self-reads** the bound user's own entry (base scope, the user's own DN) for:

- `mail` -- the authenticated From identity (the relay enforces `From == mail`).
- `memberOf` -- the **authorization-group gate** (`LDAP_REQUIRE_GROUP`).

The gate is **fail-closed**: if the self-read errors, returns no entry, or
returns an entry NOT carrying the required group, the login is DENIED. Login is
the **short username**, substituted into `LDAP_BIND_DN_TEMPLATE` exactly once
(`fmt.Sprintf`, one `%s`).

Why this model: some directories (verified on Authentik 2024.12: no
`search_group`, only `is_superuser` confers full search) give a low-privilege
account no way to run a search+bind, but DO let a bound non-superuser read its
own entry -- including its **complete** group set on a base-scope self-read.
The whole model rests on that property. Validate it live at deploy (a real send
through the door by a group member is the acceptance test); if a directory
change ever stops returning the group attribute on self-read, the gate fails
closed and logins stop until the model is revisited -- deny, never estate.

```
AUTH_BACKEND=ldap                       # (Go) ; POSTERN_IMAP_AUTH_MODE=ldap (Python)
LDAP_URL=ldap://directory.example.internal:389   # TLS mandatory, see section 6
LDAP_STARTTLS=true
LDAP_TLS_PIN_SHA256=<leaf SHA-256>      # or LDAP_TLS_CA; section 6. Non-secret.
LDAP_BIND_DN_TEMPLATE=cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io
LDAP_REQUIRE_GROUP=cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io
LDAP_MAIL_ATTR=mail                     # default
LDAP_GROUP_ATTR=memberOf                # default
```

No `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD` / `LDAP_SEARCH_*`: those configured the
retired search+bind path and are GONE from BOTH doors (removed from the Go
relay; the Python proxy refuses to start if any of them is set, so an old
EnvironmentFile fails loud rather than silently changing auth -- #182).

**Per-door difference.** The `mail`-attribute resolution is the **SMTP relay's**
need: it uses `mail` as the authenticated From and enforces `From == mail`, so
it MUST read it (`LDAP_MAIL_ATTR` is relay-only). The **IMAP proxy does NOT read
`mail`** for identity: a successful BIND is its pass criterion and the store is
read with `POSTERN_API_TOKEN`, not the directory identity. The group gate
applies to BOTH doors identically (#182): the same fail-closed `memberOf`
self-read check, implemented in `relay/auth_ldap.go` (selfRead) and
`imap/posternimap/auth.py` (LDAPBinder._group_gate), byte-symmetric semantics.

**TLS is mandatory on BOTH doors for direct-LDAP.** Each refuses a plaintext
`ldap://` bind unless `LDAP_STARTTLS=true` (or an `ldaps://` URL). A bind
carries the password, so it never crosses cleartext. PAM (3a) needs none of
this.

Failover: the current Go backend dials a single `LDAP_URL`; HA across a second
directory endpoint is a follow-up.

## 5c. Shared env namespace (cross-component contract)

The Go relay (`relay/config.go`) and the Python IMAP proxy mirror the SAME
env-var names, so these names ARE the contract. Deploy EnvironmentFiles MUST use
them verbatim; do not rename per component.

| Env knob | Read by | Meaning |
|---|---|---|
| `AUTH_BACKEND` (Go) / `POSTERN_IMAP_AUTH_MODE` (Python) | both | mode selector: `native`/`ldap`/`system` (Go), `token`/`fixed`/`ldap`/`pam` (Python). Proxy-local name differs because the Python proxy also has token/fixed modes. |
| `AUTH_SYSTEM_PAM_SERVICE` | both | PAM service name. Value: **`postern`**. |
| `AUTH_SYSTEM_DOMAIN` | Go (PAM) | bound identity domain (your mail domain, e.g. `example.org`). |
| `POSTERN_SMTP_AUTH_URL` | Go (native) | worker `/api/smtp-auth` endpoint (native backend). |
| `POSTERN_TRANSPORT_TOKEN` | Go | transport-seam bearer (native auth + inbound). |
| `POSTERN_SEND_TOKEN` / `POSTERN_SEND_URL` | Go (submission) | worker `/api/send` hand-off + its mailbox token. |
| `POSTERN_API_TOKEN` | Python proxy | the proxy's per-function **store-read** service token (in `ldap`/`pam` mode). |
| `POSTERN_API_URL` | Python proxy | the Postern store origin the proxy reads. |
| `LDAP_URL` | both | the directory endpoint (`ldap://directory.example.internal:389`, or `ldaps://...:636` when TLS is provisioned). |
| `LDAP_STARTTLS` | both | upgrade an `ldap://` conn before binding (section 6). |
| `LDAP_TLS_CA` | both | PEM CA bundle to trust the directory cert; when set it is the ONLY trust anchor (an exact pin, NOT added to the system roots). The alternative to provisioning 636 + a chained cert (section 6): pin the directory's existing self-signed CA, no IdP mutation. Strict verification against a pinned root, never an insecure-skip. |
| `LDAP_TLS_SERVER_NAME` | both | name verified against the cert SANs; set when `LDAP_URL` dials an IP but the cert names a host. Go: defaults to the `LDAP_URL` host; required with `LDAP_TLS_CA` when the dialed host is not on the cert (go-ldap's StartTLS does not derive it). Python: an extra accepted cert name in CA mode (ldap3 otherwise checks the dialed host). |
| `LDAP_TLS_PIN_SHA256` | both | exact-leaf SHA-256 pin (hex, colons optional, any case), SAN-independent. THE mechanism for a cert whose SANs cannot verify (section 6a). A NON-secret public value (plain env, not a secret). Mutually exclusive with `LDAP_TLS_CA`. Under the hood: verification IS the exact-leaf hash check, run BEFORE any credential flows (Go: `InsecureSkipVerify` + `VerifyPeerCertificate`; Python: `CERT_NONE` channel + a pre-bind leaf-hash check) = stricter than a CA, not a bypass. Neither TLS knob set = the channel is encrypted but UNAUTHENTICATED; both doors keep working (back-compat) and the Python door logs a loud startup warning. |
| `LDAP_BIND_DN_TEMPLATE` | both | **direct-bind** DN template (REQUIRED for `ldap` mode): single `%s` = the short login. |
| `LDAP_REQUIRE_GROUP` | both | the group DN the bound user must carry in `LDAP_GROUP_ATTR` on self-read = the authorization gate. Empty = no gate. Fail-closed. |
| `LDAP_GROUP_ATTR` | both | the attribute listing the user's groups for the gate. Default **`memberOf`**. |
| `LDAP_MAIL_ATTR` | Go only | the self-read identity attribute. Default **`mail`** (the relay enforces `From == mail`). The IMAP proxy does not read `mail` (5b) and ignores this knob. |
| `LDAP_TIMEOUT` | both | integer **seconds**, default **`10`**; bounds the directory connect AND every bind/search. `0` disables. Symmetric across both doors: Go relay sets the `net.Dialer` timeout + conn read deadline (`relay/auth_ldap.go`); Python proxy sets `connect_timeout` + `receive_timeout` (`imap/posternimap/auth.py`), rejects a negative value. |

Secret-store labels are per-function and may differ from the env knob; the
deploy maps label -> knob in a root-0600 EnvironmentFile. Under direct-bind the
LDAP path carries NO secret of its own (no bind password; the leaf pin is a
non-secret public value). The Python proxy additionally has
`POSTERN_API_TIMEOUT` for the store API.

## 6. TLS-to-directory (only for direct-LDAP)

If your directory publishes plaintext 389 only and the direct-LDAP backend
requires TLS, there are two ways to satisfy it. The first needs no IdP change.

### 6a. Pin the directory cert in the door (no IdP mutation)

Some directories serve StartTLS with a DEFAULT self-signed cert whose SANs
cannot pass hostname verification (the known case: Authentik's LDAP outpost
default cert has the single SAN `DNS:*`; in modern Go a bare `*` matches no DNS
name and is not an IP SAN, so `crypto/tls` verification fails under EVERY
`LDAP_TLS_SERVER_NAME`, and the CA-pin cannot verify that cert either).

The door-side mechanism for such a cert is the **fingerprint-pin**: pin the
EXACT leaf by its SHA-256, which is SAN-independent.

1. Capture the leaf fingerprint -- a NON-secret public value, so it is a plain
   env, not a managed secret:
   `openssl s_client -connect directory.example.internal:389 -starttls ldap </dev/null 2>/dev/null | openssl x509 -fingerprint -sha256 -noout`
2. Set `LDAP_URL` + `LDAP_STARTTLS=true` and `LDAP_TLS_PIN_SHA256=<fingerprint>`
   (colon-separated or bare hex, any case). Leave `LDAP_TLS_CA` unset (the two
   are mutually exclusive; setting both is a startup error).

Under the pin the door sets `InsecureSkipVerify=true` and installs a
`VerifyPeerCertificate` callback that constant-time-compares the presented
leaf's SHA-256 to the pin. **`InsecureSkipVerify` here is an EXACT PIN, not a
bypass:** it trusts one specific certificate (stricter than CA verification,
which trusts anything a CA signed) and is MITM-resistant -- a swapped cert fails
the match. A gosec G402 or CodeQL `InsecureSkipVerify` finding at that call site
is a JUSTIFIED suppression (annotated `#nosec G402` in `relay/auth_ldap.go`),
expected, not a real issue.

**The pinning tradeoff.** A leaf pin breaks if the directory REGENERATES its
cert (expiry, rotation, reinstall): the new leaf has a new SHA-256, the pin
stops matching, and directory auth fails closed. Recovery is config-only:
re-capture the fingerprint (step 1) and roll the door with the new
`LDAP_TLS_PIN_SHA256`. This fragility is the accepted tradeoff for pinning a
default cert without an IdP mutation; 6b removes it.

For a directory cert with a USABLE name, use the CA-pin instead:
`LDAP_TLS_CA=<PEM path>` (the PEM becomes the ONLY trust anchor) +
`LDAP_TLS_SERVER_NAME=<the cert name>`. Strict verification against a private
root, never an insecure-skip; no code change.

### 6b. Provision 636 + a chained cert (the cleaner long-term shape)

1. Issue a cert with a SAN naming the directory host (an internal name via
   DNS-01 is cleanest).
2. Bind the keypair to the directory's LDAP endpoint and publish 636 (or enable
   StartTLS on 389). This is an IdP configuration change; treat it as a
   supervised change, not routine.
3. Point `LDAP_URL` at `ldaps://directory.example.internal:636`; no door code
   change.

PAM (3a) needs neither path.

## 7. Token / secret inventory (by function)

Every secret each component holds, labelled by function. Store values in an
encrypted secret store and project them to root-0600 EnvironmentFiles at deploy;
never commit one in cleartext. Presence-check with `${VAR:+SET}` only (a
`${VAR:-...}` default echoes the value).

| Secret (env var) | Function | Held by |
|---|---|---|
| `POSTERN_TRANSPORT_TOKEN` | transport seam (`/ingest`, `/dispatch`, native `/api/smtp-auth`) | relay (inbound + native submission) |
| `POSTERN_SEND_TOKEN` | submission hand-off to worker `/api/send` (DKIM-sign + store) | submission door (587/465) |
| `POSTERN_API_TOKEN` (store-read) | IMAP proxy reads the store in `ldap`/`pam` mode | postern-imap |
| `POSTERN_API_TOKEN_DELETE` (store-delete) | IMAP proxy EXPUNGE only (`DELETE /api/messages/{id}`) | postern-imap |
| `POSTERN_API_TOKEN_IMAP` (service write) | identity-asserted Drafts + genuine APPEND import (`/api/imap/*`) | postern-imap |
| `SUBMISSION_TLS_CERT` / `_KEY` | public TLS for the submission hostname (587 + 465 share it) | submission door |

**Worker-side scope secrets (#85).** The consumer env vars above present a token
VALUE; the inbound worker classifies that value by which of ITS secrets it
equals. The worker secrets (set via `wrangler secret put`) define the scopes:

| Worker secret | Scope | Reaches |
|---|---|---|
| `POSTERN_API_TOKEN` | `both` | read + send + delete + credential-admin (the egalitarian single-key default) |
| `POSTERN_API_TOKEN_READ` | `read` | `GET /api/messages`/`search`/`threads`/`.../attachments/...` only |
| `POSTERN_API_TOKEN_SEND` | `send` | `POST /api/send`/`reply` only (un-bound From; drafts require a bound identity) |
| `POSTERN_API_TOKEN_DELETE` | `delete` | irreversible `DELETE /api/messages/{id}` only |
| `POSTERN_API_TOKEN_IMAP` | `imap` | `/api/imap/drafts*` and `/api/imap/import` only; the authenticated door asserts the account identity |
| `POSTERN_SEND_IDENTITIES` (registry, #28; a config VAR, not a secret -- hashes only) | `send` + bound From | send/reply and own-draft CRUD as the token's OWN identity |

The five STATIC slots each hold a **comma-separated SET of tokens** (#154):
entries are trimmed, empty entries ignored, and a bearer matching ANY member
resolves to that slot's scope. A single bare value (no comma) is a one-element
set -- the pre-#154 format, unchanged. The point is per-CONSUMER tokens within
one function: the IMAP door, the Postern MCP, and the webmail can each hold
their OWN `read` member, so rotating or revoking one never strands the others.
Matching stays constant-time per member with no early exit. A comma is therefore
not a valid character inside a token value. This format does NOT apply to
`POSTERN_SEND_IDENTITIES`: the registry is a JSON map with its own shape.

Unknown token -> `401`; known token outside its scope -> `403`. Credential-admin
(`/api/admin/smtp-credentials`) is reachable ONLY by a `both` token.
Provisioning the scoped secrets is OPTIONAL and non-breaking: with only
`POSTERN_API_TOKEN` set, every consumer keeps using that one `both` value
exactly as before.

**Per-identity send registry (#28) -- one scope, many identities.** The scope
split bounds a leaked token to a FUNCTION; the registry adds WHO. The optional
worker config var `POSTERN_SEND_IDENTITIES` (a var, not a secret: it stores
hashes, so it holds no credential and stays readable + mergeable) is a JSON map
of `sha256hex(token) -> { from, displayName? }`: many send-scoped tokens, each
the SAME `send` scope but a DISTINCT, authoritative From. The worker hashes the
presented Bearer, looks it up, and on `/api/send` + `/api/reply` OVERRIDES the
From to the bound identity (a token cannot send as anyone else). It stores token
HASHES, never raw tokens. Additive and back-compat: the static
`POSTERN_API_TOKEN_SEND` keeps working as the un-bound send token. Full
contract, JSON shape, and the operator registration recipe:
**`docs/SEND-IDENTITIES.md`**.

**Custody after the split.** Once scoped values are provisioned, keep the `both`
token OFF every door host: each box EnvironmentFile holds ONLY its scoped value
(the IMAP proxy and the MCP hold `read`, the submission server holds `send`),
and the `both` token is reserved for credential-admin operations run from the
operator's own environment -- so a leaked box EnvironmentFile is bounded to
exactly one scope.

**Posture note.** In `ldap`/`pam` mode the IMAP proxy moves from "holds no
secret" (token mode: each session carries the user's own token) to "holds a
per-function service token". Its README states this; keep your deploy notes
honest about it too.

**v1 reality vs end state (honest).** Postern is one mailbox, and the
egalitarian single-key posture (one `both` token sends AND receives) is a
first-class supported mode, not a deficiency. Until an operator provisions
distinct scoped values, every consumer presents the SAME single
`POSTERN_API_TOKEN` (`both`) value -- so do not pretend the labels are isolated
in a deployment that has not split them. The split is optional hardening to
bound a leaked credential's blast radius, never a per-principal or
human-vs-agent two-tier default.

**Webmail sessions (the third door).** Webmail can authenticate humans with a
cookie session minted from the worker-native `smtp_credentials` store
(`POST /api/session`; `WEBMAIL_AUTH_BACKEND` unset = OFF, `native` = explicit
operator opt-in). Sessions carry the caps `read`/`send`/`delete`, never admin; a
Bearer token always wins over a cookie on the same request; state-changing
session requests are CSRF-gated. Since #409 the mint carries the same
brute-force posture the two doors above do (`relay/throttle.go`,
`imap/posternimap/throttle.py`): keyed per-account counters, enumeration-safe,
fail-closed, backoff with temporary lockout, so no door undercuts the others'
throttles. The full session contract lives in `docs/CONTRACT.md` and
`docs/design/webmail-v2-contracts.md`; it composes with everything above without
changing it.

## 8. Staged exposure steps (operator-supervised)

Buildable and testable with no exposure: the PAM file, hardened units, loopback
builds, and every test in the tree. The steps that CHANGE YOUR EXPOSURE deserve
explicit supervision, in this order:

- Provision public **TLS certs** for the mail hostname(s).
- **Open the submission port(s) (587 and/or 465) and 993** at your firewall /
  edge.
- Add **public DNS records** for the mail host (and MX/SPF/DKIM/DMARC per
  `DEPLOY.md`).
- If using direct-LDAP with 6b: the IdP cert/port provisioning is its own
  supervised change.

Treat each as a deliberate flip with a rollback path, not a side effect of a
deploy.
