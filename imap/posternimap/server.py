"""The Twisted IMAP4 server: wire a portal to a listening factory.

`build_factory(cfg)` returns a protocol factory whose IMAP4Server instances are
backed by the #32 auth portal (auth.build_portal). Twisted's IMAP4Server already
defers LOGIN to `self.portal.login(IUsernamePassword, None, IAccount)`, so wiring
auth is just setting `proto.portal`.

`run(cfg)` binds the listener (plain TCP, or TLS when a cert+key are configured)
and starts the reactor.

Twisted is imported here and in the adapter modules only; the pure layers
(client, rfc822, config, the resolve_token half of auth) never drag in Twisted.

Security note: the IMAP password is a Postern API token (or, in fixed mode, a
chosen password). Run behind TLS (set POSTERN_IMAP_TLS_CERT/KEY) or on loopback
fronted by stunnel; do not expose a plaintext listener to the internet.
"""

from __future__ import annotations

import sys

from twisted.internet import protocol
from twisted.mail import imap4
from twisted.python import log

from .auth import build_portal
from .config import Config


class PosternIMAPFactory(protocol.Factory):
    """Builds IMAP4Server protocols bound to the proxy's auth portal."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._portal = build_portal(cfg)

    def buildProtocol(self, addr):
        proto = imap4.IMAP4Server()
        # IMAP4Server.authenticateLogin defers LOGIN to this portal, which
        # resolves credentials to a PosternAccount (auth.build_portal / #32).
        proto.portal = self._portal
        proto.factory = self
        return proto


def build_factory(cfg: Config) -> PosternIMAPFactory:
    return PosternIMAPFactory(cfg)


def run(cfg: Config) -> None:
    from twisted.internet import reactor

    log.startLogging(sys.stdout)
    factory = build_factory(cfg)

    if cfg.tls_cert and cfg.tls_key:
        from twisted.internet import ssl

        ctx = ssl.DefaultOpenSSLContextFactory(cfg.tls_key, cfg.tls_cert)
        reactor.listenSSL(cfg.listen_port, factory, ctx, interface=cfg.listen_host)
        scheme = "imaps"
    else:
        reactor.listenTCP(cfg.listen_port, factory, interface=cfg.listen_host)  # type: ignore
        scheme = "imap"

    # Never log the token or any secret. URL + mode only.
    log.msg(
        f"postern-imap listening {scheme}://{cfg.listen_host}:{cfg.listen_port} "
        f"-> {cfg.api_url} (auth_mode={cfg.auth_mode})"
    )
    reactor.run()  # type: ignore
