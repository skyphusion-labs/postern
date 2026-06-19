package main

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"

	"github.com/jhillyerd/enmime"
)

func TestStripAngles(t *testing.T) {
	cases := map[string]string{
		"<id@host>":     "id@host",
		"  <id@host>  ": "id@host",
		"id@host":       "id@host",
		"":              "",
		"<>":            "",
		"< spaced@x >":  "spaced@x",
	}
	for in, want := range cases {
		if got := stripAngles(in); got != want {
			t.Errorf("stripAngles(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseReferences(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{"<a@x>", []string{"a@x"}},
		{"<a@x> <b@x>", []string{"a@x", "b@x"}},
		{"<a@x>\r\n <b@x>\r\n <c@x>", []string{"a@x", "b@x", "c@x"}},
	}
	for _, c := range cases {
		if got := parseReferences(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseReferences(%q) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestParseDateISO(t *testing.T) {
	// A valid RFC 5322 date normalizes to RFC 3339 in UTC.
	got := parseDateISO("Mon, 02 Jan 2006 15:04:05 -0700")
	want := "2006-01-02T22:04:05.000Z"
	if got != want {
		t.Errorf("parseDateISO valid = %q, want %q", got, want)
	}
	// Missing / unparseable -> empty so core defaults to now.
	if got := parseDateISO(""); got != "" {
		t.Errorf("parseDateISO empty = %q, want empty", got)
	}
	if got := parseDateISO("not a date"); got != "" {
		t.Errorf("parseDateISO garbage = %q, want empty", got)
	}
}

// envelope parses a raw MIME string into an enmime.Envelope the same way the
// SMTP Data handler does.
func envelope(t *testing.T, raw string) *enmime.Envelope {
	t.Helper()
	env, err := enmime.ReadEnvelope(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("ReadEnvelope: %v", err)
	}
	return env
}

func TestBuildParsedInbound_BasicHeaders(t *testing.T) {
	raw := "From: Alice <alice@example.com>\r\n" +
		"Subject: Hello there\r\n" +
		"Message-ID: <abc123@example.com>\r\n" +
		"In-Reply-To: <prev@example.com>\r\n" +
		"References: <root@example.com> <prev@example.com>\r\n" +
		"Date: Mon, 02 Jan 2006 15:04:05 -0700\r\n" +
		"Content-Type: text/plain\r\n\r\n" +
		"the body\r\n"

	p := buildParsedInbound([]string{"dest@skyphusion.org", "cc@skyphusion.org"}, "alice@example.com", envelope(t, raw))

	if p.To != "dest@skyphusion.org" {
		t.Errorf("To = %q, want the first RCPT TO", p.To)
	}
	if p.From != "alice@example.com" {
		t.Errorf("From = %q, want header From", p.From)
	}
	if p.Subject != "Hello there" {
		t.Errorf("Subject = %q", p.Subject)
	}
	if p.MessageID != "abc123@example.com" {
		t.Errorf("MessageID = %q, want angle-stripped", p.MessageID)
	}
	if p.InReplyTo != "prev@example.com" {
		t.Errorf("InReplyTo = %q", p.InReplyTo)
	}
	if !reflect.DeepEqual(p.References, []string{"root@example.com", "prev@example.com"}) {
		t.Errorf("References = %#v", p.References)
	}
	if p.Date != "2006-01-02T22:04:05.000Z" {
		t.Errorf("Date = %q, want normalized ISO", p.Date)
	}
	if strings.TrimSpace(p.Text) != "the body" {
		t.Errorf("Text = %q", p.Text)
	}
	// The relay never invents auth verdicts (core does allowlist-only trust).
	if p.Auth != nil {
		t.Errorf("Auth = %#v, want nil (relay supplies no verdicts)", p.Auth)
	}
}

func TestBuildParsedInbound_FromFallsBackToEnvelope(t *testing.T) {
	raw := "Subject: No From header\r\n\r\nbody\r\n"
	p := buildParsedInbound([]string{"dest@skyphusion.org"}, "envelope@example.com", envelope(t, raw))
	if p.From != "envelope@example.com" {
		t.Errorf("From = %q, want envelope MAIL FROM fallback", p.From)
	}
}

func TestBuildParsedInbound_AttachmentsBase64(t *testing.T) {
	// A multipart message with one text part and one attachment.
	raw := "From: alice@example.com\r\n" +
		"Subject: with attachment\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/mixed; boundary=BOUND\r\n\r\n" +
		"--BOUND\r\n" +
		"Content-Type: text/plain\r\n\r\n" +
		"see attached\r\n" +
		"--BOUND\r\n" +
		"Content-Type: application/octet-stream\r\n" +
		"Content-Disposition: attachment; filename=\"data.bin\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\n" +
		base64.StdEncoding.EncodeToString([]byte("hello bytes")) + "\r\n" +
		"--BOUND--\r\n"

	p := buildParsedInbound([]string{"dest@skyphusion.org"}, "alice@example.com", envelope(t, raw))

	if len(p.Attachments) != 1 {
		t.Fatalf("got %d attachments, want 1", len(p.Attachments))
	}
	a := p.Attachments[0]
	if a.Filename != "data.bin" {
		t.Errorf("filename = %q, want data.bin", a.Filename)
	}
	// content must be base64 that decodes back to the original bytes (the locked
	// v1 decision: bytes base64-encoded over JSON).
	decoded, err := base64.StdEncoding.DecodeString(a.Content)
	if err != nil {
		t.Fatalf("attachment content is not valid base64: %v", err)
	}
	if string(decoded) != "hello bytes" {
		t.Errorf("decoded attachment = %q, want %q", decoded, "hello bytes")
	}
}
