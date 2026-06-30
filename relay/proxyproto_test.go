package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// --- test doubles --------------------------------------------------------

// scriptConn is a net.Conn whose Read serves a fixed byte script then either
// returns io.EOF or, when timeout is set, a timeout net.Error (to model a peer
// that connects and then stays silent waiting for the SMTP greeting). RemoteAddr
// is the configurable raw immediate peer.
type scriptConn struct {
	r       *bytes.Reader
	remote  net.Addr
	timeout bool
	closed  bool
}

func newScriptConn(script []byte, remote net.Addr) *scriptConn {
	return &scriptConn{r: bytes.NewReader(script), remote: remote}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func (c *scriptConn) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if err == io.EOF && c.timeout && n == 0 {
		return 0, timeoutErr{}
	}
	return n, err
}
func (c *scriptConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *scriptConn) Close() error                     { c.closed = true; return nil }
func (c *scriptConn) LocalAddr() net.Addr              { return &net.TCPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 587} }
func (c *scriptConn) RemoteAddr() net.Addr             { return c.remote }
func (c *scriptConn) SetDeadline(time.Time) error      { return nil }
func (c *scriptConn) SetReadDeadline(time.Time) error  { return nil }
func (c *scriptConn) SetWriteDeadline(time.Time) error { return nil }

func tcp(ip string, port int) *net.TCPAddr {
	return &net.TCPAddr{IP: net.ParseIP(ip), Port: port}
}

// v2Header builds a PROXY protocol v2 header (PROXY command) for the given family.
func v2HeaderIPv4(srcIP string, srcPort int, dstIP string, dstPort int) []byte {
	b := append([]byte{}, v2Signature...)
	b = append(b, 0x21)      // version 2, command PROXY
	b = append(b, 0x11)      // AF_INET, STREAM
	addr := make([]byte, 12) // 4 src + 4 dst + 2 sport + 2 dport
	copy(addr[0:4], net.ParseIP(srcIP).To4())
	copy(addr[4:8], net.ParseIP(dstIP).To4())
	binary.BigEndian.PutUint16(addr[8:10], uint16(srcPort))
	binary.BigEndian.PutUint16(addr[10:12], uint16(dstPort))
	lb := make([]byte, 2)
	binary.BigEndian.PutUint16(lb, uint16(len(addr)))
	b = append(b, lb...)
	return append(b, addr...)
}

func v2HeaderIPv6(srcIP string, srcPort int) []byte {
	b := append([]byte{}, v2Signature...)
	b = append(b, 0x21) // version 2, command PROXY
	b = append(b, 0x21) // AF_INET6, STREAM
	addr := make([]byte, 36)
	copy(addr[0:16], net.ParseIP(srcIP).To16())
	copy(addr[16:32], net.ParseIP("2001:db8::1").To16())
	binary.BigEndian.PutUint16(addr[32:34], uint16(srcPort))
	binary.BigEndian.PutUint16(addr[34:36], 587)
	lb := make([]byte, 2)
	binary.BigEndian.PutUint16(lb, uint16(len(addr)))
	b = append(b, lb...)
	return append(b, addr...)
}

func v2HeaderLocal() []byte {
	b := append([]byte{}, v2Signature...)
	b = append(b, 0x20) // version 2, command LOCAL
	b = append(b, 0x00) // AF_UNSPEC
	b = append(b, 0x00, 0x00)
	return b
}

// --- parser-level table tests --------------------------------------------

