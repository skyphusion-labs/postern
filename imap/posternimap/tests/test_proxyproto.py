"""Tests for the pure PROXY protocol layer (parsing, trusted set, config).

No Twisted: this layer is stdlib-only, so it is exercised without a reactor. The
Twisted adapter is covered in test_proxywrap; the env-config plumbing in test_config.
Semantics are matched to the Go reference relay/proxyproto.go via docs/PROXY-PROTOCOL.md.
"""

from __future__ import annotations

import ipaddress
import socket
import unittest

from posternimap import proxyproto
from posternimap.proxyproto import (
    HEADER,
    NEED_MORE,
    NO_HEADER,
    ProxyProtocolConfig,
    ProxyProtocolError,
    parse_header,
    parse_trusted,
    signature_committed,
)


def v2_header(family_byte: int, command: int, addr_block: bytes) -> bytes:
    fixed = bytes([command, family_byte]) + len(addr_block).to_bytes(2, "big")
    return proxyproto.V2_SIGNATURE + fixed + addr_block


def v2_ipv4(src_ip: str = "198.51.100.7", src_port: int = 4444) -> bytes:
    block = (
        socket.inet_aton(src_ip)
        + socket.inet_aton("203.0.113.1")
        + src_port.to_bytes(2, "big")
        + (993).to_bytes(2, "big")
    )
    return v2_header(0x11, 0x21, block)  # AF_INET + STREAM, version2 | PROXY


def v2_ipv6(src_ip: str = "2001:db8::7", src_port: int = 4444) -> bytes:
    block = (
        socket.inet_pton(socket.AF_INET6, src_ip)
        + socket.inet_pton(socket.AF_INET6, "2001:db8::1")
        + src_port.to_bytes(2, "big")
        + (993).to_bytes(2, "big")
    )
    return v2_header(0x21, 0x21, block)  # AF_INET6 + STREAM, version2 | PROXY


