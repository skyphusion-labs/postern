"""PROXY protocol (HAProxy spec, v1 text + v2 binary) for the 993 IMAP door.

This is the pure-Python half: header parsing, the trusted-CIDR set, and the
mode/config. It has ZERO Twisted dependency (stdlib only), so it is unit-testable
without a reactor, mirroring the client.py / rfc822.py layering. The Twisted
adapter that wires it onto a listener (trust-gates the raw peer, strips the header
before the TLS handshake, recovers the client address) lives in proxywrap.py.

WHY: the postern mail edge moved to a single L4 load balancer that targets
the directory host DIRECTLY (no bastion). An L4 LB rewrites the source address, so the door
would otherwise see one IP (the LB) for the whole world; the throttle (#105) and
the logs would be blind. The LB instead PROXY-protocols the connection, prepending
a header carrying the REAL client address; this module parses that header.

TRUST MODEL (security-critical): a PROXY header is a CLAIM. Anyone who can open a
TCP connection can write one. So a header is honored ONLY when the connection's
immediate raw peer is inside a configured trusted CIDR set (the LB's private
source); a header from ANY untrusted peer is NEVER honored. That gate lives in the
adapter (proxywrap.py) and is evaluated before a single header byte is interpreted.
A forged header from an untrusted peer must not poison the per-account throttle or
forge a log line. See docs/PROXY-PROTOCOL.md (Rollins's normative contract); this
module matches the Go reference relay/proxyproto.go byte-for-byte in semantics, so
both doors behave identically.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Optional, Tuple, Union

# --- modes (PROXY_PROTOCOL), identical strings to the Go door -----------------

OFF = "off"
OPTIONAL = "optional"
REQUIRE = "require"
MODES = (OFF, OPTIONAL, REQUIRE)

# --- wire constants -----------------------------------------------------------

# The 12-byte PROXY protocol v2 binary signature.
V2_SIGNATURE = b"\x0d\x0a\x0d\x0a\x00\x0d\x0a\x51\x55\x49\x54\x0a"
# The PROXY protocol v1 text prefix.
V1_PREFIX = b"PROXY"
# v1 spec maximum line length is 107 bytes including CRLF; the Go door reads up to
# 108 and treats no-CRLF-within-bound as malformed, so we mirror 108 exactly.
V1_MAX = 108
# v2 fixed header: 12-byte signature + version/command + family/transport + u16 len.
V2_FIXED = 16

# --- parse_header outcome codes -----------------------------------------------

NEED_MORE = "need_more"  # not enough bytes yet to decide or finish parsing
NO_HEADER = "no_header"  # the bytes are definitively not a PROXY header
HEADER = "header"        # a complete header was parsed (addr may be None)

# An address is (ip_string, port) or None (a valid header that carries no usable
# TCP client address: v1 UNKNOWN, v2 LOCAL, or a non-TCP/IP family -> keep raw peer).
Address = Optional[Tuple[str, int]]
ParseResult = Tuple[str, Address, int]


class ProxyProtocolError(ValueError):
    """A header began but is malformed/truncated past the point of ambiguity.

    From a TRUSTED peer this is a HARD failure (reject the connection): the load
    balancer is expected to speak the protocol correctly, so corrupt framing is a
    real fault, not something to paper over. This is the only place header CONTENT
    fails loud; everything else degrades to the raw peer. Matches the Go door's
    malformed-from-trusted = reject behavior.
    """


Network = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]


@dataclass(frozen=True)
class ProxyProtocolConfig:
    """Parsed PROXY protocol configuration for the 993 door (mirrors Go ProxyProtocolCfg).

    Zero value (mode == off, no trusted set) is a safe no-op: the listener is not
    wrapped at all, so the default deploy is byte-for-byte the prior behavior.
    """

    mode: str = OFF
    trusted: Tuple[Network, ...] = ()
    timeout: float = 5.0

    def enabled(self) -> bool:
        """True when any header parsing is configured (optional/require)."""
        return self.mode in (OPTIONAL, REQUIRE)

    def trusts(self, host: Optional[str]) -> bool:
        """True when `host` (a raw socket peer IP string) is in the trusted set."""
        if not host:
            return False
        try:
            addr = ipaddress.ip_address(host)
        except ValueError:
            return False
        # ip_network.__contains__ returns False (not error) across families, so a
        # v4 peer is never matched by a v6 trusted net and vice versa.
        return any(addr in net for net in self.trusted)


def parse_trusted(spec: str) -> Tuple[Network, ...]:
    """Parse a comma-separated CIDR list (PROXY_PROTOCOL_TRUSTED) into networks.

    A bare IP is accepted as a /32 (IPv4) or /128 (IPv6), matching the Go door's
    convenience. Host bits in a CIDR are tolerated (strict=False), as Go's
    net.ParseCIDR masks them. Raises ValueError (caught + rewrapped as a ConfigError
    by the config layer) on an unparseable entry, so a misconfigured trusted set
    fails at startup, not on the first connection.
    """
    out = []
    for raw in spec.split(","):
        entry = raw.strip()
        if not entry:
            continue
        if "/" not in entry:
            try:
                ip = ipaddress.ip_address(entry)
            except ValueError:
                raise ValueError(
                    f"PROXY_PROTOCOL_TRUSTED: {entry!r} is not an IP or CIDR"
                )
            entry = f"{entry}/{32 if ip.version == 4 else 128}"
        try:
            net = ipaddress.ip_network(entry, strict=False)
        except ValueError as exc:
            raise ValueError(f"PROXY_PROTOCOL_TRUSTED: {exc}") from exc
        out.append(net)
    return tuple(out)


def signature_committed(buf: bytes) -> bool:
    """True once a COMPLETE PROXY signature has arrived: the peer has COMMITTED to a
    header. The boundary is the full v1 prefix (5 bytes ``PROXY``) or the full v2
    signature (12 bytes).

    The adapter uses this to resolve the no-header-vs-truncated-header ambiguity on a
    read timeout (docs/PROXY-PROTOCOL.md section 6, "No header vs. truncated header"):

      - NOT committed (nothing, or only a partial/non-matching prefix) on timeout is
        NO HEADER -> optional falls back to the raw peer, require is a clean drop.
      - committed, then the remainder stalls past the timeout, is a TRUNCATED =
        MALFORMED header -> rejected in BOTH optional and require (a real LB fault).

    This is exactly the Go door's commit point (a successful signature ``Peek`` before
    it reads the rest), so both doors implement the identical boundary. A slice longer
    than ``buf`` simply does not match, so a short buffer is never "committed".
    """
    return buf[: len(V1_PREFIX)] == V1_PREFIX or buf[: len(V2_SIGNATURE)] == V2_SIGNATURE


def parse_header(buf: bytes) -> ParseResult:
    """Inspect the front of `buf` for a PROXY header. Pure, incremental, no I/O.

    The adapter feeds this the bytes buffered so far and acts on the outcome:

      (NEED_MORE, None, 0)        more bytes are required to decide or finish; wait
                                  (the adapter's read timeout bounds the wait).
      (NO_HEADER, None, 0)        the bytes are not a PROXY header at all; the
                                  adapter falls back to the raw peer (optional) or
                                  rejects (require), leaving the bytes in the stream.
      (HEADER, addr, consumed)    a complete header was parsed. `addr` is the real
                                  TCP client (ip, port), or None for a LOCAL/UNKNOWN/
                                  non-TCP header that carries no usable address (keep
                                  the raw peer). `consumed` bytes are the header; the
                                  rest of `buf` is the real stream.
      raises ProxyProtocolError   a header began but is malformed (hard fault).

    Detection keys off the first byte: v2 starts 0x0D (signature), v1 starts 'P'
    ("PROXY"). Anything else is definitively not a header.
    """
    if not buf:
        return (NEED_MORE, None, 0)
    first = buf[0]
    if first == 0x0D:  # candidate v2 signature
        if len(buf) < len(V2_SIGNATURE):
            return (NEED_MORE, None, 0) if V2_SIGNATURE.startswith(buf) else (NO_HEADER, None, 0)
        if buf[: len(V2_SIGNATURE)] == V2_SIGNATURE:
            return _parse_v2(buf)
        return (NO_HEADER, None, 0)
    if first == 0x50:  # 'P' -> candidate v1 "PROXY"
        if len(buf) < len(V1_PREFIX):
            return (NEED_MORE, None, 0) if V1_PREFIX.startswith(buf) else (NO_HEADER, None, 0)
        if buf[: len(V1_PREFIX)] == V1_PREFIX:
            return _parse_v1(buf)
        return (NO_HEADER, None, 0)
    return (NO_HEADER, None, 0)


def _parse_v1(buf: bytes) -> ParseResult:
    """Parse a PROXY protocol v1 text header: 'PROXY <proto> <src> <dst> <sp> <dp>\\r\\n'.

    UNKNOWN may omit the addresses. The line is at most 107 bytes incl CRLF; we
    mirror the Go door's 108-byte bound and its field handling exactly.
    """
    nl = buf.find(b"\n")
    if nl == -1:
        if len(buf) >= V1_MAX:
            raise ProxyProtocolError("v1 header exceeds max length without CRLF")
        return (NEED_MORE, None, 0)
    if nl + 1 > V1_MAX:
        raise ProxyProtocolError("v1 header exceeds max length without CRLF")
    line = buf[: nl + 1]
    if not line.endswith(b"\r\n"):
        raise ProxyProtocolError("v1 header not CRLF-terminated")
    consumed = nl + 1
    fields = line[:-2].split(b" ")
    if len(fields) < 2 or fields[0] != V1_PREFIX:
        raise ProxyProtocolError("v1 malformed header")
    proto = fields[1]
    if proto == b"UNKNOWN":
        # A valid header the proxy could not fill in: keep the raw peer.
        return (HEADER, None, consumed)
    if proto in (b"TCP4", b"TCP6"):
        if len(fields) != 6:
            raise ProxyProtocolError(
                f"v1 {proto.decode()} header needs 6 fields, got {len(fields)}"
            )
        ip = _parse_ip(fields[2])
        if ip is None:
            raise ProxyProtocolError(f"v1 bad source IP {fields[2]!r}")
        port = _parse_port(fields[4])
        if port is None:
            raise ProxyProtocolError(f"v1 bad source port {fields[4]!r}")
        return (HEADER, (ip, port), consumed)
    raise ProxyProtocolError(f"v1 unknown protocol {proto!r}")


def _parse_v2(buf: bytes) -> ParseResult:
    """Parse a PROXY protocol v2 binary header. The 12-byte signature is confirmed."""
    if len(buf) < V2_FIXED:
        return (NEED_MORE, None, 0)
    # buf[12]: high nibble = version (must be 2), low nibble = command (0 LOCAL, 1 PROXY).
    version = buf[12] >> 4
    if version != 0x2:
        raise ProxyProtocolError(f"v2 unsupported version {version}")
    command = buf[12] & 0x0F
    # buf[13]: high nibble = address family, low nibble = transport protocol.
    family = buf[13] >> 4
    transport = buf[13] & 0x0F
    addr_len = int.from_bytes(buf[14:16], "big")
    total = V2_FIXED + addr_len
    if len(buf) < total:
        return (NEED_MORE, None, 0)
    body = buf[V2_FIXED:total]

    if command == 0x0:
        # LOCAL: the proxy's own connection (e.g. a health check); ignore the
        # address block and keep the raw peer. Valid header, no client address.
        return (HEADER, None, total)
    if command != 0x1:
        raise ProxyProtocolError(f"v2 unknown command {command}")

    tcp_stream = 0x1
    if family == 0x1 and transport == tcp_stream:  # AF_INET
        if addr_len < 12:
            raise ProxyProtocolError(f"v2 IPv4 address block too short ({addr_len})")
        ip = "%d.%d.%d.%d" % (body[0], body[1], body[2], body[3])
        port = int.from_bytes(body[8:10], "big")
        return (HEADER, (ip, port), total)
    if family == 0x2 and transport == tcp_stream:  # AF_INET6
        if addr_len < 36:
            raise ProxyProtocolError(f"v2 IPv6 address block too short ({addr_len})")
        ip = str(ipaddress.IPv6Address(bytes(body[0:16])))
        port = int.from_bytes(body[32:34], "big")
        return (HEADER, (ip, port), total)
    # Any other family/transport (UDP, AF_UNIX, UNSPEC) is a valid header with no
    # usable TCP client address: keep the raw peer.
    return (HEADER, None, total)


def _parse_ip(raw: bytes) -> Optional[str]:
    try:
        return str(ipaddress.ip_address(raw.decode("ascii")))
    except (ValueError, UnicodeDecodeError):
        return None


def _parse_port(raw: bytes) -> Optional[int]:
    try:
        port = int(raw.decode("ascii"))
    except (ValueError, UnicodeDecodeError):
        return None
    if port < 0 or port > 65535:
        return None
    return port