func TestParseProxyHeader(t *testing.T) {
	smtp := []byte("EHLO client.example\r\n")

	tests := []struct {
		name     string
		input    []byte
		wantHdr  bool
		wantErr  bool
		wantAddr string // "" means nil (no usable client address)
		wantRest string // bytes that must remain after the header is consumed
	}{
		{
			name:     "v1 TCP4",
			input:    append([]byte("PROXY TCP4 203.0.113.7 198.51.100.2 51000 587\r\n"), smtp...),
			wantHdr:  true,
			wantAddr: "203.0.113.7:51000",
			wantRest: string(smtp),
		},
		{
			name:     "v1 TCP6",
			input:    append([]byte("PROXY TCP6 2001:db8::7 2001:db8::2 51000 587\r\n"), smtp...),
			wantHdr:  true,
			wantAddr: "[2001:db8::7]:51000",
			wantRest: string(smtp),
		},
		{
			name:     "v1 UNKNOWN keeps raw peer",
			input:    append([]byte("PROXY UNKNOWN\r\n"), smtp...),
			wantHdr:  true,
			wantAddr: "",
			wantRest: string(smtp),
		},
		{
			name:    "v1 bad source IP is malformed",
			input:   []byte("PROXY TCP4 not-an-ip 198.51.100.2 51000 587\r\n"),
			wantErr: true,
		},
		{
			name:    "v1 wrong field count is malformed",
			input:   []byte("PROXY TCP4 203.0.113.7 198.51.100.2 51000\r\n"),
			wantErr: true,
		},
		{
			name:    "v1 no CRLF within bound is malformed",
			input:   []byte("PROXY TCP4 203.0.113.7 198.51.100.2 51000 587 padding-with-no-crlf-................................................................"),
			wantErr: true,
		},
		{
			name:     "v2 IPv4",
			input:    append(v2HeaderIPv4("203.0.113.9", 40000, "198.51.100.2", 587), smtp...),
			wantHdr:  true,
			wantAddr: "203.0.113.9:40000",
			wantRest: string(smtp),
		},
		{
			name:     "v2 IPv6",
			input:    append(v2HeaderIPv6("2001:db8::9", 40000), smtp...),
			wantHdr:  true,
			wantAddr: "[2001:db8::9]:40000",
			wantRest: string(smtp),
		},
		{
			name:     "v2 LOCAL keeps raw peer",
			input:    append(v2HeaderLocal(), smtp...),
			wantHdr:  true,
			wantAddr: "",
			wantRest: string(smtp),
		},
		{
			name:    "no header: plain SMTP",
			input:   smtp,
			wantHdr: false,
		},
		{
			name:    "no header: empty stream",
			input:   []byte{},
			wantHdr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			br := bufio.NewReader(bytes.NewReader(tt.input))
			addr, had, err := parseProxyHeader(br)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want error, got addr=%v had=%v", addr, had)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if had != tt.wantHdr {
				t.Fatalf("had=%v want %v", had, tt.wantHdr)
			}
			gotAddr := ""
			if addr != nil {
				gotAddr = addr.String()
			}
			if gotAddr != tt.wantAddr {
				t.Fatalf("addr=%q want %q", gotAddr, tt.wantAddr)
			}
			if tt.wantRest != "" {
				rest, _ := io.ReadAll(br)
				if string(rest) != tt.wantRest {
					t.Fatalf("remaining stream=%q want %q", rest, tt.wantRest)
				}
			}
		})
	}
}

// --- trust gate + mode matrix (proxyConn end to end) ---------------------

func mustNet(t *testing.T, cidr string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatalf("bad test CIDR %q: %v", cidr, err)
	}
	return n
}

func TestProxyConnTrustAndModeMatrix(t *testing.T) {
	trusted := []*net.IPNet{mustNet(t, "192.0.2.0/24")}
	header := append([]byte("PROXY TCP4 203.0.113.7 198.51.100.2 51000 587\r\n"), []byte("EHLO x\r\n")...)
	const realClient = "203.0.113.7:51000"

	type want struct {
		remote    string // expected RemoteAddr after resolve
		cleanDrop bool   // first Read returns io.EOF (a clean operational drop: untrusted, or headerless in require)
		firstRead string // when no drop: the bytes the first Read should surface (header consumed or not)
	}

	tests := []struct {
		name    string
		mode    proxyMode
		peer    net.Addr
		script  []byte
		timeout bool
		want    want
	}{
		{
			name:   "optional trusted with header: honored",
			mode:   proxyOptional,
			peer:   tcp("192.0.2.3", 5000),
			script: header,
			want:   want{remote: realClient, firstRead: "EHLO x\r\n"},
		},
		{
			name:   "optional trusted no header: fallback to raw peer",
			mode:   proxyOptional,
			peer:   tcp("192.0.2.3", 5000),
			script: []byte("EHLO x\r\n"),
			want:   want{remote: "192.0.2.3:5000", firstRead: "EHLO x\r\n"},
		},
		{
			name:    "optional trusted silent: deadline -> fallback to raw peer",
			mode:    proxyOptional,
			peer:    tcp("192.0.2.3", 5000),
			script:  []byte{},
			timeout: true,
			want:    want{remote: "192.0.2.3:5000"},
		},
		{
			name:   "optional UNTRUSTED with header: NOT honored, header left in stream (anti-spoof)",
			mode:   proxyOptional,
			peer:   tcp("203.0.113.50", 6000),
			script: header,
			// raw peer kept; the forged header bytes are NOT consumed, so the SMTP
			// parser sees them and rejects -- proven by the first Read returning them.
			want: want{remote: "203.0.113.50:6000", firstRead: "PROXY TCP4 203.0.113.7"},
		},
		{
			name:   "require trusted with header: honored",
			mode:   proxyRequire,
			peer:   tcp("192.0.2.3", 5000),
			script: header,
			want:   want{remote: realClient, firstRead: "EHLO x\r\n"},
		},
		{
			// The LB's TCP health check is a bare connect with NO header; in require
			// mode from the trusted LB source it must be a CLEAN drop (io.EOF), not a
			// loud error, so the probes never pollute logs or the throttle.
			name:   "require trusted no header (LB health check): clean drop",
			mode:   proxyRequire,
			peer:   tcp("192.0.2.3", 5000),
			script: []byte("EHLO x\r\n"),
			want:   want{remote: "192.0.2.3:5000", cleanDrop: true},
		},
		{
			name:   "require UNTRUSTED: clean drop",
			mode:   proxyRequire,
			peer:   tcp("203.0.113.50", 6000),
			script: header,
			want:   want{remote: "203.0.113.50:6000", cleanDrop: true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sc := newScriptConn(tt.script, tt.peer)
			sc.timeout = tt.timeout
			cfg := ProxyProtocolCfg{Mode: tt.mode, Trusted: trusted, Timeout: time.Second}
			c := &proxyConn{Conn: sc, cfg: cfg}

			if got := c.RemoteAddr().String(); got != tt.want.remote {
				t.Fatalf("RemoteAddr=%q want %q", got, tt.want.remote)
			}

			buf := make([]byte, 64)
			if tt.want.cleanDrop {
				_, err := c.Read(buf)
				// go-smtp treats io.EOF as a normal disconnect (returns nil, logs
				// nothing): that is what makes the drop "clean". Anything else would
				// surface as a logged "error handling" line.
				if err != io.EOF {
					t.Fatalf("want a clean io.EOF drop, got err=%v", err)
				}
				return
			}
			// Only assert on the post-resolve stream when the case expects bytes.
			// The silent-fallback case (firstRead == "") has no client data to read;
			// its only assertion is the raw-peer RemoteAddr checked above.
			if tt.want.firstRead != "" {
				n, err := c.Read(buf)
				if err != nil && err != io.EOF {
					t.Fatalf("unexpected Read error: %v", err)
				}
				if !strings.HasPrefix(string(buf[:n]), tt.want.firstRead) {
					t.Fatalf("first Read=%q want prefix %q", buf[:n], tt.want.firstRead)
				}
			}
		})
	}
}