class V1ParseTest(unittest.TestCase):
    def test_tcp4(self):
        out, addr, consumed = parse_header(b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n")
        self.assertEqual(out, HEADER)
        self.assertEqual(addr, ("198.51.100.7", 4444))
        self.assertEqual(consumed, len(b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"))

    def test_tcp6(self):
        line = b"PROXY TCP6 2001:db8::7 2001:db8::1 4444 993\r\n"
        out, addr, consumed = parse_header(line)
        self.assertEqual(out, HEADER)
        self.assertEqual(addr, ("2001:db8::7", 4444))
        self.assertEqual(consumed, len(line))

    def test_trailing_bytes_are_not_consumed(self):
        # Only the header is consumed; the rest is the real stream.
        line = b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\r\n"
        out, addr, consumed = parse_header(line + b"a LOGIN x y\r\n")
        self.assertEqual(out, HEADER)
        self.assertEqual(consumed, len(line))

    def test_unknown_keeps_raw_peer(self):
        out, addr, consumed = parse_header(b"PROXY UNKNOWN\r\n")
        self.assertEqual(out, HEADER)
        self.assertIsNone(addr)
        self.assertEqual(consumed, len(b"PROXY UNKNOWN\r\n"))

    def test_unknown_with_addresses_keeps_raw_peer(self):
        # The spec allows UNKNOWN to carry (ignored) addresses; honored-no-addr.
        out, addr, _ = parse_header(b"PROXY UNKNOWN 1.2.3.4 5.6.7.8 1 2\r\n")
        self.assertEqual(out, HEADER)
        self.assertIsNone(addr)

    def test_incremental_need_more(self):
        out, _, _ = parse_header(b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993")
        self.assertEqual(out, NEED_MORE)  # no CRLF yet
        out, _, _ = parse_header(b"PROX")
        self.assertEqual(out, NEED_MORE)  # partial prefix

    def test_bad_ip_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(b"PROXY TCP4 not-an-ip 203.0.113.1 4444 993\r\n")

    def test_bad_port_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(b"PROXY TCP4 198.51.100.7 203.0.113.1 99999 993\r\n")

    def test_wrong_field_count_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(b"PROXY TCP4 198.51.100.7 4444\r\n")

    def test_unknown_protocol_token_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(b"PROXY TCP9 198.51.100.7 203.0.113.1 4444 993\r\n")

    def test_overlong_line_without_crlf_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(b"PROXY TCP4 " + b"9" * 200)

    def test_not_crlf_terminated_is_malformed(self):
        # Bare LF without the CR.
        with self.assertRaises(ProxyProtocolError):
            parse_header(b"PROXY TCP4 198.51.100.7 203.0.113.1 4444 993\n")


class V2ParseTest(unittest.TestCase):
    def test_ipv4(self):
        out, addr, consumed = parse_header(v2_ipv4())
        self.assertEqual(out, HEADER)
        self.assertEqual(addr, ("198.51.100.7", 4444))
        self.assertEqual(consumed, len(v2_ipv4()))

    def test_ipv6(self):
        out, addr, _ = parse_header(v2_ipv6())
        self.assertEqual(out, HEADER)
        self.assertEqual(addr, ("2001:db8::7", 4444))

    def test_trailing_stream_not_consumed(self):
        h = v2_ipv4()
        out, addr, consumed = parse_header(h + b"hello-tls-bytes")
        self.assertEqual(out, HEADER)
        self.assertEqual(consumed, len(h))

    def test_local_command_keeps_raw_peer(self):
        # LOCAL (command 0x0): a health check; ignore the address block.
        out, addr, consumed = parse_header(v2_header(0x11, 0x20, b"\x00" * 12))
        self.assertEqual(out, HEADER)
        self.assertIsNone(addr)
        self.assertEqual(consumed, len(proxyproto.V2_SIGNATURE) + 4 + 12)

    def test_non_tcp_family_keeps_raw_peer(self):
        # AF_UNIX / UNSPEC etc: valid header, no usable TCP client address.
        out, addr, _ = parse_header(v2_header(0x00, 0x21, b"\x00" * 12))  # UNSPEC
        self.assertEqual(out, HEADER)
        self.assertIsNone(addr)

    def test_extra_tlv_bytes_in_block_are_consumed(self):
        # A v2 block longer than the family minimum (trailing TLVs) is still a valid
        # header; we consume the full declared length and keep parsing the address.
        block = (
            socket.inet_aton("198.51.100.7")
            + socket.inet_aton("203.0.113.1")
            + (4444).to_bytes(2, "big")
            + (993).to_bytes(2, "big")
            + b"\x03\x00\x04abcd"  # a trailing TLV
        )
        h = v2_header(0x11, 0x21, block)
        out, addr, consumed = parse_header(h)
        self.assertEqual(out, HEADER)
        self.assertEqual(addr, ("198.51.100.7", 4444))
        self.assertEqual(consumed, len(h))

    def test_partial_signature_need_more(self):
        out, _, _ = parse_header(proxyproto.V2_SIGNATURE[:6])
        self.assertEqual(out, NEED_MORE)

    def test_partial_body_need_more(self):
        h = v2_ipv4()
        out, _, _ = parse_header(h[:-3])
        self.assertEqual(out, NEED_MORE)

    def test_bad_version_is_malformed(self):
        # version nibble 1 instead of 2.
        with self.assertRaises(ProxyProtocolError):
            parse_header(v2_header(0x11, 0x11, b"\x00" * 12))

    def test_unknown_command_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(v2_header(0x11, 0x2F, b"\x00" * 12))

    def test_ipv4_block_too_short_is_malformed(self):
        with self.assertRaises(ProxyProtocolError):
            parse_header(v2_header(0x11, 0x21, b"\x00" * 4))


class NoHeaderTest(unittest.TestCase):
    def test_plain_imap_is_no_header(self):
        out, _, _ = parse_header(b"a LOGIN user pass\r\n")
        self.assertEqual(out, NO_HEADER)

    def test_empty_is_need_more(self):
        out, _, _ = parse_header(b"")
        self.assertEqual(out, NEED_MORE)

    def test_cr_then_divergent_is_no_header(self):
        # Starts 0x0D but is not the v2 signature.
        out, _, _ = parse_header(b"\r\nxyz")
        self.assertEqual(out, NO_HEADER)

    def test_p_then_divergent_is_no_header(self):
        out, _, _ = parse_header(b"PONG\r\n")
        self.assertEqual(out, NO_HEADER)


class SignatureCommittedTest(unittest.TestCase):
    """The no-header-vs-truncated boundary (docs/PROXY-PROTOCOL.md section 6): a
    COMPLETE signature (full v1 ``PROXY`` prefix or full 12-byte v2 signature) means
    the peer has committed to a header. The adapter rejects a committed-then-stalled
    header as malformed; an uncommitted timeout is just "no header"."""

    def test_full_v1_prefix_is_committed(self):
        self.assertTrue(signature_committed(b"PROXY"))
        self.assertTrue(signature_committed(b"PROXY TCP4 1.2.3.4"))  # mid-line, committed

    def test_partial_v1_prefix_is_not_committed(self):
        self.assertFalse(signature_committed(b""))
        self.assertFalse(signature_committed(b"PROX"))

    def test_full_v2_signature_is_committed(self):
        self.assertTrue(signature_committed(proxyproto.V2_SIGNATURE))
        self.assertTrue(signature_committed(proxyproto.V2_SIGNATURE + b"\x21\x11"))

    def test_partial_v2_signature_is_not_committed(self):
        self.assertFalse(signature_committed(proxyproto.V2_SIGNATURE[:11]))

    def test_non_proxy_bytes_are_not_committed(self):
        # A plain IMAP command never looks committed (it is just "no header").
        self.assertFalse(signature_committed(b"a LOGIN user pass\r\n"))
        self.assertFalse(signature_committed(b"\r\nxyz"))  # starts 0x0D, not the v2 sig


class TrustedSetTest(unittest.TestCase):
    def test_cidr_and_bare_ip(self):
        nets = parse_trusted("192.0.2.0/24, 198.51.100.7 , 2001:db8::/32")
        self.assertEqual(len(nets), 3)
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=nets)
        self.assertTrue(cfg.trusts("192.0.2.3"))
        self.assertTrue(cfg.trusts("198.51.100.7"))  # bare IP -> /32
        self.assertFalse(cfg.trusts("198.51.100.8"))
        self.assertTrue(cfg.trusts("2001:db8::dead"))
        self.assertFalse(cfg.trusts("8.8.8.8"))

    def test_host_bits_tolerated(self):
        nets = parse_trusted("192.0.2.3/24")  # strict=False masks to 192.0.2.0/24
        self.assertEqual(str(nets[0]), "192.0.2.0/24")

    def test_empty_spec_is_empty(self):
        self.assertEqual(parse_trusted(""), ())
        self.assertEqual(parse_trusted("  ,  "), ())

    def test_bad_entry_raises(self):
        with self.assertRaises(ValueError):
            parse_trusted("not-an-ip")

    def test_trusts_handles_garbage_host(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.OPTIONAL, trusted=parse_trusted("192.0.2.0/24"))
        self.assertFalse(cfg.trusts(None))
        self.assertFalse(cfg.trusts(""))
        self.assertFalse(cfg.trusts("not-an-ip"))

    def test_cross_family_never_matches(self):
        cfg = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=parse_trusted("::/0"))
        self.assertFalse(cfg.trusts("1.2.3.4"))  # v4 peer vs v6 net
        cfg4 = ProxyProtocolConfig(mode=proxyproto.REQUIRE, trusted=parse_trusted("0.0.0.0/0"))
        self.assertFalse(cfg4.trusts("2001:db8::1"))  # v6 peer vs v4 net


class ConfigEnabledTest(unittest.TestCase):
    def test_enabled(self):
        self.assertFalse(ProxyProtocolConfig().enabled())
        self.assertFalse(ProxyProtocolConfig(mode=proxyproto.OFF).enabled())
        self.assertTrue(ProxyProtocolConfig(mode=proxyproto.OPTIONAL).enabled())
        self.assertTrue(ProxyProtocolConfig(mode=proxyproto.REQUIRE).enabled())


if __name__ == "__main__":
    unittest.main()
