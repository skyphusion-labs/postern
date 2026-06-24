package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/emersion/go-smtp"
)

// stubSubmitter records calls and returns canned results, mirroring the
// stubTransport pattern in http_test.go.
type stubSubmitter struct {
	authFrom string
	authErr  error
	sendErr  error
	lastSend SendPayload
	sendCnt  int
}

func (s *stubSubmitter) Authenticate(_, _ string) (string, error) {
	return s.authFrom, s.authErr
}

func (s *stubSubmitter) Send(p SendPayload) error {
	s.sendCnt++
	s.lastSend = p
	if s.sendErr != nil {
		return s.sendErr
	}
	return nil
}

func newAuthedSession(boundFrom string, rcpts []string, sub submitter) *submissionSession {
	return &submissionSession{
		cfg:       Config{MaxSize: 1 << 20},
		client:    sub,
		authed:    true,
		boundFrom: boundFrom,
		rcpts:     rcpts,
	}
}

// smtpCode extracts the numeric SMTP code from an error, or 0 if it is not an
// *smtp.SMTPError (nil included).
func smtpCode(err error) int {
	if se, ok := err.(*smtp.SMTPError); ok {
		return se.Code
	}
	return 0
}

func TestSubmission_AuthGating(t *testing.T) {
	// An unauthenticated session must reject MAIL, RCPT, and DATA.
	s := &submissionSession{cfg: Config{MaxSize: 1 << 20}, client: &stubSubmitter{}}
	if err := s.Mail("a@skyphusion.org", nil); err == nil {
		t.Error("Mail without auth: want error, got nil")
	}
	if err := s.Rcpt("d@example.com", nil); err == nil {
		t.Error("Rcpt without auth: want error, got nil")
	}
	if err := s.Data(strings.NewReader("From: a@skyphusion.org\r\n\r\nhi\r\n")); err == nil {
		t.Error("Data without auth: want error, got nil")
	}
}

func TestSubmission_Authenticate(t *testing.T) {
	t.Run("good credential binds the identity", func(t *testing.T) {
		sub := &stubSubmitter{authFrom: "alice@skyphusion.org"}
		s := &submissionSession{client: sub}
		if err := s.authenticate("alice@skyphusion.org", "pw"); err != nil {
			t.Fatalf("authenticate: %v", err)
		}
		if !s.authed || s.boundFrom != "alice@skyphusion.org" {
			t.Errorf("authed=%v boundFrom=%q, want true + bound identity", s.authed, s.boundFrom)
		}
	})

	t.Run("bad credential fails closed", func(t *testing.T) {
		sub := &stubSubmitter{authErr: errAuthFailed}
		s := &submissionSession{client: sub}
		if err := s.authenticate("x@skyphusion.org", "bad"); err != smtp.ErrAuthFailed {
			t.Errorf("err = %v, want smtp.ErrAuthFailed", err)
		}
		if s.authed {
			t.Error("authed = true after a failed credential")
		}
	})

	t.Run("infra error is collapsed to auth failed", func(t *testing.T) {
		sub := &stubSubmitter{authErr: &sendError{status: 500, msg: "boom"}}
		s := &submissionSession{client: sub}
		if err := s.authenticate("x@skyphusion.org", "pw"); err != smtp.ErrAuthFailed {
			t.Errorf("err = %v, want smtp.ErrAuthFailed (infra detail not leaked)", err)
		}
	})
}

