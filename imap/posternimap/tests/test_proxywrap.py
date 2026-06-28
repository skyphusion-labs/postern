"""Tests for the Twisted PROXY protocol adapter (proxywrap).

Drives the per-connection wrapper with a StringTransport + a Clock (no reactor, no
network), so the trust gate, the off/optional/require matrix, header stripping +
client-IP recovery, malformed-rejection, and the read-timeout fallback are all
deterministic. The pure parser is covered in test_proxyproto; this asserts the
adapter wires its outcomes onto a connection correctly.
"""

from __future__ import annotations

import unittest

try:
    from twisted.internet import protocol
    from twisted.internet.address import IPv4Address
    from twisted.internet.task import Clock
    from twisted.internet.testing import StringTransportWithDisconnection

    HAVE_TWISTED = True
except ImportError:  # pragma: no cover
    HAVE_TWISTED = False

from posternimap import proxyproto
from posternimap.proxyproto import ProxyProtocolConfig, parse_trusted
from posternimap.tests.test_proxyproto import v2_ipv4

TRUSTED = parse_trusted("10.1.0.0/16")
V1 = b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"
PAYLOAD = b"a LOGIN agent tok\r\n"


class _RecordingProto(protocol.Protocol):
    """A stand-in for the wrapped protocol (TLS or IMAP): records what it gets."""

    def __init__(self):
        self.received = b""
        self.made = False
        self.conn_transport = None
        self.lost = False

    def makeConnection(self, transport):
        self.made = True
        self.conn_transport = transport

    def dataReceived(self, data):
        self.received += data

    def connectionLost(self, reason=protocol.connectionDone):
        self.lost = True


