"""Twisted adapter that wires PROXY protocol onto the 993 listener.

This wraps a listener factory so each accepted connection is trust-gated and has
its PROXY header stripped BEFORE anything downstream (the TLS handshake, then the
IMAP greeting) sees a byte. It recovers the real client address and presents it as
the connection's peer, so logging and the #105 per-account throttle context name
the true client instead of the load balancer.

ORDERING (993 is implicit TLS): the LB prepends the PROXY header on the RAW TCP
stream, ahead of the TLS ClientHello. So the header MUST be consumed off the raw
bytes before TLS, or its bytes would poison the TLS engine. We therefore listen
plain TCP and put this wrapper OUTERMOST (closest to the wire); the wrapped factory
is the TLS factory (TLSMemoryBIOFactory) for 993, or the IMAP factory directly for
a plaintext/loopback listener. The Go 587 door does the equivalent before its SMTP
greeting; STARTTLS there comes later over the unwrapped conn, so its wrapper sits
at the net.Listener. docs/PROXY-PROTOCOL.md section 8 anticipates this difference.

TRUST GATE (anti-spoof, security-critical): the decision is made on the RAW socket
peer and BEFORE a single header byte is interpreted. An untrusted peer's header is
never honored and never consumed: in require mode the connection is rejected; in
optional mode it falls back to the raw peer and any header bytes are left in the
stream for the IMAP parser to reject as garbage. This matches relay/proxyproto.go.

The header is parsed in the per-connection context (dataReceived), never in the
accept loop, and a read timeout bounds a trusted peer that connects then stalls, so
one slow peer can never stall acceptance of other connections (contract section 8).
"""

from __future__ import annotations

import ipaddress
from typing import Any, Optional

from zope.interface import directlyProvides, implementer, providedBy

from twisted.internet import interfaces, protocol
from twisted.internet.address import IPv4Address, IPv6Address
from twisted.python import log

from . import proxyproto
from .proxyproto import ProxyProtocolConfig


def _twisted_address(ip: str, port: int):
    """Build a Twisted IAddress for a recovered (ip, port) client."""
    if ipaddress.ip_address(ip).version == 6:
        return IPv6Address("TCP", ip, port)
    return IPv4Address("TCP", ip, port)


