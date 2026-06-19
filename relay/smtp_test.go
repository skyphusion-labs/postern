package main

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/jhillyerd/enmime"
)

func TestFirstAddress(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"bare address", "plain@example.com", "plain@example.com"},
		{"named single", "Alice <alice@example.com>", "alice@example.com"},
		{"named list takes first", "Alice <alice@example.com>, Bob <bob@example.com>", "alice@example.com"},
		{"bare list takes first", "alice@example.com, bob@example.com", "alice@example.com"},
		{"angle-bracketed local host", "<root@dischord>", "root@dischord"},
		{"leading and trailing spaces trimmed", "  bob@example.com  ", "bob@example.com"},
		// Unparseable header values fall back to the raw (trimmed) string.
		{"malformed falls back to raw", "not an email", "not an email"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := firstAddress(tt.header); got != tt.want {
				t.Errorf("firstAddress(%q) = %q, want %q", tt.header, got, tt.want)
			}
		})
	}
}

func TestOnDomain(t *testing.T) {
	tests := []struct {
		name   string
		addr   string
		domain string
		want   bool
	}{
		{"exact match", "user@skyphusion.org", "skyphusion.org", true},
		{"case-insensitive domain", "user@SkyPhusion.ORG", "skyphusion.org", true},
		{"case-insensitive both sides", "user@skyphusion.org", "SKYPHUSION.ORG", true},
		{"wrong domain", "user@example.com", "skyphusion.org", false},
		{"subdomain is not a match", "user@mail.skyphusion.org", "skyphusion.org", false},
		{"missing at sign", "userskyphusion.org", "skyphusion.org", false},
		{"empty address", "", "skyphusion.org", false},
		{"uses last at sign", "weird@name@skyphusion.org", "skyphusion.org", true},
		{"empty domain part matches empty target", "user@", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := onDomain(tt.addr, tt.domain); got != tt.want {
				t.Errorf("onDomain(%q, %q) = %v, want %v", tt.addr, tt.domain, got, tt.want)
			}
		})
	}
}

func TestSplitListen(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"single", "127.0.0.1:2525", []string{"127.0.0.1:2525"}},
		{"comma list", "127.0.0.1:2525,172.17.0.1:2525", []string{"127.0.0.1:2525", "172.17.0.1:2525"}},
		{"spaces trimmed", " 127.0.0.1:2525 , 172.17.0.1:2525 ", []string{"127.0.0.1:2525", "172.17.0.1:2525"}},
		{"empty string", "", nil},
		{"only commas and spaces", " , , ", nil},
		{"trailing comma ignored", "127.0.0.1:2525,", []string{"127.0.0.1:2525"}},
		{"empty middle entry skipped", "a:1,,b:2", []string{"a:1", "b:2"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := splitListen(tt.in); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("splitListen(%q) = %#v, want %#v", tt.in, got, tt.want)
			}
		})
	}
}

func TestEnv(t *testing.T) {
	const key = "POSTERN_TEST_ENV_STR"

	t.Run("set returns value", func(t *testing.T) {
		t.Setenv(key, "from-env")
		if got := env(key, "fallback"); got != "from-env" {
			t.Errorf("env() = %q, want %q", got, "from-env")
		}
	})

	t.Run("unset returns default", func(t *testing.T) {
		os.Unsetenv(key)
		if got := env(key, "fallback"); got != "fallback" {
			t.Errorf("env() = %q, want %q", got, "fallback")
		}
	})

	t.Run("empty value returns default", func(t *testing.T) {
		t.Setenv(key, "")
		if got := env(key, "fallback"); got != "fallback" {
			t.Errorf("env() = %q, want %q", got, "fallback")
		}
	})
}

func TestEnvInt(t *testing.T) {
	const key = "POSTERN_TEST_ENV_INT"

	t.Run("set valid int", func(t *testing.T) {
		t.Setenv(key, "42")
		if got := envInt(key, 7); got != 42 {
			t.Errorf("envInt() = %d, want 42", got)
		}
	})

	t.Run("unset returns default", func(t *testing.T) {
		os.Unsetenv(key)
		if got := envInt(key, 7); got != 7 {
			t.Errorf("envInt() = %d, want 7", got)
		}
	})

	t.Run("empty value returns default", func(t *testing.T) {
		t.Setenv(key, "")
		if got := envInt(key, 7); got != 7 {
			t.Errorf("envInt() = %d, want 7", got)
		}
	})

	t.Run("invalid int returns default", func(t *testing.T) {
		t.Setenv(key, "not-a-number")
		if got := envInt(key, 7); got != 7 {
			t.Errorf("envInt() = %d, want 7", got)
		}
	})

	t.Run("negative int parses", func(t *testing.T) {
		t.Setenv(key, "-5")
		if got := envInt(key, 7); got != -5 {
			t.Errorf("envInt() = %d, want -5", got)
		}
	})
}

// envelopeFrom builds a parsed enmime.Envelope from a raw MIME string the same
// way Session.Data does, so buildPayload tests exercise the real parse path.
func envelopeFrom(t *testing.T, raw string) *enmime.Envelope {
	t.Helper()
	env, err := enmime.ReadEnvelope(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("ReadEnvelope: %v", err)
	}
	return env
}