class _RecordingFactory(protocol.Factory):
    def __init__(self):
        self.built = []

    def buildProtocol(self, addr):
        p = _RecordingProto()
        p.addr = addr
        self.built.append(p)
        return p


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class ProxyWrapTest(unittest.TestCase):
    def _spin(self, cfg, peer_ip="10.1.0.3", peer_port=5000):
        from posternimap.proxywrap import ProxyProtocolWrappingFactory

        clock = Clock()
        fac = _RecordingFactory()
        wf = ProxyProtocolWrappingFactory(cfg, fac, reactor=clock)
        proto = wf.buildProtocol(None)
        transport = StringTransportWithDisconnection(
            peerAddress=IPv4Address("TCP", peer_ip, peer_port)
        )
        transport.protocol = proto
        proto.makeConnection(transport)
        return proto, fac, transport, clock

    # --- trusted: header honored -------------------------------------------------

    def test_v1_trusted_recovers_client_and_strips_header(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg)
        proto.dataReceived(V1 + PAYLOAD)
        self.assertEqual(len(fac.built), 1)
        wrapped = fac.built[0]
        self.assertTrue(wrapped.made)
        # The wrapped protocol gets ONLY the post-header stream, not the header.
        self.assertEqual(wrapped.received, PAYLOAD)
        # The recovered client IP is the connection's peer for the wrapped protocol
        # AND for the factory's buildProtocol addr (logging / throttle context).
        self.assertEqual(wrapped.conn_transport.getPeer().host, "198.51.100.7")
        self.assertEqual(wrapped.conn_transport.getPeer().port, 4444)
        self.assertEqual(wrapped.addr.host, "198.51.100.7")

    def test_v2_trusted_recovers_client(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg)
        proto.dataReceived(v2_ipv4() + b"tls-bytes")
        wrapped = fac.built[0]
        self.assertEqual(wrapped.received, b"tls-bytes")
        self.assertEqual(wrapped.conn_transport.getPeer().host, "198.51.100.7")

    def test_v1_split_across_reads_resolves(self):
        # Incremental delivery: the header arrives in two TCP segments.
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, _, _ = self._spin(cfg)
        proto.dataReceived(V1[:20])
        self.assertEqual(len(fac.built), 0)  # not resolved yet
        proto.dataReceived(V1[20:] + PAYLOAD)
        self.assertEqual(len(fac.built), 1)
        self.assertEqual(fac.built[0].received, PAYLOAD)
        self.assertEqual(fac.built[0].conn_transport.getPeer().host, "198.51.100.7")

    def test_v1_unknown_keeps_raw_peer(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, _, _ = self._spin(cfg, peer_ip="10.1.0.9")
        proto.dataReceived(b"PROXY UNKNOWN\r\n" + PAYLOAD)
        wrapped = fac.built[0]
        self.assertEqual(wrapped.received, PAYLOAD)
        self.assertEqual(wrapped.conn_transport.getPeer().host, "10.1.0.9")  # raw peer kept

    def test_malformed_header_from_trusted_is_rejected(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg)
        proto.dataReceived(b"PROXY TCP4 bad-ip 203.0.113.1 4444 993\r\n")
        self.assertEqual(len(fac.built), 0)
        self.assertFalse(transport.connected)

    # --- trust gate (anti-spoof) -------------------------------------------------

    def test_untrusted_optional_ignores_header_keeps_raw_peer(self):
        # A forged header from an untrusted peer must NOT be honored; the bytes are
        # left in the stream (delivered to the wrapped protocol) and the peer stays raw.
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED)
        proto, fac, _, _ = self._spin(cfg, peer_ip="8.8.8.8")
        proto.dataReceived(V1 + PAYLOAD)
        wrapped = fac.built[0]
        self.assertEqual(wrapped.conn_transport.getPeer().host, "8.8.8.8")  # NOT 198.51.100.7
        self.assertEqual(wrapped.received, V1 + PAYLOAD)  # header left in stream

    def test_untrusted_require_is_rejected(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg, peer_ip="8.8.8.8")
        self.assertEqual(len(fac.built), 0)  # rejected at connectionMade
        self.assertFalse(transport.connected)

    # --- mode matrix: trusted peer, no header ------------------------------------

    def test_trusted_optional_no_header_falls_back(self):
        # Trusted peer speaks IMAP directly (no PROXY header): optional falls back to
        # the raw peer and delivers the bytes.
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED)
        proto, fac, _, _ = self._spin(cfg, peer_ip="10.1.0.5")
        proto.dataReceived(PAYLOAD)
        wrapped = fac.built[0]
        self.assertEqual(wrapped.received, PAYLOAD)
        self.assertEqual(wrapped.conn_transport.getPeer().host, "10.1.0.5")

    def test_trusted_require_no_header_is_rejected(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg, peer_ip="10.1.0.5")
        proto.dataReceived(PAYLOAD)  # first byte is not a PROXY signature
        self.assertEqual(len(fac.built), 0)
        self.assertFalse(transport.connected)

    # --- timeout (trusted peer connects then stalls) -----------------------------

    def test_trusted_optional_timeout_falls_back_to_raw_peer(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg, peer_ip="10.1.0.7")
        self.assertEqual(len(fac.built), 0)  # waiting for a header
        clock.advance(5.1)
        self.assertEqual(len(fac.built), 1)
        self.assertEqual(fac.built[0].conn_transport.getPeer().host, "10.1.0.7")
        self.assertTrue(transport.connected)

    def test_trusted_require_timeout_is_rejected(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg, peer_ip="10.1.0.7")
        clock.advance(5.1)
        self.assertEqual(len(fac.built), 0)
        self.assertFalse(transport.connected)

    def test_header_after_resolve_cancels_timeout(self):
        # A valid header before the deadline resolves and cancels the pending timeout,
        # so a late clock tick does not double-resolve or reject.
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg)
        proto.dataReceived(V1 + PAYLOAD)
        self.assertEqual(len(fac.built), 1)
        clock.advance(10)  # no-op now
        self.assertEqual(len(fac.built), 1)
        self.assertTrue(transport.connected)

    # --- committed-then-truncated header (contract section 6 boundary) ------------

    def test_committed_v2_signature_then_stall_optional_rejects(self):
        # A FULL v2 signature has arrived (the peer COMMITTED to a header), then the
        # remainder stalls past the timeout. That is a TRUNCATED = malformed header,
        # rejected even in optional (it is no longer "silence" -> no fall-back).
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg)
        proto.dataReceived(proxyproto.V2_SIGNATURE)  # committed, body never arrives
        self.assertEqual(len(fac.built), 0)
        clock.advance(5.1)
        self.assertEqual(len(fac.built), 0)  # NOT a raw-peer fall-back
        self.assertFalse(transport.connected)

    def test_committed_v1_prefix_then_stall_optional_rejects(self):
        # Full "PROXY" prefix (committed), then no CRLF before the deadline: truncated.
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg)
        proto.dataReceived(b"PROXY TCP4 198.51.100.7")  # committed, no CRLF
        clock.advance(5.1)
        self.assertEqual(len(fac.built), 0)
        self.assertFalse(transport.connected)

    def test_committed_then_stall_require_rejects(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg)
        proto.dataReceived(proxyproto.V2_SIGNATURE)
        clock.advance(5.1)
        self.assertEqual(len(fac.built), 0)
        self.assertFalse(transport.connected)

    def test_partial_signature_then_stall_optional_falls_back(self):
        # A PARTIAL signature (not committed) that stalls is NO HEADER, not truncated:
        # optional still falls back to the raw peer (the contract's other side of the
        # boundary). Confirms signature_committed gates the reject correctly.
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg, peer_ip="10.1.0.7")
        proto.dataReceived(proxyproto.V2_SIGNATURE[:6])  # partial v2 sig only
        clock.advance(5.1)
        self.assertEqual(len(fac.built), 1)
        self.assertEqual(fac.built[0].conn_transport.getPeer().host, "10.1.0.7")
        self.assertTrue(transport.connected)

    # --- clean (quiet) drop vs. loud malformed reject (contract sections 4 + 5.3) -

    def _capture_proxy_logs(self):
        from twisted.python import log

        events = []
        observer = events.append
        log.addObserver(observer)
        self.addCleanup(log.removeObserver, observer)
        return events

    def _reject_lines(self, events):
        out = []
        for ev in events:
            msg = ev.get("message")
            text = " ".join(str(m) for m in msg) if msg else str(ev.get("format", ""))
            if "rejecting connection" in text:
                out.append(text)
        return out

    def test_clean_drops_are_quiet(self):
        # The EXPECTED operational rejects (untrusted peer in require; trusted peer
        # with no header in require, i.e. the LB's bare-TCP health probe) must NOT log
        # a line, so health probes do not pollute the logs.
        events = self._capture_proxy_logs()
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED, timeout=5.0)
        # untrusted peer -> clean drop at connectionMade
        p1, f1, t1, _ = self._spin(cfg, peer_ip="8.8.8.8")
        self.assertFalse(t1.connected)
        # trusted peer, no header, timeout -> clean drop
        p2, f2, t2, clock2 = self._spin(cfg, peer_ip="10.1.0.5")
        clock2.advance(5.1)
        self.assertFalse(t2.connected)
        # trusted peer, no PROXY signature at all -> clean drop
        p3, f3, t3, _ = self._spin(cfg, peer_ip="10.1.0.5")
        p3.dataReceived(PAYLOAD)
        self.assertFalse(t3.connected)
        self.assertEqual(self._reject_lines(events), [])

    def test_malformed_from_trusted_logs_loud(self):
        # The ONE loud reject: a malformed header from a trusted peer is surfaced.
        events = self._capture_proxy_logs()
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg)
        proto.dataReceived(b"PROXY TCP4 bad-ip 203.0.113.1 4444 993\r\n")
        self.assertFalse(transport.connected)
        self.assertEqual(len(self._reject_lines(events)), 1)

    def test_truncated_committed_header_logs_loud(self):
        # A committed-then-truncated header (timeout after a full signature) is the
        # malformed branch, so it logs loud too.
        events = self._capture_proxy_logs()
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=TRUSTED, timeout=5.0)
        proto, fac, transport, clock = self._spin(cfg)
        proto.dataReceived(proxyproto.V2_SIGNATURE)
        clock.advance(5.1)
        self.assertFalse(transport.connected)
        self.assertEqual(len(self._reject_lines(events)), 1)

    # --- connection teardown -----------------------------------------------------

    def test_connection_lost_propagates_to_wrapped(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        proto, fac, transport, _ = self._spin(cfg)
        proto.dataReceived(V1 + PAYLOAD)
        wrapped = fac.built[0]
        proto.connectionLost(protocol.connectionDone)
        self.assertTrue(wrapped.lost)


@unittest.skipUnless(HAVE_TWISTED, "Twisted not installed")
class WrapListenerFactoryTest(unittest.TestCase):
    def test_off_returns_factory_unwrapped(self):
        from posternimap.proxywrap import wrap_listener_factory

        fac = _RecordingFactory()
        cfg = ProxyProtocolConfig(mode=proxyproto.OFF)
        self.assertIs(wrap_listener_factory(cfg, fac), fac)

    def test_enabled_returns_wrapper(self):
        from posternimap.proxywrap import ProxyProtocolWrappingFactory, wrap_listener_factory

        fac = _RecordingFactory()
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=TRUSTED)
        wrapped = wrap_listener_factory(cfg, fac, reactor=Clock())
        self.assertIsInstance(wrapped, ProxyProtocolWrappingFactory)


if __name__ == "__main__":
    unittest.main()
