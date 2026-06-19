"""Auth mapping: IMAP login -> a Postern API token (#32).

Postern is one mailbox gated by a single high-entropy Bearer token
(`POSTERN_API_TOKEN`); scoped / multi tokens are explicitly post-v1
(CONTRACT section 5). The proxy is a *client* of that API and holds no authority
of its own, so an IMAP login has to resolve to an API token. Two modes:

  token (default)
    The IMAP *password* IS the Postern API token. The username is a free label
    (use the mailbox address, e.g. agent@skyphusion.org) for display / logging.
    The token is validated live against the API at login (client.ping). The
    proxy stores no secret; every session carries the user's own token, which
    matches the BYO-token / no-lock-in thesis and the single-token reality.

  fixed
    A single configured (username, token) pair. The operator puts the API token
    in the proxy's env (POSTERN_API_TOKEN) and picks a login password; a normal
    mail client (Thunderbird, mutt, iOS Mail) then connects with username +
    password. Convenient for a one-person self-host where typing a 64-char hex
    token as the password is awkward. Comparisons are constant-time.

The credential decision is a pure function (`resolve_token`) so it is testable
without Twisted. The Twisted cred plumbing (IRealm + ICredentialsChecker) wraps
it and is only imported when the server is actually run.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Optional

from .client import PosternClient
from .config import Config


@dataclass(frozen=True)
class Identity:
    """The result of a successful login: who, and the API token to act with."""

    username: str
    token: str


class AuthError(Exception):
    """Login was rejected (bad credentials)."""


def _const_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def resolve_token(
    cfg: Config,
    username: str,
    password: str,
    *,
    verify: Optional["TokenVerifier"] = None,
) -> Identity:
    """Map an IMAP (username, password) to a Postern Identity, or raise AuthError.

    `verify` is an injected callable (token -> bool) so this is testable without a
    live API; in production it is a PosternClient.ping bound to the token. In
    token mode the token's validity IS the auth check (a bad token fails ping); in
    fixed mode the username + password are checked constant-time first, then the
    configured token is (optionally) verified.
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
    else:  # token mode: the password is the API token
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


# --- Twisted cred plumbing (imported lazily by the server) -------------------
#
# Implemented in build_portal so importing this module does not require Twisted;
# only running the server (or the integration test) pulls it in.


def build_portal(cfg: Config, verify: Optional[TokenVerifier] = None):
    """Build a twisted.cred Portal whose login() yields an IMAP IAccount.

    The checker turns IUsernamePassword into an Identity via resolve_token; the
    realm turns the Identity into a PosternAccount (the IMAP IAccount). Returns a
    twisted.cred.portal.Portal.
    """
    from twisted.cred import checkers, credentials, error, portal
    from twisted.internet import defer
    from twisted.mail import imap4
    from zope.interface import implementer

    from .account import PosternAccount

    if verify is None:
        verify = TokenVerifier(cfg)

    @implementer(checkers.ICredentialsChecker)
    class _Checker:
        credentialInterfaces = (credentials.IUsernamePassword,)

        def requestAvatarId(self, creds):
            username = creds.username.decode() if isinstance(creds.username, bytes) else creds.username
            password = creds.password.decode() if isinstance(creds.password, bytes) else creds.password
            try:
                identity = resolve_token(cfg, username, password, verify=verify)
            except AuthError:
                return defer.fail(error.UnauthorizedLogin("bad credentials"))
            # The avatar id carries the resolved identity to the realm.
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
