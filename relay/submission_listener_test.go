package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-smtp"
)

type acceptSession struct{}

func (acceptSession) Reset()                               {}
func (acceptSession) Logout() error                        { return nil }
func (acceptSession) Mail(string, *smtp.MailOptions) error { return nil }
func (acceptSession) Rcpt(string, *smtp.RcptOptions) error { return nil }
func (acceptSession) Data(r io.Reader) error {
	_, err := io.Copy(io.Discard, r)
	return err
}

func servePlain(t *testing.T, cfg Config) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln = wrapSubmissionListener(ln, cfg, false, nil)
	srv := smtp.NewServer(smtp.BackendFunc(func(*smtp.Conn) (smtp.Session, error) {
		return acceptSession{}, nil
	}))
	srv.Domain = "localhost"
	srv.ReadTimeout = submissionReadTimeout(cfg.Submission.ReadTimeout)
	srv.WriteTimeout = submissionWriteTimeout(cfg.Submission.WriteTimeout)
	srv.ErrorLog = log.New(io.Discard, "", 0)
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

func readSMTP(t *testing.T, conn net.Conn, r *bufio.Reader) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var b strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("smtp read: %v (so far %q)", err, b.String())
		}
		b.WriteString(line)
		if len(line) >= 4 && line[3] == ' ' {
			return b.String()
		}
	}
}

func writeSMTP(t *testing.T, conn net.Conn, cmd string) {
	t.Helper()
	if _, err := io.WriteString(conn, cmd); err != nil {
		t.Fatalf("write %q: %v", cmd, err)
	}
}

func proxyCfg(t *testing.T, clear bool) ProxyProtocolCfg {
	t.Helper()
	cfg := ProxyProtocolCfg{
		Mode:    proxyRequire,
		Trusted: []*net.IPNet{mustNet(t, "127.0.0.1/32")},
		Timeout: 5 * time.Second,
	}
	if clear {
		cfg.deadlineRestore = func(inner net.Conn, _ time.Time, _ bool) {
			_ = inner.SetReadDeadline(time.Time{})
		}
	}
	return cfg
}

func dialProxy(t *testing.T, addr, ip string, port int) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	writeSMTP(t, conn, fmt.Sprintf("PROXY TCP4 %s 192.0.2.1 %d 587\r\n", ip, port))
	r := bufio.NewReader(conn)
	greet := readSMTP(t, conn, r)
	if !strings.HasPrefix(greet, "220") {
		t.Fatalf("greeting %q", greet)
	}
	return conn, r
}

func TestProxyHeaderThenIdleDrops(t *testing.T) {
	cfg := Config{}
	cfg.Submission.ReadTimeout = time.Second
	cfg.Submission.WriteTimeout = 5 * time.Second
	cfg.Submission.MaxConns = 20
	cfg.Submission.MaxConnsPerIP = 20
	cfg.Submission.ProxyProtocol = proxyCfg(t, false)
	addr := servePlain(t, cfg)

	conn, _ := dialProxy(t, addr, "203.0.113.9", 4000)
	time.Sleep(3 * time.Second)
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 128)
	n, err := conn.Read(buf)
	if err == nil && strings.Contains(string(buf[:n]), "250") {
		t.Fatalf("idle connection answered %q", buf[:n])
	}
	_, werr := io.WriteString(conn, "NOOP\r\n")
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	n2, rerr := conn.Read(buf)
	if werr == nil && rerr == nil && strings.Contains(string(buf[:n2]), "250") {
		t.Fatalf("idle connection still served NOOP: %q", buf[:n2])
	}
}

func TestClearingTheReadDeadlineKeepsTheIdleConnection(t *testing.T) {
	cfg := Config{}
	cfg.Submission.ReadTimeout = time.Second
	cfg.Submission.WriteTimeout = 5 * time.Second
	cfg.Submission.MaxConns = 20
	cfg.Submission.MaxConnsPerIP = 20
	cfg.Submission.ProxyProtocol = proxyCfg(t, true)
	addr := servePlain(t, cfg)

	conn, r := dialProxy(t, addr, "203.0.113.9", 4001)
	time.Sleep(3 * time.Second)
	writeSMTP(t, conn, "NOOP\r\n")
	reply := readSMTP(t, conn, r)
	if !strings.Contains(reply, "250") {
		t.Fatalf("control NOOP = %q, want 250", reply)
	}
}

