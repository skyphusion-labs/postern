package main

// PROXY protocol (HAProxy spec, v1 text + v2 binary) on the submission edge.
//
// WHY: the postern mail edge moved to a single Hetzner L4 load balancer that
// targets dischord DIRECTLY (no bastion, no HAProxy middle layer). An L4 LB
// rewrites the source address, so without help every connection would appear to
// originate from the LB. The LB instead prepends a PROXY protocol header carrying
// the REAL client address; this file recovers it so logs and any per-IP control
// see the true peer.
//
// TRUST MODEL (the security-critical property): a PROXY header is honored ONLY
// when the connection's immediate peer (the raw TCP RemoteAddr) is inside a
// configured trusted CIDR set (the LB's private source). A header from ANY
// untrusted peer is NEVER honored -- a forged header must not be able to poison
// the per-account throttle (#105) or the logs. This is the whole anti-spoof
// guarantee and it is enforced before a single header byte is interpreted.
//
// The doc contract this implements (identical config names across the Go 587 door
// and the Python 993 door) lives in docs/PROXY-PROTOCOL.md.

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// proxyMode is the PROXY_PROTOCOL knob: off | optional | require.
type proxyMode string

const (
	proxyOff      proxyMode = "off"      // never parse; raw peer always (mesh-internal / dev direct)
	proxyOptional proxyMode = "optional" // trusted peer MAY send a header; a missing header falls back to the raw peer IP
	proxyRequire  proxyMode = "require"  // trusted peer MUST send a header; trusted-without-header and any untrusted peer are rejected
)

// ProxyProtocolCfg is the parsed PROXY protocol configuration for the submission
// listeners. Zero value (Mode == "" treated as off) is a safe no-op.
type ProxyProtocolCfg struct {
	Mode    proxyMode     // PROXY_PROTOCOL
	Trusted []*net.IPNet  // PROXY_PROTOCOL_TRUSTED, parsed CIDRs (the LB's private source)
	Timeout time.Duration // PROXY_PROTOCOL_TIMEOUT_SECONDS, bound on reading the header
}

// enabled reports whether any PROXY header parsing is configured. When false the
// listener is returned unwrapped, so the default (off) deploy is byte-for-byte the
// prior behavior with zero added overhead.
func (c ProxyProtocolCfg) enabled() bool {
	return c.Mode == proxyOptional || c.Mode == proxyRequire
}

