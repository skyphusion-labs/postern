"""Auth mapping: IMAP login -> a Postern API token (#32, expanded for #77).

A normal mail client uses ONE username+password for BOTH doors (IMAP receive +
SMTP send). The SMTP relay (relay/auth.go) already authenticates that credential
three ways via a pluggable AuthProvider; this module is the Python MIRROR so the
IMAP door authenticates the SAME credential the SAME ways. One credential, both
doors.

Five modes:

  token (default)
    The IMAP *password* IS the Postern API token. The username is a free label
    (use the mailbox address, e.g. agent@skyphusion.org) for display / logging.
    The token is validated live against the API at login (client.ping). The
    proxy stores no secret; every session carries the user's own token.

  fixed
    A single configured (username, token) pair. The operator puts the API token
    in the proxy's env (POSTERN_API_TOKEN) and picks a login password; a normal
    mail client then connects with username + password. Comparisons are
    constant-time.

  native / ldap / system   (the #77 parity modes)
    The proxy authenticates the USER -- against the worker POST /api/smtp-auth
    (native, the SAME endpoint the Go relay uses), an LDAP bind over TLS (ldap),
    or local Unix PAM (system) -- and then reads the store with a per-function
    SERVICE token it holds (POSTERN_API_TOKEN). The two steps are deliberately
    separate: authenticate-the-user is one collaborator (an injected callable),
    map-to-the-service-token is the other. A successful auth maps to
    Identity(username, service_token); a bad credential raises AuthError.

The credential decision is a pure function (`resolve_token`) so it is testable
without Twisted and without a live network: native/ldap/system verification is an
INJECTED callable (username, password) -> bool. The Twisted cred plumbing
(IRealm + ICredentialsChecker) wraps it and is only imported when the server runs;
the production verifiers (NativeVerifier / LDAPBinder / PAMAuthenticator) are
constructed lazily by build_portal so importing this module pulls in no optional
dependency (ldap3 / python-pam) and no network.
"""

from __future__ import annotations

import hmac
import json
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .client import PosternAuthError, PosternClient, PosternError, _UrllibTransport
from .config import SERVICE_TOKEN_MODES, Config, ConfigError

# An authenticator validates a (username, password) login for the service-token
# modes. True = authenticated, False = bad credential. It MAY raise
# AuthBackendError for an infra fault (the backend is misconfigured or
# unreachable), which the caller treats as a failed login but logs distinctly.
Authenticator = Callable[[str, str], bool]


@dataclass(frozen=True)
class Identity:
    """The result of a successful login: who, and the API token to act with."""

    username: str
    token: str


class AuthError(Exception):
    """Login was rejected (bad credentials)."""


class AuthBackendError(Exception):
    """The auth backend faulted (misconfig / unreachable), NOT a bad credential.

    Kept distinct from AuthError so the operator sees a real fault in the log
    rather than it masquerading as a wrong password. The IMAP checker still fails
    the login (never leaks whether a username exists), but logs this one.
    """


def _const_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def resolve_token(
    cfg: Config,
    username: str,
    password: str,
    *,
    verify: Optional["TokenVerifier"] = None,
    authenticate: Optional[Authenticator] = None,
) -> Identity:
    """Map an IMAP (username, password) to a Postern Identity, or raise AuthError.

    token / fixed modes: `verify` is an injected callable (token -> bool) so this
    is testable without a live API; in production it is a PosternClient.ping bound
    to the token. In token mode the token's validity IS the auth check; in fixed
    mode the username + password are checked constant-time first.

    native / ldap / system modes: `authenticate` is an injected callable
    (username, password) -> bool that verifies the USER against the relevant
    backend. On success the proxy reads the store with its per-function service
    token (cfg.service_token), so the result is Identity(username, service_token).
    The authenticate step and the service-token step stay cleanly separated.
    """
    if not username:
        raise AuthError("username required")

    if cfg.auth_mode == "fixed":
        assert cfg.fixed_username is not None and cfg.fixed_token is not None
        if not password:
            raise AuthError("password required")
        ok_user = _const_eq(username, cfg.fixed_username)
        ok_pass = _const_eq(password, cfg.fixed_token)
        # Compare both, then AND, so timing does not reveal which one failed.
        if not (ok_user and ok_pass):
            raise AuthError("invalid username or password")
        token = cfg.fixed_token
        if verify is not None and not verify(token):
            raise AuthError("Postern API rejected the token")
        return Identity(username=username, token=token)

    if cfg.auth_mode in SERVICE_TOKEN_MODES:
        # Step 1: authenticate the USER against the backend.
        if not password:
            raise AuthError("password required")
        if cfg.service_token is None:
            raise ConfigError(
                f"{cfg.auth_mode} auth mode requires a service token (POSTERN_API_TOKEN)"
            )
        if authenticate is None:
            raise ConfigError(
                f"{cfg.auth_mode} auth mode requires an authenticator (none supplied)"
            )
        if not authenticate(username, password):
            raise AuthError("authentication failed")
        # Step 2 (separate): act on the store with the per-function service token.
        return Identity(username=username, token=cfg.service_token)

    # token mode: the password is the API token.
    if not password:
        raise AuthError("password (Postern API token) required")
    token = password
    if verify is not None and not verify(token):
        raise AuthError("Postern API rejected the token")
    return Identity(username=username, token=token)


