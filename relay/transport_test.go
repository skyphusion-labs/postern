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
	// bare CR and bare LF (not just the CRLF pair) must also be stripped.
	if got := sanitizeHeader("a\rb\nc"); got != "abc" {
		t.Errorf("sanitizeHeader bare CR/LF = %q, want abc", got)
	}
}

func TestHasControlRunes(t *testing.T) {
	if hasControlRunes("normal text") {
		t.Error("normal text flagged as control")
	}
	if !hasControlRunes("bad\x00null") {
		t.Error("NUL not detected")
	}
	if !hasControlRunes("bare\rCR") || !hasControlRunes("bare\nLF") {
		t.Error("bare CR/LF not detected")
	}
	if hasControlRunes("tab\tok") {
		t.Error("tab should be allowed")
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

func TestParseHeaderAddress(t *testing.T) {
	good := []string{"a@x", "dest@example.com", "Alice <alice@example.com>"}
	for _, g := range good {
		if _, err := parseHeaderAddress(g); err != nil {
			t.Errorf("parseHeaderAddress(%q) errored: %v", g, err)
		}
	}
	bad := []string{
		"victim@x\r\nBcc: attacker@evil.com", // CRLF injection
		"victim@x\nBcc: attacker@evil.com",   // bare LF
		"victim@x\rBcc: attacker@evil.com",   // bare CR
		"not-an-address",                     // no @
		"a@x\x00b",                           // NUL control char
		"",                                   // empty
	}
	for _, b := range bad {
		if _, err := parseHeaderAddress(b); err == nil {
			t.Errorf("parseHeaderAddress(%q) accepted a bad address", b)
		}
	}
}

func TestFormatAddress(t *testing.T) {
	// formatAddress now parses + re-renders to the RFC 5322 canonical form, so a
	// bare address is angle-bracketed and a display name is quoted.
	if got, err := formatAddress(EmailAddress{Email: "a@x"}, ""); err != nil || got != "<a@x>" {
		t.Errorf("bare = %q, err = %v", got, err)
	}
	if got, err := formatAddress(EmailAddress{Email: "a@x", Name: "Alice"}, ""); err != nil || got != `"Alice" <a@x>` {
		t.Errorf("named = %q, err = %v", got, err)
	}
	if got, err := formatAddress(EmailAddress{Name: "Alice"}, "fallback@x"); err != nil || got != `"Alice" <fallback@x>` {
		t.Errorf("fallback = %q, err = %v", got, err)
	}
	// A malformed / injected address is rejected, not rendered.
	if _, err := formatAddress(EmailAddress{Email: "victim@x\r\nBcc: e@evil.com"}, ""); err == nil {
		t.Error("formatAddress accepted a CRLF-injected address")
	}
	if _, err := formatAddress(EmailAddress{Email: "not-an-address"}, ""); err == nil {
		t.Error("formatAddress accepted a malformed address")
	}
}

func TestHeaderAddressList(t *testing.T) {
	got, err := headerAddressList([]string{"a@x", "Bob <b@y>"})
	if err != nil {
		t.Fatalf("headerAddressList: %v", err)
	}
	if got != `<a@x>, "Bob" <b@y>` {
		t.Errorf("headerAddressList = %q", got)
	}
	// One bad entry rejects the whole list (fail closed).
	if _, err := headerAddressList([]string{"a@x", "victim@y\r\nBcc: e@evil.com"}); err == nil {
		t.Error("headerAddressList accepted a CRLF-injected entry")
	}
	if _, err := headerAddressList(nil); err == nil {
		t.Error("headerAddressList accepted an empty list")
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
	// Addresses are now emitted in canonical RFC 5322 form.
	assertContains(t, raw, `From: "Postern" <noreply@skyphusion.org>`)
	assertContains(t, raw, "To: <dest@example.com>")
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
	// header is ever emitted. Check for an injected header LINE, not a substring.
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
	assertContains(t, raw, "X-Trace: abcInjected: yes")
	assertContains(t, raw, "Subject: okBcc: attacker@evil.com")
}

// TestRenderMIME_RejectsAddressInjection is the core regression for the
// go/email-injection alert: caller-controlled address fields (To/Cc/From/
// Reply-To) carrying CR/LF (or a bare CR / bare LF) must cause renderMIME to
// FAIL and emit nothing, so an attacker cannot smuggle headers via a recipient.
func TestRenderMIME_RejectsAddressInjection(t *testing.T) {
	base := func() OutboundMessage {
		return OutboundMessage{
			MessageID: "id@x",
			To:        []string{"dest@example.com"},
			From:      EmailAddress{Email: "noreply@skyphusion.org"},
			Subject:   "s",
			Text:      "body",
		}
	}
	inject := "victim@example.com\r\nBcc: attacker@evil.com"
	bareLF := "victim@example.com\nBcc: attacker@evil.com"
	bareCR := "victim@example.com\rBcc: attacker@evil.com"

	cases := map[string]func(*OutboundMessage){
		"To CRLF":      func(m *OutboundMessage) { m.To = []string{inject} },
		"To bare LF":   func(m *OutboundMessage) { m.To = []string{bareLF} },
		"To bare CR":   func(m *OutboundMessage) { m.To = []string{bareCR} },
		"Cc CRLF":      func(m *OutboundMessage) { m.CC = []string{inject} },
		"From CRLF":    func(m *OutboundMessage) { m.From = EmailAddress{Email: inject} },
		"ReplyTo CRLF": func(m *OutboundMessage) { m.ReplyTo = &EmailAddress{Email: inject} },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			m := base()
			mut(&m)
			raw, err := renderMIME(m, m.From.Email)
			if err == nil {
				t.Fatalf("renderMIME accepted injected address; output:\n%s", raw)
			}
			if raw != nil {
				t.Errorf("renderMIME returned bytes alongside the error: %q", raw)
			}
		})
	}
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

func startSink(t *testing.T) (*sinkBackend, *SMTPTransport) {
	t.Helper()
	be := &sinkBackend{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := smtp.NewServer(be)
	srv.AllowInsecureAuth = true
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { srv.Close(); ln.Close() })

	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port parse: %v", err)
	}
	tr := NewSMTPTransport(SMTPOutCfg{
		Host: host, Port: port, StartTLS: false, Timeout: 5 * time.Second,
	}, "fallback@skyphusion.org")
	return be, tr
}

func TestSMTPTransport_Dispatch_EndToEnd(t *testing.T) {
	be, tr := startSink(t)

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

	waitData(t, be)

	be.mu.Lock()
	defer be.mu.Unlock()
	if be.from != "noreply@skyphusion.org" {
		t.Errorf("MAIL FROM = %q", be.from)
	}
	wantRcpts := []string{"dest@example.com", "copy@example.com", "hidden@example.com"}
	if !reflect.DeepEqual(be.rcpts, wantRcpts) {
		t.Errorf("RCPT TO = %#v, want %#v", be.rcpts, wantRcpts)
	}
	if strings.Contains(be.data, "hidden@example.com") {
		t.Errorf("BCC leaked into headers:\n%s", be.data)
	}
	assertContains(t, be.data, "Subject: end to end")
	assertContains(t, be.data, "delivered")
}

// TestSMTPTransport_Dispatch_RejectsInjectionEndToEnd proves the taint is broken
// all the way to the wire: an injected recipient makes Dispatch fail and NOTHING
// is written to the upstream SMTP server (no smuggled header reaches DATA).
func TestSMTPTransport_Dispatch_RejectsInjectionEndToEnd(t *testing.T) {
	be, tr := startSink(t)

	msg := OutboundMessage{
		MessageID: "evil@skyphusion.org",
		To:        []string{"victim@example.com\r\nBcc: attacker@evil.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "hi",
		Text:      "body",
	}
	if _, err := tr.Dispatch(msg); err == nil {
		t.Fatal("Dispatch accepted an injected recipient")
	}

	// Give any (erroneous) delivery a moment, then assert the sink saw nothing.
	time.Sleep(100 * time.Millisecond)
	be.mu.Lock()
	defer be.mu.Unlock()
	if be.data != "" || len(be.rcpts) != 0 {
		t.Errorf("injected message reached the SMTP server: data=%q rcpts=%#v", be.data, be.rcpts)
	}
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

func waitData(t *testing.T, be *sinkBackend) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		be.mu.Lock()
		done := be.data != ""
		be.mu.Unlock()
		if done {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

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
