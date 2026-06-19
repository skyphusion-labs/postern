package main

import (
	"io"
	"net"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-smtp"
)

func TestRecipients_DedupAndOrder(t *testing.T) {
	m := OutboundMessage{
		To:  []string{"a@x", "b@x"},
		CC:  []string{"b@x", "c@x"}, // b@x is a dup of To
		BCC: []string{"d@x", ""},    // empty entry dropped
	}
	got := m.recipients()
	want := []string{"a@x", "b@x", "c@x", "d@x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("recipients() = %#v, want %#v", got, want)
	}
}

func TestSanitizeHeader(t *testing.T) {
	// CR/LF must be stripped so a value cannot inject another header.
	in := "Subject value\r\nBcc: attacker@evil.com"
	out := sanitizeHeader(in)
	if strings.ContainsAny(out, "\r\n") {
		t.Errorf("sanitizeHeader left CR/LF in %q", out)
	}
	if out != "Subject valueBcc: attacker@evil.com" {
		t.Errorf("sanitizeHeader = %q", out)
	}
}

func TestIsReservedHeader(t *testing.T) {
	for _, h := range []string{"From", "to", "Subject", "Message-ID", "content-type"} {
		if !isReservedHeader(h) {
			t.Errorf("isReservedHeader(%q) = false, want true", h)
		}
	}
	for _, h := range []string{"X-Custom", "List-Unsubscribe", ""} {
		if isReservedHeader(h) {
			t.Errorf("isReservedHeader(%q) = true, want false", h)
		}
	}
}

func TestFormatAddress(t *testing.T) {
	if got := formatAddress(EmailAddress{Email: "a@x"}, ""); got != "a@x" {
		t.Errorf("bare = %q", got)
	}
	if got := formatAddress(EmailAddress{Email: "a@x", Name: "Alice"}, ""); got != "Alice <a@x>" {
		t.Errorf("named = %q", got)
	}
	if got := formatAddress(EmailAddress{Name: "Alice"}, "fallback@x"); got != "Alice <fallback@x>" {
		t.Errorf("fallback email = %q", got)
	}
}

func TestRenderMIME_TextOnly(t *testing.T) {
	msg := OutboundMessage{
		MessageID: "id@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org", Name: "Postern"},
		Subject:   "hi",
		Text:      "plain body",
	}
	raw := mustRender(t, msg)
	// ASCII display names are not Q-encoded (mime.QEncoding only encodes non-ASCII).
	assertContains(t, raw, "From: Postern <noreply@skyphusion.org>")
	assertContains(t, raw, "To: dest@example.com")
	assertContains(t, raw, "Message-ID: <id@skyphusion.org>")
	assertContains(t, raw, "Content-Type: text/plain; charset=utf-8")
	assertContains(t, raw, "plain body")
}

func TestRenderMIME_Multipart(t *testing.T) {
	msg := OutboundMessage{
		MessageID: "id@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "hi",
		Text:      "plain",
		HTML:      "<p>rich</p>",
	}
	raw := mustRender(t, msg)
	assertContains(t, raw, "Content-Type: multipart/alternative;")
	assertContains(t, raw, "text/plain; charset=utf-8")
	assertContains(t, raw, "text/html; charset=utf-8")
}

func TestRenderMIME_HeaderInjectionBlocked(t *testing.T) {
	// A malicious subject and a reserved-name custom header must not break out.
	msg := OutboundMessage{
		MessageID: "id@x",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "ok\r\nBcc: attacker@evil.com",
		Text:      "body",
		Headers: map[string]string{
			"Bcc":     "attacker2@evil.com", // reserved -> dropped
			"X-Trace": "abc\r\nInjected: yes",
		},
	}
	raw := mustRender(t, msg)
	// The attack would only succeed if the malicious text became its OWN header
	// line. Sanitizing CR/LF collapses it onto the existing line, so no new
	// header is ever emitted. Check for an injected header LINE, not a substring
	// (the sanitized text legitimately still contains the original characters).
	for _, line := range strings.Split(raw, "\r\n") {
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "bcc:") {
			t.Errorf("Bcc header was injected: %q", line)
		}
		if strings.HasPrefix(line, "Injected:") {
			t.Errorf("CR/LF in a custom header injected a new header line: %q", line)
		}
	}
	// The reserved Bcc header from Headers{} must have been dropped entirely.
	if strings.Contains(raw, "attacker2@evil.com") {
		t.Errorf("reserved Bcc header from Headers{} was not dropped:\n%s", raw)
	}
	// The custom X-Trace survives as a single sanitized line.
	assertContains(t, raw, "X-Trace: abcInjected: yes")
	// And the malicious subject is one collapsed line, not two.
	assertContains(t, raw, "Subject: okBcc: attacker@evil.com")
}