func TestBuildPayload(t *testing.T) {
	const fromDomain = "skyphusion.org"
	const defaultFrom = "noreply@skyphusion.org"

	newSession := func(from string, rcpts []string) *Session {
		return &Session{
			cfg:   Config{FromDomain: fromDomain, DefaultFrom: defaultFrom},
			from:  from,
			rcpts: rcpts,
		}
	}

	t.Run("maps headers and body, on-domain From preserved", func(t *testing.T) {
		raw := "From: Alice <alice@skyphusion.org>\r\n" +
			"Subject: Hello there\r\n" +
			"Content-Type: text/plain\r\n" +
			"\r\n" +
			"plain body\r\n"
		s := newSession("alice@skyphusion.org", []string{"dest@example.com"})
		p := s.buildPayload(envelopeFrom(t, raw))

		if !reflect.DeepEqual(p.To, []string{"dest@example.com"}) {
			t.Errorf("To = %#v, want [dest@example.com]", p.To)
		}
		if p.Subject != "Hello there" {
			t.Errorf("Subject = %q, want %q", p.Subject, "Hello there")
		}
		if strings.TrimSpace(p.Text) != "plain body" {
			t.Errorf("Text = %q, want %q", p.Text, "plain body")
		}
		if p.From != "alice@skyphusion.org" {
			t.Errorf("From = %q, want on-domain sender preserved", p.From)
		}
		if p.ReplyTo != "" {
			t.Errorf("ReplyTo = %q, want empty for on-domain sender", p.ReplyTo)
		}
	})

	t.Run("off-domain From rewritten to DefaultFrom with Reply-To", func(t *testing.T) {
		raw := "From: cron@localhost\r\n" +
			"Subject: Backup report\r\n" +
			"\r\n" +
			"done\r\n"
		s := newSession("cron@localhost", []string{"ops@example.com"})
		p := s.buildPayload(envelopeFrom(t, raw))

		if p.From != defaultFrom {
			t.Errorf("From = %q, want rewrite to %q", p.From, defaultFrom)
		}
		if p.ReplyTo != "cron@localhost" {
			t.Errorf("ReplyTo = %q, want original preserved", p.ReplyTo)
		}
	})

	t.Run("missing From header falls back to envelope MAIL FROM", func(t *testing.T) {
		raw := "Subject: No From header\r\n\r\nbody\r\n"
		s := newSession("sender@skyphusion.org", []string{"dest@example.com"})
		p := s.buildPayload(envelopeFrom(t, raw))

		if p.From != "sender@skyphusion.org" {
			t.Errorf("From = %q, want envelope MAIL FROM used as origin", p.From)
		}
		if p.ReplyTo != "" {
			t.Errorf("ReplyTo = %q, want empty", p.ReplyTo)
		}
	})

	t.Run("no origin at all yields DefaultFrom and no Reply-To", func(t *testing.T) {
		raw := "Subject: Anonymous\r\n\r\nbody\r\n"
		s := newSession("", []string{"dest@example.com"})
		p := s.buildPayload(envelopeFrom(t, raw))

		if p.From != defaultFrom {
			t.Errorf("From = %q, want %q", p.From, defaultFrom)
		}
		if p.ReplyTo != "" {
			t.Errorf("ReplyTo = %q, want empty when there is no origin", p.ReplyTo)
		}
	})

	t.Run("HTML body mapped", func(t *testing.T) {
		raw := "From: alice@skyphusion.org\r\n" +
			"Subject: HTML mail\r\n" +
			"Content-Type: text/html\r\n" +
			"\r\n" +
			"<p>hi</p>\r\n"
		s := newSession("alice@skyphusion.org", []string{"dest@example.com"})
		p := s.buildPayload(envelopeFrom(t, raw))

		if !strings.Contains(p.HTML, "<p>hi</p>") {
			t.Errorf("HTML = %q, want it to contain the HTML body", p.HTML)
		}
	})

	t.Run("To is a copy of rcpts, not an alias", func(t *testing.T) {
		raw := "From: alice@skyphusion.org\r\nSubject: s\r\n\r\nb\r\n"
		rcpts := []string{"a@example.com", "b@example.com"}
		s := newSession("alice@skyphusion.org", rcpts)
		p := s.buildPayload(envelopeFrom(t, raw))

		if !reflect.DeepEqual(p.To, rcpts) {
			t.Errorf("To = %#v, want %#v", p.To, rcpts)
		}
		// Mutating the source slice must not affect the payload (defensive copy).
		rcpts[0] = "mutated@example.com"
		if p.To[0] != "a@example.com" {
			t.Errorf("To[0] = %q, want the payload to hold an independent copy", p.To[0])
		}
	})

	t.Run("recipients up to the cap are all carried", func(t *testing.T) {
		rcpts := make([]string, MaxRecipients)
		for i := range rcpts {
			rcpts[i] = "user@example.com"
		}
		raw := "From: alice@skyphusion.org\r\nSubject: s\r\n\r\nb\r\n"
		s := newSession("alice@skyphusion.org", rcpts)
		p := s.buildPayload(envelopeFrom(t, raw))

		if len(p.To) != MaxRecipients {
			t.Errorf("len(To) = %d, want %d (cap)", len(p.To), MaxRecipients)
		}
	})
}