func TestSubmission_FromEnforcement(t *testing.T) {
	tests := []struct {
		name     string
		bound    string
		raw      string
		wantCode int // 0 means accepted (nil error)
	}{
		{
			name:     "matching From accepted",
			bound:    "alice@skyphusion.org",
			raw:      "From: Alice <alice@skyphusion.org>\r\nTo: d@example.com\r\nSubject: hi\r\n\r\nbody\r\n",
			wantCode: 0,
		},
		{
			name:     "case-insensitive match accepted",
			bound:    "alice@skyphusion.org",
			raw:      "From: ALICE@Skyphusion.ORG\r\nTo: d@example.com\r\nSubject: hi\r\n\r\nbody\r\n",
			wantCode: 0,
		},
		{
			name:     "mismatched From rejected 550",
			bound:    "alice@skyphusion.org",
			raw:      "From: mallory@skyphusion.org\r\nTo: d@example.com\r\nSubject: spoof\r\n\r\nbody\r\n",
			wantCode: 550,
		},
		{
			name:     "missing From rejected 550",
			bound:    "alice@skyphusion.org",
			raw:      "To: d@example.com\r\nSubject: no from\r\n\r\nbody\r\n",
			wantCode: 550,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sub := &stubSubmitter{authFrom: tt.bound}
			s := newAuthedSession(tt.bound, []string{"d@example.com"}, sub)
			err := s.Data(strings.NewReader(tt.raw))
			if got := smtpCode(err); got != tt.wantCode {
				t.Errorf("Data code = %d (err=%v), want %d", got, err, tt.wantCode)
			}
			if tt.wantCode == 0 && sub.sendCnt != 1 {
				t.Errorf("accepted message: Send called %d times, want 1", sub.sendCnt)
			}
			if tt.wantCode != 0 && sub.sendCnt != 0 {
				t.Errorf("rejected message: Send called %d times, want 0", sub.sendCnt)
			}
		})
	}
}

func TestSubmission_RejectsAttachments(t *testing.T) {
	raw := "From: alice@skyphusion.org\r\n" +
		"To: d@example.com\r\n" +
		"Subject: with file\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/mixed; boundary=BOUNDARY\r\n" +
		"\r\n" +
		"--BOUNDARY\r\n" +
		"Content-Type: text/plain\r\n\r\nsee attached\r\n" +
		"--BOUNDARY\r\n" +
		"Content-Type: application/octet-stream\r\n" +
		"Content-Disposition: attachment; filename=\"x.bin\"\r\n\r\n" +
		"AAAA\r\n" +
		"--BOUNDARY--\r\n"
	sub := &stubSubmitter{authFrom: "alice@skyphusion.org"}
	s := newAuthedSession("alice@skyphusion.org", []string{"d@example.com"}, sub)
	err := s.Data(strings.NewReader(raw))
	if smtpCode(err) != 554 {
		t.Errorf("attachment Data code = %d (err=%v), want 554", smtpCode(err), err)
	}
	if sub.sendCnt != 0 {
		t.Errorf("Send called %d times for a message with attachments, want 0 (no silent drop)", sub.sendCnt)
	}
}

func TestSubmission_HappyPathBridge(t *testing.T) {
	raw := "From: alice@skyphusion.org\r\n" +
		"To: Bob <bob@example.com>\r\n" +
		"Cc: carol@example.com\r\n" +
		"Subject: hello\r\n" +
		"In-Reply-To: <prev@example.com>\r\n" +
		"\r\n" +
		"the body\r\n"
	sub := &stubSubmitter{authFrom: "alice@skyphusion.org"}
	// Envelope carries an extra recipient (dave) not in any header => Bcc.
	s := newAuthedSession("alice@skyphusion.org", []string{"bob@example.com", "carol@example.com", "dave@example.com"}, sub)

	if err := s.Data(strings.NewReader(raw)); err != nil {
		t.Fatalf("Data: %v", err)
	}
	p := sub.lastSend
	if p.From != "alice@skyphusion.org" {
		t.Errorf("From = %q", p.From)
	}
	if !reflect.DeepEqual(p.To, []string{"bob@example.com"}) {
		t.Errorf("To = %#v, want [bob@example.com]", p.To)
	}
	if !reflect.DeepEqual(p.CC, []string{"carol@example.com"}) {
		t.Errorf("CC = %#v, want [carol@example.com]", p.CC)
	}
	if !reflect.DeepEqual(p.BCC, []string{"dave@example.com"}) {
		t.Errorf("BCC = %#v, want [dave@example.com] (envelope-only recipient)", p.BCC)
	}
	if p.Subject != "hello" {
		t.Errorf("Subject = %q", p.Subject)
	}
	if strings.TrimSpace(p.Text) != "the body" {
		t.Errorf("Text = %q", p.Text)
	}
	if p.Headers["In-Reply-To"] != "<prev@example.com>" {
		t.Errorf("In-Reply-To not carried: %#v", p.Headers)
	}
}

