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
from twisted.python.compat import networkString

from .auth import build_portal
from .config import Config


class PosternIMAP4Server(imap4.IMAP4Server):
    """IMAP4Server that returns a tagged NO (not BAD) for a refused APPEND.

    RFC 3501: a well-formed APPEND the server declines is a tagged NO. Twisted's
    do_APPEND maps every addMessage failure to BAD via the (name-mangled) __ebAppend
    handler, so we override it: a deliberate reject we raise as a MailboxException
    (e.g. AppendRejectedError on a placeholder folder, #109) becomes NO with the
    reason text; any other (unexpected) failure keeps the BAD + log behaviour. This
    is a deliberate, documented conformance shim; if a future Twisted renames the
    handler the override simply stops applying and the response degrades to BAD (the
    APPEND still fails -- no silent data loss either way).
    """

    def _IMAP4Server__ebAppend(self, failure, tag):  # overrides IMAP4Server.__ebAppend
        if failure.check(imap4.MailboxException):
            self.sendNegativeResponse(
                tag, b"APPEND failed: " + networkString(str(failure.value))
            )
            return
        self.sendBadResponse(tag, b"APPEND failed: " + networkString(str(failure.value)))
        log.err(failure)


class PosternIMAPFactory(protocol.Factory):
    """Builds IMAP4Server protocols bound to the proxy's auth portal."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._portal = build_portal(cfg)

    def buildProtocol(self, addr):
        proto = PosternIMAP4Server()
        # IMAP4Server.authenticateLogin defers LOGIN to this portal, which
        # resolves credentials to a PosternAccount (auth.build_portal / #32).
        proto.portal = self._portal
        proto.factory = self
        return proto


def _build_tls_context_factory(cert_path: str, key_path: str):
    """An IMAPS context factory with a TLS 1.2 floor (#106).

    Twisted's stock DefaultOpenSSLContextFactory negotiates down to TLS 1.0/1.1,
    which are deprecated and must not be offered. We build it on TLS_METHOD and
    raise the minimum protocol version to TLS 1.2, mirroring the SMTP relay's
    tls.VersionTLS12 floor so both doors share one posture. TLS deps are imported
    lazily here so a non-TLS (loopback) deployment never needs pyOpenSSL.
    """
    from twisted.internet import ssl
    from OpenSSL import SSL

    factory = ssl.DefaultOpenSSLContextFactory(key_path, cert_path, sslmethod=SSL.TLS_METHOD)
    # getContext() returns the cached context served to every connection.
    factory.getContext().set_min_proto_version(SSL.TLS1_2_VERSION)
    return factory


def build_factory(cfg: Config) -> PosternIMAPFactory:
    return PosternIMAPFactory(cfg)


def run(cfg: Config) -> None:
    from twisted.internet import reactor

    log.startLogging(sys.stdout)
    factory = build_factory(cfg)

    if cfg.tls_cert and cfg.tls_key:
        from twisted.internet import ssl

        ctx = _build_tls_context_factory(cfg.tls_cert, cfg.tls_key)
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