class TokenVerifier:
    """Validates a candidate token against the live Postern API (client.ping).

    Kept as a small class so the network dependency is injectable and the proxy
    can be unit-tested with a fake verifier. Never logs the token.
    """

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg

    def __call__(self, token: str) -> bool:
        client = PosternClient(self._cfg.api_url, token, timeout=self._cfg.api_timeout)
        return client.ping()


# --- native: validate against the worker POST /api/smtp-auth (#77) ------------
#
# The SAME endpoint the Go relay's native backend hits (relay/submit_client.go).
# Gated by the TRANSPORT token, not the API token: an API-token leak cannot forge
# the auth check and vice versa. Request {username, secret}; success is the worker
# returning {ok:true}. The transport is injectable so this is unit-testable with
# no network (mirrors client.PosternClient).


class NativeVerifier:
    """Authenticate a login via POST /api/smtp-auth (transport-token gated)."""

    def __init__(self, cfg: Config, transport: Any = None) -> None:
        if not cfg.smtp_auth_url or not cfg.transport_token:
            raise ConfigError("native auth needs POSTERN_SMTP_AUTH_URL and POSTERN_TRANSPORT_TOKEN")
        self._url = cfg.smtp_auth_url
        self._token = cfg.transport_token
        self._transport = transport or _UrllibTransport(cfg.api_timeout)

    def __call__(self, username: str, password: str) -> bool:
        if not username or not password:
            return False
        body = json.dumps({"username": username, "secret": password}).encode("utf-8")
        req = urllib.request.Request(self._url, data=body, method="POST")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        # urllib's default User-Agent trips Cloudflare error 1010; identify.
        req.add_header("User-Agent", "postern-imap")
        try:
            status, raw = self._transport(req)
        except PosternError as exc:  # network/transport failure reaching the worker
            raise AuthBackendError(f"smtp-auth unreachable: {exc}") from exc
        # 401 means OUR transport token is wrong (a proxy misconfig), not the
        # user's fault: surface it as a backend fault so it is logged, not a 535.
        if status == 401:
            raise AuthBackendError("smtp-auth rejected the transport token (proxy misconfig)")
        if status // 100 != 2:
            raise AuthBackendError(f"smtp-auth returned HTTP {status}")
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as exc:
            raise AuthBackendError(f"invalid JSON from smtp-auth: {exc}") from exc
        # Worker returns 200 {ok:false} on a bad credential (so the relay maps it
        # to SMTP 535); that is a clean auth failure here, not a backend fault.
        return bool(data.get("ok"))


# --- ldap: bind username/password against the directory over TLS (#77) --------
#
# Mirrors relay/auth_ldap.go: simple bind (LDAP_BIND_DN_TEMPLATE) or search+bind
# (service account searches for the user DN, then the user's password is bound to
# verify it). TLS is mandatory; a bind carries the password in the clear. ldap3
# is a pure-Python client (no libldap/C build step), so it is the dependency-light
# choice and is imported lazily so token/fixed/native need it never.