// A malformed PROXY header from a TRUSTED peer is a hard fault, not a clean drop:
// the LB is expected to speak the protocol correctly, so corrupt framing must
// surface LOUD (a non-EOF error go-smtp logs), never be silently swallowed.
func TestProxyConnMalformedFromTrustedIsLoud(t *testing.T) {
	trusted := []*net.IPNet{mustNet(t, "192.0.2.0/24")}
	// A v1 header that begins correctly but has a bad source IP (parse fault).
	bad := []byte("PROXY TCP4 not-an-ip 198.51.100.2 51000 587\r\n")
	sc := newScriptConn(bad, tcp("192.0.2.3", 5000))
	c := &proxyConn{Conn: sc, cfg: ProxyProtocolCfg{Mode: proxyRequire, Trusted: trusted, Timeout: time.Second}}

	_, err := c.Read(make([]byte, 64))
	if err == nil || err == io.EOF {
		t.Fatalf("want a loud (non-EOF) error for a malformed header from a trusted peer, got %v", err)
	}
	if !strings.Contains(err.Error(), "proxyproto v1") {
		t.Fatalf("error %q should identify the proxyproto v1 parse fault", err)
	}
}

// off mode must wrap nothing: the raw listener is returned unchanged so behavior
// is byte-for-byte the prior deploy.
func TestWrapProxyListenerOffIsNoOp(t *testing.T) {
	base := &fakeListener{}
	if got := wrapProxyListener(base, ProxyProtocolCfg{Mode: proxyOff}); got != base {
		t.Fatalf("off mode wrapped the listener (%T); want the raw listener returned unchanged", got)
	}
	on := wrapProxyListener(base, ProxyProtocolCfg{Mode: proxyRequire, Trusted: []*net.IPNet{mustNet(t, "192.0.2.0/24")}})
	if on == base {
		t.Fatalf("enabled mode did not wrap the listener")
	}
}

type fakeListener struct{}

func (*fakeListener) Accept() (net.Conn, error) { return nil, io.EOF }
func (*fakeListener) Close() error              { return nil }
func (*fakeListener) Addr() net.Addr            { return &net.TCPAddr{} }

func TestParseProxyTrusted(t *testing.T) {
	got, err := parseProxyTrusted("192.0.2.0/24, 203.0.113.5, 2001:db8::/32")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("parsed %d nets, want 3", len(got))
	}
	// bare IPv4 becomes /32
	if got[1].String() != "203.0.113.5/32" {
		t.Fatalf("bare IP net=%q want 203.0.113.5/32", got[1].String())
	}
	if _, err := parseProxyTrusted("not-a-cidr"); err == nil {
		t.Fatalf("want error on bad CIDR")
	}
}