// trusts reports whether ip is inside the configured trusted CIDR set.
func (c ProxyProtocolCfg) trusts(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, n := range c.Trusted {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// v2Signature is the 12-byte PROXY protocol v2 binary signature.
var v2Signature = []byte{0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A}

// v1Prefix is the PROXY protocol v1 text prefix ("PROXY").
var v1Prefix = []byte("PROXY")

// wrapProxyListener wraps l so each accepted connection has its PROXY header
// trust-gated and parsed per cfg. When cfg is not enabled, l is returned
// unchanged (no behavior change for the default off deploy).
func wrapProxyListener(l net.Listener, cfg ProxyProtocolCfg) net.Listener {
	if !cfg.enabled() {
		return l
	}
	return &proxyListener{Listener: l, cfg: cfg}
}

// proxyListener is a net.Listener that returns connections whose RemoteAddr is the
// real client recovered from a trusted PROXY header. The header is parsed LAZILY
// (on the connection's first Read/RemoteAddr, in that connection's own goroutine),
// never inside Accept -- so a slow or silent peer can never stall the accept loop.
type proxyListener struct {
	net.Listener
	cfg ProxyProtocolCfg
}

func (l *proxyListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &proxyConn{Conn: c, cfg: l.cfg}, nil
}

// proxyConn defers PROXY header handling to the first Read or RemoteAddr. Both
// funnel through resolve(), guarded by a sync.Once, so the header is read exactly
// once and the effective remote address is stable thereafter.
type proxyConn struct {
	net.Conn
	cfg ProxyProtocolCfg

	once   sync.Once
	reader *bufio.Reader // set once a header peek has buffered bytes; nil means read straight from Conn
	remote net.Addr      // effective remote addr after resolve()
	err    error         // a rejection (require with no/forged-untrusted header) or a malformed-header parse error
}

func (c *proxyConn) resolve() {
	c.once.Do(func() {
		c.remote = c.Conn.RemoteAddr() // default: the raw peer, overridden only by an HONORED header

		peerIP := addrIP(c.Conn.RemoteAddr())
		trusted := c.cfg.trusts(peerIP)

		// Untrusted peer: NEVER honor a header (anti-spoof). In require mode the
		// door is strictly behind the trusted proxy, so an untrusted connection is
		// dropped (a CLEAN close, see rejectClean); in optional mode it simply keeps
		// its raw peer address. Either way we do NOT consume any bytes, so a forged
		// header is left in the stream and the SMTP command parser rejects it as
		// garbage.
		if !trusted {
			if c.cfg.Mode == proxyRequire {
				c.rejectClean("untrusted peer in require mode", peerIP)
			}
			return
		}

		// Trusted peer: bound the header read so a peer that connects and then
		// stalls cannot pin the connection goroutine forever.
		if c.cfg.Timeout > 0 {
			_ = c.Conn.SetReadDeadline(time.Now().Add(c.cfg.Timeout))
			defer c.Conn.SetReadDeadline(time.Time{})
		}

		br := bufio.NewReader(c.Conn)
		c.reader = br

		real, hadHeader, err := parseProxyHeader(br)
		if err != nil {
			// A malformed header from a TRUSTED peer is a hard error (fail LOUD):
			// the LB is expected to speak the protocol correctly, so corrupt framing
			// is a real fault, surfaced to the operator, not papered over. This is the
			// ONLY proxy outcome that is logged at the go-smtp connection layer.
			c.err = err
			return
		}
		if !hadHeader {
			// No header from a trusted peer. In require mode this is a clean drop:
			// the LB's own TCP health check is a bare connect with NO PROXY header
			// (Strummer's caveat), and so is any trusted client that has not yet been
			// taught to prepend one. Closing it cleanly (NOT a loud error, NOT an auth
			// event, NOT counted toward the #105 throttle which this path never
			// reaches) keeps the health probes and logs clean. In optional mode we
			// simply fall back to the raw peer IP (already set above).
			if c.cfg.Mode == proxyRequire {
				c.rejectClean("trusted peer sent no PROXY header in require mode", peerIP)
			}
			return
		}
		if real != nil {
			// A LOCAL v2 command or an UNKNOWN/non-TCP v1 header parses cleanly but
			// carries no usable client address; real is nil there and we keep the raw
			// peer. Only a real TCP src address overrides.
			c.remote = real
		}
	})
}

// rejectClean marks the connection for a CLEAN drop: Read returns io.EOF, which
// go-smtp treats as a normal client disconnect (it returns nil and logs nothing),
// so an expected operational reject (an untrusted peer, or a headerless connection
// in require mode such as the LB's TCP health check) does not pollute the logs.
// A diagnostic line is emitted only under SUBMISSION_DEBUG, so forensics is opt-in
// without prod log noise. This path never touches the #105 throttle (it never
// reaches the auth code), so a probe or a spoof can never poison the throttle.
func (c *proxyConn) rejectClean(reason string, peerIP net.IP) {
	c.err = io.EOF
	if submissionDebug {
		log.Printf("proxyproto: dropping connection (%s) peer=%s", reason, peerIP)
	}
}

func (c *proxyConn) Read(p []byte) (int, error) {
	c.resolve()
	if c.err != nil {
		return 0, c.err
	}
	if c.reader != nil {
		return c.reader.Read(p)
	}
	return c.Conn.Read(p)
}

func (c *proxyConn) RemoteAddr() net.Addr {
	c.resolve()
	if c.remote != nil {
		return c.remote
	}
	return c.Conn.RemoteAddr()
}

// addrIP extracts the net.IP from a net.Addr (TCP or UDP), or nil.
func addrIP(a net.Addr) net.IP {
	switch v := a.(type) {
	case *net.TCPAddr:
		return v.IP
	case *net.UDPAddr:
		return v.IP
	}
	host, _, err := net.SplitHostPort(a.String())
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}

// parseProxyHeader peeks the front of br to detect a PROXY protocol header.
//
// Returns:
//   - (addr, true, nil)  a header was present and parsed; addr is the real TCP
//     client (or nil for a LOCAL/UNKNOWN/non-TCP header that carries no usable
//     address -- the caller keeps the raw peer).
//   - (nil, false, nil)  no header is present (the bytes are not a PROXY header,
//     or the trusted peer is silent and the read deadline fired). The caller
//     decides require-reject vs optional-fallback.
//   - (nil, false, err)  a header began but is malformed/truncated (hard error).
//
// Detection: peek the v2 12-byte signature; if it does not match, peek the 5-byte
// v1 "PROXY" prefix. Because an SMTP server speaks first (the 220 greeting), a
// no-header client sends nothing until greeted, so the peek relies on the read
// deadline to break the standoff and fall through to "no header".
func parseProxyHeader(br *bufio.Reader) (net.Addr, bool, error) {
	sig, err := br.Peek(len(v2Signature))
	if err == nil && bytes.Equal(sig, v2Signature) {
		return parseV2(br)
	}
	// Not v2 (or fewer than 12 bytes available). Try the v1 text prefix.
	prefix, perr := br.Peek(len(v1Prefix))
	if perr == nil && bytes.Equal(prefix, v1Prefix) {
		return parseV1(br)
	}
	// Neither signature matched (or the trusted peer is silent and the deadline
	// fired). That is the no-header outcome: optional falls back to the raw peer,
	// require rejects. A benign timeout/EOF and a clearly-not-PROXY first byte are
	// the same result here, so we do not escalate either to a parse error.
	return nil, false, nil
}

// parseV1 reads a PROXY protocol v1 text header line.
//
// Format: "PROXY <TCP4|TCP6|UNKNOWN> <src> <dst> <sport> <dport>\r\n"
// (UNKNOWN may omit the addresses). The line is at most 107 bytes including CRLF.
func parseV1(br *bufio.Reader) (net.Addr, bool, error) {
	// 107 is the spec maximum; read a touch more so a missing CRLF is reported as
	// malformed rather than silently truncated.
	line, err := readLineLimited(br, 108)
	if err != nil {
		return nil, false, fmt.Errorf("proxyproto v1: read header: %w", err)
	}
	if !strings.HasSuffix(line, "\r\n") {
		return nil, false, fmt.Errorf("proxyproto v1: header not CRLF-terminated")
	}
	fields := strings.Split(strings.TrimSuffix(line, "\r\n"), " ")
	if len(fields) < 2 || fields[0] != "PROXY" {
		return nil, false, fmt.Errorf("proxyproto v1: malformed header")
	}
	switch fields[1] {
	case "UNKNOWN":
		// The proxy could not determine the real address: a valid header that
		// carries none. Keep the raw peer.
		return nil, true, nil
	case "TCP4", "TCP6":
		if len(fields) != 6 {
			return nil, false, fmt.Errorf("proxyproto v1: %s header needs 6 fields, got %d", fields[1], len(fields))
		}
		ip := net.ParseIP(fields[2])
		if ip == nil {
			return nil, false, fmt.Errorf("proxyproto v1: bad source IP %q", fields[2])
		}
		port, err := strconv.Atoi(fields[4])
		if err != nil || port < 0 || port > 65535 {
			return nil, false, fmt.Errorf("proxyproto v1: bad source port %q", fields[4])
		}
		return &net.TCPAddr{IP: ip, Port: port}, true, nil
	default:
		return nil, false, fmt.Errorf("proxyproto v1: unknown protocol %q", fields[1])
	}
}

// readLineLimited reads through the next '\n' but no more than max bytes. A line
// that exceeds max (no terminator in range) is an error, so a peer cannot stream
// an unbounded "line".
func readLineLimited(br *bufio.Reader, max int) (string, error) {
	var sb strings.Builder
	for i := 0; i < max; i++ {
		b, err := br.ReadByte()
		if err != nil {
			return "", err
		}
		sb.WriteByte(b)
		if b == '\n' {
			return sb.String(), nil
		}
	}
	return "", fmt.Errorf("line exceeds %d bytes without CRLF", max)
}

// parseV2 reads a PROXY protocol v2 binary header. The 12-byte signature has
// already been confirmed via Peek but is still in the buffer; this consumes the
// full 16-byte fixed header plus the declared address block.
func parseV2(br *bufio.Reader) (net.Addr, bool, error) {
	hdr := make([]byte, 16)
	if _, err := io.ReadFull(br, hdr); err != nil {
		return nil, false, fmt.Errorf("proxyproto v2: read fixed header: %w", err)
	}
	// hdr[12]: high nibble = version (must be 2), low nibble = command (0 LOCAL, 1 PROXY).
	if hdr[12]>>4 != 0x2 {
		return nil, false, fmt.Errorf("proxyproto v2: unsupported version %d", hdr[12]>>4)
	}
	command := hdr[12] & 0x0F
	// hdr[13]: high nibble = address family, low nibble = transport protocol.
	family := hdr[13] >> 4
	transport := hdr[13] & 0x0F
	addrLen := int(binary.BigEndian.Uint16(hdr[14:16]))

	body := make([]byte, addrLen)
	if _, err := io.ReadFull(br, body); err != nil {
		return nil, false, fmt.Errorf("proxyproto v2: read %d-byte address block: %w", addrLen, err)
	}

	switch command {
	case 0x0:
		// LOCAL: the connection is the proxy's own (e.g. a health check); the
		// address block must be ignored. Valid header, no client address.
		return nil, true, nil
	case 0x1:
		// PROXY: a relayed connection; the address block carries the real peer.
	default:
		return nil, false, fmt.Errorf("proxyproto v2: unknown command %d", command)
	}

	// Only TCP over IPv4/IPv6 yields a usable TCP client address. Anything else
	// (UDP, AF_UNIX, UNSPEC) is a valid header we keep the raw peer for.
	const tcpStream = 0x1
	switch {
	case family == 0x1 && transport == tcpStream: // AF_INET
		if addrLen < 12 {
			return nil, false, fmt.Errorf("proxyproto v2: IPv4 block too short (%d)", addrLen)
		}
		ip := net.IPv4(body[0], body[1], body[2], body[3])
		port := int(binary.BigEndian.Uint16(body[8:10]))
		return &net.TCPAddr{IP: ip, Port: port}, true, nil
	case family == 0x2 && transport == tcpStream: // AF_INET6
		if addrLen < 36 {
			return nil, false, fmt.Errorf("proxyproto v2: IPv6 block too short (%d)", addrLen)
		}
		ip := make(net.IP, net.IPv6len)
		copy(ip, body[0:16])
		port := int(binary.BigEndian.Uint16(body[32:34]))
		return &net.TCPAddr{IP: ip, Port: port}, true, nil
	default:
		return nil, true, nil
	}
}

// parseProxyTrusted parses a comma-separated CIDR list (PROXY_PROTOCOL_TRUSTED).
// A bare IP is accepted as a /32 (IPv4) or /128 (IPv6) for convenience.
func parseProxyTrusted(spec string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, raw := range strings.Split(spec, ",") {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if !strings.Contains(entry, "/") {
			ip := net.ParseIP(entry)
			if ip == nil {
				return nil, fmt.Errorf("PROXY_PROTOCOL_TRUSTED: %q is not an IP or CIDR", entry)
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			entry = fmt.Sprintf("%s/%d", entry, bits)
		}
		_, n, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("PROXY_PROTOCOL_TRUSTED: %w", err)
		}
		out = append(out, n)
	}
	return out, nil
}