class LDAPBinder:
    """Authenticate a login by binding to the directory (ldap3, lazy import)."""

    def __init__(self, cfg: Config) -> None:
        if not cfg.ldap_url:
            raise ConfigError("ldap auth needs LDAP_URL")
        self._cfg = cfg

    def __call__(self, username: str, password: str) -> bool:
        # An empty password must never bind: many directories treat it as an
        # anonymous bind that SUCCEEDS, which would be an auth bypass.
        if not username.strip() or not password:
            return False

        try:
            import ldap3
            from ldap3.core.exceptions import LDAPException
            from ldap3.utils.conv import escape_filter_chars
            from ldap3.utils.dn import escape_rdn
        except ImportError as exc:  # pragma: no cover - exercised only without the extra
            raise AuthBackendError(
                "ldap auth mode needs the ldap3 package: pip install 'posternimap[ldap]'"
            ) from exc

        cfg = self._cfg
        use_ssl = cfg.ldap_url.lower().startswith("ldaps://")  # type: ignore[union-attr]
        try:
            # LDAP_TIMEOUT bounds connect (here) AND every bind/search (receive_timeout
            # on each Connection below), mirroring the Go relay's DialWithDialer +
            # SetTimeout. 0 -> None == no timeout (matches Go's zero-duration default).
            timeout = cfg.ldap_timeout or None
            server = ldap3.Server(
                cfg.ldap_url, use_ssl=use_ssl, get_info=ldap3.NONE, connect_timeout=timeout
            )
            if cfg.ldap_bind_dn_template:
                return self._simple_bind(ldap3, server, escape_rdn, username, password, timeout)
            return self._search_bind(
                ldap3, server, escape_filter_chars, username, password, timeout
            )
        except LDAPException as exc:
            raise AuthBackendError(f"ldap error: {exc}") from exc

    def _open(self, ldap3: Any, conn: Any) -> None:
        """StartTLS upgrade for an ldap:// connection before any credential flows."""
        cfg = self._cfg
        if cfg.ldap_starttls and cfg.ldap_url and cfg.ldap_url.lower().startswith("ldap://"):
            conn.open()
            if not conn.start_tls():
                raise AuthBackendError("ldap starttls failed")

    def _simple_bind(
        self, ldap3: Any, server: Any, escape_rdn: Any, username: str, password: str,
        timeout: Any = None,
    ) -> bool:
        dn = self._cfg.ldap_bind_dn_template % escape_rdn(username)
        conn = ldap3.Connection(server, user=dn, password=password, receive_timeout=timeout)
        self._open(ldap3, conn)
        return bool(conn.bind())

    def _search_bind(
        self, ldap3: Any, server: Any, escape_filter_chars: Any, username: str, password: str,
        timeout: Any = None,
    ) -> bool:
        cfg = self._cfg
        svc = ldap3.Connection(
            server, user=cfg.ldap_bind_dn, password=cfg.ldap_bind_password,
            receive_timeout=timeout,
        )
        self._open(ldap3, svc)
        if not svc.bind():
            raise AuthBackendError("ldap service-account bind failed")
        flt = cfg.ldap_search_filter % escape_filter_chars(username)
        svc.search(cfg.ldap_search_base, flt, attributes=[cfg.ldap_mail_attr])
        entries = svc.entries
        if len(entries) != 1:
            # 0 = no such user; >1 = ambiguous. Either way, do not authenticate.
            return False
        user_dn = entries[0].entry_dn
        # Bind the user's own password to verify it.
        user_conn = ldap3.Connection(server, user=user_dn, password=password, receive_timeout=timeout)
        self._open(ldap3, user_conn)
        return bool(user_conn.bind())


# --- system: authenticate against local Unix accounts via PAM (#77) -----------
#
# Mirrors relay/auth_system_pam.go: the PAM service name is configurable
# (AUTH_SYSTEM_PAM_SERVICE, default "postern"); "user" or "user@domain" both
# authenticate the local part. python-pam talks to libpam via ctypes (no C build
# step) and is imported lazily.


class PAMAuthenticator:
    """Authenticate a login against local Unix accounts via PAM (lazy import)."""

    def __init__(self, cfg: Config) -> None:
        self._service = cfg.pam_service

    def __call__(self, username: str, password: str) -> bool:
        if not username.strip() or not password:
            return False
        # Allow "user" or "user@domain"; PAM authenticates the local part.
        local = username.split("@", 1)[0]
        try:
            import pam
        except ImportError as exc:  # pragma: no cover - exercised only without the extra
            raise AuthBackendError(
                "system auth mode needs the python-pam package: pip install 'posternimap[pam]'"
            ) from exc
        authenticator = pam.pam()
        return bool(authenticator.authenticate(local, password, service=self._service))