// --- end-to-end Dispatch against an in-process SMTP sink ---

type sinkBackend struct {
	mu    sync.Mutex
	from  string
	rcpts []string
	data  string
}

func (b *sinkBackend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	return &sinkSession{b: b}, nil
}

type sinkSession struct {
	b *sinkBackend
}

func (s *sinkSession) Mail(from string, _ *smtp.MailOptions) error {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.from = from
	return nil
}
func (s *sinkSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.rcpts = append(s.b.rcpts, to)
	return nil
}
func (s *sinkSession) Data(r io.Reader) error {
	body, _ := io.ReadAll(r)
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.data = string(body)
	return nil
}
func (s *sinkSession) Reset()        {}
func (s *sinkSession) Logout() error { return nil }

func TestSMTPTransport_Dispatch_EndToEnd(t *testing.T) {
	be := &sinkBackend{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	srv := smtp.NewServer(be)
	srv.AllowInsecureAuth = true
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port parse: %v", err)
	}

	tr := NewSMTPTransport(SMTPOutCfg{
		Host:     host,
		Port:     port,
		StartTLS: false, // sink does not offer STARTTLS
		Timeout:  5 * time.Second,
	}, "fallback@skyphusion.org")

	msg := OutboundMessage{
		MessageID: "e2e@skyphusion.org",
		To:        []string{"dest@example.com"},
		CC:        []string{"copy@example.com"},
		BCC:       []string{"hidden@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "end to end",
		Text:      "delivered",
	}

	res, err := tr.Dispatch(msg)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if res.ProviderMessageID != "e2e@skyphusion.org" {
		t.Errorf("providerMessageId = %q", res.ProviderMessageID)
	}

	// allow the goroutine to record
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		be.mu.Lock()
		done := be.data != ""
		be.mu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	be.mu.Lock()
	defer be.mu.Unlock()
	if be.from != "noreply@skyphusion.org" {
		t.Errorf("MAIL FROM = %q", be.from)
	}
	// all three of to+cc+bcc must be envelope recipients
	wantRcpts := []string{"dest@example.com", "copy@example.com", "hidden@example.com"}
	if !reflect.DeepEqual(be.rcpts, wantRcpts) {
		t.Errorf("RCPT TO = %#v, want %#v", be.rcpts, wantRcpts)
	}
	// the BCC recipient must NOT appear in the headers (envelope-only)
	if strings.Contains(be.data, "hidden@example.com") {
		t.Errorf("BCC leaked into headers:\n%s", be.data)
	}
	assertContains(t, be.data, "Subject: end to end")
	assertContains(t, be.data, "delivered")
}

func TestNewTransport_RequiresHost(t *testing.T) {
	if _, err := newTransport(Config{}); err == nil {
		t.Error("newTransport with no SMTP_OUT_HOST should error")
	}
	if _, err := newTransport(Config{SMTPOut: SMTPOutCfg{Host: "smtp.example.com"}}); err != nil {
		t.Errorf("newTransport with host should succeed, got %v", err)
	}
}

// --- helpers ---

func mustRender(t *testing.T, msg OutboundMessage) string {
	t.Helper()
	raw, err := renderMIME(msg, msg.From.Email)
	if err != nil {
		t.Fatalf("renderMIME: %v", err)
	}
	return string(raw)
}

func assertContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected to contain %q, got:\n%s", needle, haystack)
	}
}