func TestPerIPCapUsesProxyAddress(t *testing.T) {
	cfg := Config{}
	cfg.Submission.ReadTimeout = 30 * time.Second
	cfg.Submission.WriteTimeout = 30 * time.Second
	cfg.Submission.MaxConns = 10
	cfg.Submission.MaxConnsPerIP = 1
	cfg.Submission.ProxyProtocol = proxyCfg(t, false)
	addr := servePlain(t, cfg)

	c1, r1 := dialProxy(t, addr, "203.0.113.9", 4100)
	writeSMTP(t, c1, "EHLO t\r\n")
	if reply := readSMTP(t, c1, r1); !strings.Contains(reply, "250") {
		t.Fatalf("first source EHLO = %q", reply)
	}

	c2, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if _, err := io.WriteString(c2, "PROXY TCP4 203.0.113.9 192.0.2.1 4101 587\r\n"); err != nil {
		t.Fatal(err)
	}
	_ = c2.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	n, _ := c2.Read(buf) // greeting may already have been written
	if _, err := io.WriteString(c2, "EHLO t\r\n"); err != nil {
		// closed before the command is the cap working
	} else {
		_ = c2.SetReadDeadline(time.Now().Add(2 * time.Second))
		n2, rerr := c2.Read(buf)
		got := string(buf[:n]) + string(buf[:n2])
		if rerr == nil && strings.Contains(string(buf[:n2]), "250") {
			t.Fatalf("second connection from the same source was accepted: %q", got)
		}
	}

	writeSMTP(t, c1, "NOOP\r\n")
	if reply := readSMTP(t, c1, r1); !strings.Contains(reply, "250") {
		t.Fatalf("first connection NOOP = %q", reply)
	}

	c3, r3 := dialProxy(t, addr, "203.0.113.10", 4102)
	writeSMTP(t, c3, "EHLO t\r\n")
	if reply := readSMTP(t, c3, r3); !strings.Contains(reply, "250") {
		t.Fatalf("second source EHLO = %q", reply)
	}
}

func TestSlowDataSurvivesTheIdleLimit(t *testing.T) {
	cfg := Config{}
	cfg.Submission.ReadTimeout = 2 * time.Second
	cfg.Submission.WriteTimeout = 5 * time.Second
	cfg.Submission.MaxConns = 4
	cfg.Submission.MaxConnsPerIP = 4
	addr := servePlain(t, cfg)

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	if greet := readSMTP(t, conn, r); !strings.HasPrefix(greet, "220") {
		t.Fatalf("greeting %q", greet)
	}
	writeSMTP(t, conn, "EHLO t\r\n")
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "MAIL FROM:<a@example.org>\r\n")
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "RCPT TO:<b@example.org>\r\n")
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "DATA\r\n")
	if data := readSMTP(t, conn, r); !strings.HasPrefix(data, "354") {
		t.Fatalf("DATA reply %q", data)
	}
	writeSMTP(t, conn, "Subject: s\r\n\r\n")
	for i := 0; i < 8; i++ {
		time.Sleep(400 * time.Millisecond)
		if _, err := conn.Write([]byte{'A' + byte(i)}); err != nil {
			t.Fatalf("body byte %d: %v", i, err)
		}
	}
	writeSMTP(t, conn, "\r\n.\r\n")
	if reply := readSMTP(t, conn, r); !strings.HasPrefix(reply, "250") {
		t.Fatalf("slow DATA reply %q", reply)
	}
}

func TestStalledDataIsCutAtTheIdleLimit(t *testing.T) {
	cfg := Config{}
	cfg.Submission.ReadTimeout = time.Second
	cfg.Submission.WriteTimeout = 5 * time.Second
	cfg.Submission.MaxConns = 4
	cfg.Submission.MaxConnsPerIP = 4
	addr := servePlain(t, cfg)

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "EHLO t\r\n")
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "MAIL FROM:<a@example.org>\r\n")
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "RCPT TO:<b@example.org>\r\n")
	readSMTP(t, conn, r)
	writeSMTP(t, conn, "DATA\r\n")
	if data := readSMTP(t, conn, r); !strings.HasPrefix(data, "354") {
		t.Fatalf("DATA reply %q", data)
	}
	writeSMTP(t, conn, "Subject: s\r\n\r\nhello")
	time.Sleep(2500 * time.Millisecond)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	n, err := conn.Read(buf)
	if err == nil && strings.Contains(string(buf[:n]), "250") {
		t.Fatalf("stalled DATA was accepted: %q", buf[:n])
	}
}