def build_authenticator(cfg: Config) -> Authenticator:
    """Construct the production authenticator for a service-token auth mode.

    Imported lazily by build_portal so token/fixed never touch a verifier and the
    optional ldap3 / python-pam deps load only when their mode is selected.
    """
    if cfg.auth_mode == "native":
        return NativeVerifier(cfg)
    if cfg.auth_mode == "ldap":
        return LDAPBinder(cfg)
    if cfg.auth_mode == "system":
        return PAMAuthenticator(cfg)
    raise ConfigError(f"no authenticator for auth mode {cfg.auth_mode!r}")


# --- Twisted cred plumbing (imported lazily by the server) -------------------
#
# Implemented in build_portal so importing this module does not require Twisted;
# only running the server (or the integration test) pulls it in.


def build_portal(
    cfg: Config,
    verify: Optional[TokenVerifier] = None,
    authenticate: Optional[Authenticator] = None,
    throttle=None,
):
    """Build a twisted.cred Portal whose login() yields an IMAP IAccount.

    The checker turns IUsernamePassword into an Identity via resolve_token; the
    realm turns the Identity into a PosternAccount (the IMAP IAccount). Returns a
    twisted.cred.portal.Portal.

    `throttle` is the brute-force throttle (#105); None builds one from cfg. It is
    per-portal (== per-process), matching the relay's per-process model.
    """
    from twisted.cred import checkers, credentials, error, portal
    from twisted.internet import defer
    from twisted.mail import imap4
    from twisted.python import log
    from zope.interface import implementer

    from .account import PosternAccount
    from .throttle import build_throttle, throttle_key

    if cfg.auth_mode in SERVICE_TOKEN_MODES:
        if authenticate is None:
            authenticate = build_authenticator(cfg)
    elif verify is None:
        verify = TokenVerifier(cfg)

    if throttle is None:
        throttle = build_throttle(cfg)

    @implementer(checkers.ICredentialsChecker)
    class _Checker:
        credentialInterfaces = (credentials.IUsernamePassword,)

        def requestAvatarId(self, creds):
            username = creds.username.decode() if isinstance(creds.username, bytes) else creds.username
            password = creds.password.decode() if isinstance(creds.password, bytes) else creds.password
            account = throttle_key(username)
            # Locked out (per-account or global cooldown): return the SAME generic
            # failure as a wrong password and do NOT touch the backend (invariant 2:
            # a throttled response is byte-identical to a normal auth failure).
            if not throttle.allow(account):
                return defer.fail(error.UnauthorizedLogin("bad credentials"))
            try:
                identity = resolve_token(cfg, username, password, verify=verify, authenticate=authenticate)
            except AuthError:
                # A genuine bad credential: this counts toward the lockout.
                throttle.fail(account)
                return defer.fail(error.UnauthorizedLogin("bad credentials"))
            except AuthBackendError as exc:
                # A real backend fault (misconfig / unreachable): log it so the
                # operator sees it, but still fail the login as plain bad creds so
                # we never leak whether a username exists. Invariant 1: this is an
                # infra error, so it must NOT count toward the lockout (no fail()).
                log.err(exc, "postern-imap auth backend fault")
                return defer.fail(error.UnauthorizedLogin("bad credentials"))
            # Correct credential: clear any accumulated failure state, then carry
            # the resolved identity to the realm.
            throttle.success(account)
            return defer.succeed(identity)

    @implementer(portal.IRealm)
    class _Realm:
        def requestAvatar(self, avatar_id, mind, *interfaces):
            if imap4.IAccount not in interfaces:
                raise NotImplementedError("postern-imap only serves IMAP accounts")
            account = PosternAccount(cfg, avatar_id.username, avatar_id.token)
            # (interface, avatar, logout-callable)
            return imap4.IAccount, account, lambda: None

    p = portal.Portal(_Realm())  # type: ignore[arg-type]
    p.registerChecker(_Checker())  # type: ignore[arg-type]
    return p