@implementer(interfaces.ITransport)
class _ProxyProtocolConnection(protocol.Protocol):
    """Per-connection wrapper: trust-gate + strip the PROXY header, then act as the
    transport for the wrapped protocol (TLS or IMAP), reporting the recovered peer.

    Until the header is resolved we buffer incoming bytes and do NOT build the
    wrapped protocol. On resolution we build it, hand it `self` as its transport
    (so its getPeer() is the recovered client and its writes flow to the real
    transport), and replay any post-header bytes. A malformed header from the
    trusted peer, or a missing/forbidden header per the mode matrix, drops the
    connection without serving the protocol (a connection-level refusal).
    """

    def __init__(self, cfg: ProxyProtocolConfig, wrapped_factory, reactor) -> None:
        self._cfg = cfg
        self._wrapped_factory = wrapped_factory
        self._reactor = reactor
        self._buf = b""
        self._buffering = False
        self._resolved = False
        self._wrapped: Optional[protocol.Protocol] = None
        self._remote: Any = None
        self._raw: Any = None
        self._timeout = None

    # --- raw side: we are the Protocol on the real TCP transport ---

    def connectionMade(self) -> None:
        # Mirror the real transport's provided interfaces onto ourselves, so the
        # wrapped protocol (e.g. the TLS protocol) sees the same transport
        # capabilities it would have on the bare socket.
        directlyProvides(self, *(list(providedBy(self)) + list(providedBy(self.transport))))
        _t: Any = self.transport
        self._raw = _t.getPeer()
        if not self._cfg.enabled():
            # Defensive: a disabled door should never wrap, but if it does, pass
            # through cleanly on the raw peer.
            self._resolve(self._raw, b"")
            return
        host = getattr(self._raw, "host", None)
        if not self._cfg.trusts(host):
            # Untrusted peer: NEVER honor a header (anti-spoof). require rejects;
            # optional keeps the raw peer and does NOT consume any bytes (a forged
            # header is left in the stream for the IMAP parser to reject).
            if self._cfg.mode == proxyproto.REQUIRE:
                self._drop(f"untrusted peer {host} in require mode")
            else:
                self._resolve(self._raw, b"")
            return
        # Trusted + enabled: buffer and parse, bounded by the read timeout so a
        # trusted peer that connects then stalls cannot pin the connection.
        self._buffering = True
        if self._cfg.timeout and self._cfg.timeout > 0:
            self._timeout = self._reactor.callLater(self._cfg.timeout, self._on_timeout)

    def dataReceived(self, data: bytes) -> None:
        if self._resolved:
            self._wrapped.dataReceived(data)  # type: ignore[union-attr]
            return
        if not self._buffering:
            self._buf += data
            return
        self._buf += data
        try:
            outcome, addr, consumed = proxyproto.parse_header(self._buf)
        except proxyproto.ProxyProtocolError as exc:
            # Malformed header from a trusted peer: hard fault, reject.
            self._drop(f"malformed PROXY header: {exc}")
            return
        if outcome == proxyproto.NEED_MORE:
            return  # the read timeout bounds an indefinite wait
        if outcome == proxyproto.NO_HEADER:
            # A trusted peer that sent no PROXY header. require rejects; optional
            # falls back to the raw peer and delivers the buffered (non-header) bytes.
            if self._cfg.mode == proxyproto.REQUIRE:
                self._drop("trusted peer sent no PROXY header in require mode")
            else:
                self._resolve(self._raw, self._buf)
            return
        # A complete header: recover the client (or keep raw for a no-address header)
        # and deliver everything after the header as the real stream.
        remote = _twisted_address(addr[0], addr[1]) if addr else self._raw
        self._resolve(remote, self._buf[consumed:])

    def _on_timeout(self) -> None:
        self._timeout = None
        if self._resolved:
            return
        # Contract section 6: treat silence as "no header". require rejects; optional
        # falls back to the raw peer (delivering whatever bytes arrived, if any).
        if self._cfg.mode == proxyproto.REQUIRE:
            self._drop("no PROXY header within timeout in require mode")
        else:
            self._resolve(self._raw, self._buf)

    def _resolve(self, remote, leftover: bytes) -> None:
        if self._resolved:
            return
        self._cancel_timeout()
        self._buffering = False
        self._resolved = True
        self._remote = remote
        self._wrapped = self._wrapped_factory.buildProtocol(remote)
        if self._wrapped is None:
            t: Any = self.transport
            t.loseConnection()
            return
        self._wrapped.makeConnection(self)
        if leftover:
            self._wrapped.dataReceived(leftover)

    def _drop(self, reason: str) -> None:
        # A connection-level refusal: the door has not spoken, so there is no
        # protocol reply to send. Log the reason (never any header content/secret).
        log.msg(f"postern-imap proxyproto: rejecting connection: {reason}", system="postern-imap")
        self._cancel_timeout()
        t: Any = self.transport
        t.loseConnection()

    def connectionLost(self, reason=protocol.connectionDone) -> None:
        self._cancel_timeout()
        if self._wrapped is not None:
            self._wrapped.connectionLost(reason)
            self._wrapped = None

    def _cancel_timeout(self) -> None:
        if self._timeout is not None and self._timeout.active():
            self._timeout.cancel()
        self._timeout = None

    # --- transport side: we are the ITransport for the wrapped protocol ---

    # All transport-side calls route through the real transport. We funnel them
    # through a local `Any` because Twisted's ITransport stubs declare no-self
    # method signatures and Protocol.transport is Optional, both of which trip mypy
    # on a plain delegate; the runtime call is a direct forward either way.
    def write(self, data: bytes) -> None:
        t: Any = self.transport
        t.write(data)

    def writeSequence(self, seq) -> None:
        t: Any = self.transport
        t.writeSequence(seq)

    def loseConnection(self) -> None:
        t: Any = self.transport
        t.loseConnection()

    def getPeer(self):
        # The recovered client (the whole point), or the raw peer before resolution.
        if self._remote is not None:
            return self._remote
        t: Any = self.transport
        return t.getPeer()

    def getHost(self):
        t: Any = self.transport
        return t.getHost()

    @property
    def disconnecting(self) -> bool:
        # The wrapped protocol (LineReceiver, the TLS protocol) reads this attribute
        # off its transport; delegate to the real transport's flag.
        return bool(getattr(self.transport, "disconnecting", False))

    # Producer/consumer delegation, so flow control reaches the real transport
    # (a large FETCH must back-pressure correctly).
    def registerProducer(self, producer, streaming) -> None:
        t: Any = self.transport
        t.registerProducer(producer, streaming)

    def unregisterProducer(self) -> None:
        t: Any = self.transport
        t.unregisterProducer()

    def stopConsuming(self) -> None:
        t: Any = self.transport
        t.stopConsuming()

    def pauseProducing(self) -> None:
        t: Any = self.transport
        t.pauseProducing()

    def resumeProducing(self) -> None:
        t: Any = self.transport
        t.resumeProducing()

    def stopProducing(self) -> None:
        t: Any = self.transport
        t.stopProducing()

    def getHandle(self):
        # ISystemHandle delegation (some consumers reach for the raw socket); guard
        # for transports that do not provide it.
        getter = getattr(self.transport, "getHandle", None)
        return getter() if getter is not None else None


class ProxyProtocolWrappingFactory(protocol.Factory):
    """Wraps `wrapped_factory` so each connection is PROXY-trust-gated + header-stripped.

    Returned by wrap_listener_factory() only when the config is enabled; the default
    (off) deploy is never wrapped, so it is byte-for-byte the prior behavior.
    """

    def __init__(self, cfg: ProxyProtocolConfig, wrapped_factory, reactor=None) -> None:
        self._cfg = cfg
        self._wrapped_factory = wrapped_factory
        # Late-bound so importing this module never imports the reactor (tests inject
        # a Clock; run() passes the real reactor).
        if reactor is None:
            from twisted.internet import reactor as _reactor

            reactor = _reactor
        self._reactor = reactor

    def doStart(self) -> None:
        self._wrapped_factory.doStart()
        super().doStart()

    def doStop(self) -> None:
        super().doStop()
        self._wrapped_factory.doStop()

    def buildProtocol(self, addr):
        return _ProxyProtocolConnection(self._cfg, self._wrapped_factory, self._reactor)


def wrap_listener_factory(cfg: ProxyProtocolConfig, wrapped_factory, reactor=None):
    """Wrap `wrapped_factory` with PROXY handling when enabled; else return it as-is.

    Mirrors the Go door's wrapProxyListener: a disabled config returns the factory
    unchanged so there is zero overhead and zero behavior change for the default off
    deploy.
    """
    if not cfg.enabled():
        return wrapped_factory
    return ProxyProtocolWrappingFactory(cfg, wrapped_factory, reactor=reactor)