func TestSubmission_BccOnlyRejected(t *testing.T) {
	// No To/Cc header recipient present in the envelope -> Bcc-only -> rejected
	// (the worker requires a To; we do not silently rewrite the visible header).
	raw := "From: alice@skyphusion.org\r\nSubject: bcc only\r\n\r\nbody\r\n"
	sub := &stubSubmitter{authFrom: "alice@skyphusion.org"}
	s := newAuthedSession("alice@skyphusion.org", []string{"secret@example.com"}, sub)
	err := s.Data(strings.NewReader(raw))
	if smtpCode(err) != 550 {
		t.Errorf("bcc-only code = %d (err=%v), want 550", smtpCode(err), err)
	}
	if sub.sendCnt != 0 {
		t.Errorf("Send called %d times, want 0", sub.sendCnt)
	}
}

func TestSubmission_SendErrorMapping(t *testing.T) {
	tests := []struct {
		name     string
		sendErr  error
		wantCode int
	}{
		{"validation 400 -> 550", &sendError{status: 400, msg: "bad"}, 550},
		{"sender not allowed 403 -> 550", &sendError{status: 403, msg: "nope"}, 550},
		{"send token wrong 401 -> 451", &sendError{status: 401, msg: "unauth"}, 451},
		{"too large 413 -> 552", &sendError{status: 413, msg: "big"}, 552},
		{"upstream 502 -> 451", &sendError{status: 502, msg: "down"}, 451},
		{"network error -> 451", errAuthFailed, 451}, // any non-sendError
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sub := &stubSubmitter{authFrom: "alice@skyphusion.org", sendErr: tt.sendErr}
			s := newAuthedSession("alice@skyphusion.org", []string{"d@example.com"}, sub)
			raw := "From: alice@skyphusion.org\r\nTo: d@example.com\r\nSubject: s\r\n\r\nb\r\n"
			err := s.Data(strings.NewReader(raw))
			if got := smtpCode(err); got != tt.wantCode {
				t.Errorf("code = %d (err=%v), want %d", got, err, tt.wantCode)
			}
		})
	}
}

func TestParseAddressList(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   []string
	}{
		{"empty", "", nil},
		{"single bare", "a@example.com", []string{"a@example.com"}},
		{"named", "Bob <bob@example.com>", []string{"bob@example.com"}},
		{"list", "a@example.com, B <b@example.com>", []string{"a@example.com", "b@example.com"}},
		{"malformed yields none", "not an address", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseAddressList(tt.header); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseAddressList(%q) = %#v, want %#v", tt.header, got, tt.want)
			}
		})
	}
}

func TestBuildSendPayload_RecipientReconstruction(t *testing.T) {
	t.Run("header address not in envelope is dropped from delivery", func(t *testing.T) {
		// To header names bob + ghost, but only bob is in the envelope. ghost must
		// not be delivered (it was never RCPT'd).
		raw := "From: alice@skyphusion.org\r\nTo: bob@example.com, ghost@example.com\r\nSubject: s\r\n\r\nb\r\n"
		sub := &stubSubmitter{authFrom: "alice@skyphusion.org"}
		s := newAuthedSession("alice@skyphusion.org", []string{"bob@example.com"}, sub)
		if err := s.Data(strings.NewReader(raw)); err != nil {
			t.Fatalf("Data: %v", err)
		}
		if !reflect.DeepEqual(sub.lastSend.To, []string{"bob@example.com"}) {
			t.Errorf("To = %#v, want only the envelope recipient [bob@example.com]", sub.lastSend.To)
		}
		if len(sub.lastSend.BCC) != 0 {
			t.Errorf("BCC = %#v, want empty", sub.lastSend.BCC)
		}
	})
}
