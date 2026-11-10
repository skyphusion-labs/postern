package main

import (
	"encoding/json"
	"net/http"
	"net/mail"
	"os"
	"strings"
	"testing"
)

// Caller header NAMES (OutboundMessage.Headers). A name must be an RFC 5322 field-name
// (printable ASCII 33-126, no colon) and must not be a header the relay sets itself or
// an identity / trace header. A colon-bearing name used to be written verbatim and
// produced a second, parseable From line.

func headerMsg(h map[string]string) OutboundMessage {
	return OutboundMessage{
		MessageID: "m1@example.com",
		To:        []string{"victim@example.net"},
		From:      EmailAddress{Email: "agent@example.com"},
		Subject:   "s",
		Text:      "body",
		Headers:   h,
	}
}

func countFromLines(raw string) int {
	n := 0
	for _, line := range strings.Split(raw, "\r\n") {
		if line == "" {
			break // end of the header block
		}
		if strings.HasPrefix(strings.ToLower(line), "from:") {
			n++
		}
	}
	return n
}

func TestRenderMIME_ColonHeaderNameRefused(t *testing.T) {
	raw, err := renderMIME(headerMsg(map[string]string{"From: Boss <boss@example.com> (": ")"}), "agent@example.com")
	if err == nil {
		m, _ := mail.ReadMessage(strings.NewReader(string(raw)))
		var froms []string
		if m != nil {
			froms = m.Header["From"]
		}
		t.Fatalf("renderMIME accepted a colon-bearing header name; From lines=%d parsed=%q", countFromLines(string(raw)), froms)
	}
}

func TestRenderMIME_ReservedHeaderNamesRefused(t *testing.T) {
	names := []string{
		"From", "Sender", "To", "Cc", "Bcc", "Reply-To", "Return-Path", "Date", "MIME-Version",
		"Content-Type", "Content-Transfer-Encoding", "Content-Disposition", "Received", "Subject",
		"sender", "RETURN-PATH", "content-id", "Resent-From",
	}
	for _, n := range names {
		if _, err := renderMIME(headerMsg(map[string]string{n: "boss@example.com"}), "agent@example.com"); err == nil {
			t.Errorf("renderMIME accepted reserved header name %q", n)
		}
	}
}

func TestRenderMIME_MalformedHeaderNamesRefused(t *testing.T) {
	for _, n := range []string{"", "X Bad", "X-Tab\tx", "X-\x01", "X-\x7f", "X-café", " X-Lead", "X-Trail ", "X-A:b"} {
		if _, err := renderMIME(headerMsg(map[string]string{n: "v"}), "agent@example.com"); err == nil {
			t.Errorf("renderMIME accepted malformed header name %q", n)
		}
	}
}

func TestRenderMIME_MessageIDHeaderMustMatch(t *testing.T) {
	// The worker stamps Message-ID = <messageId> in headers; that one is accepted (and
	// rendered once, from MessageID). Any other value is refused.
	raw, err := renderMIME(headerMsg(map[string]string{"Message-ID": "<m1@example.com>", "X-Ok": "1"}), "agent@example.com")
	if err != nil {
		t.Fatalf("core-stamped Message-ID refused: %v", err)
	}
	if c := strings.Count(strings.ToLower(raw2s(raw)), "\r\nmessage-id:"); c != 1 {
		t.Errorf("Message-ID lines = %d, want 1", c)
	}
	if !strings.Contains(raw2s(raw), "\r\nX-Ok: 1\r\n") {
		t.Errorf("X-Ok not rendered")
	}
	if countFromLines(raw2s(raw)) != 1 {
		t.Errorf("From lines != 1")
	}
	for _, v := range []string{"<spoof@example.com>", "m1@example.com"} {
		if _, err := renderMIME(headerMsg(map[string]string{"Message-ID": v}), "agent@example.com"); err == nil {
			t.Errorf("renderMIME accepted Message-ID header %q", v)
		}
	}
	if _, err := renderMIME(headerMsg(map[string]string{"message-id": "<m1@example.com>"}), "agent@example.com"); err == nil {
		t.Errorf("renderMIME accepted a non-canonical message-id key")
	}
}

func raw2s(b []byte) string { return string(b) }

func TestDispatch_BadHeaderNameIs400(t *testing.T) {
	for _, h := range []map[string]string{
		{"From: Boss <boss@x> (": ")"},
		{"Sender": "boss@x"},
	} {
		stub := &stubTransport{}
		srv := newTestServer(stub)
		msg := headerMsg(h)
		body, _ := json.Marshal(msg)
		rr := postDispatch(t, srv, "Bearer "+testToken, string(body))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("headers %v: code = %d, want 400; body=%s", h, rr.Code, rr.Body.String())
		}
		if stub.last.MessageID != "" {
			t.Errorf("headers %v: transport was called", h)
		}
	}
}

// --- Parity with the worker: ONE table, also read by inbound/header-names.test.ts ---

type headerNameTable struct {
	MaxNameLength int `json:"maxNameLength"`
	Cases         []struct {
		Name string `json:"name"`
		OK   bool   `json:"ok"`
	} `json:"cases"`
}

func loadHeaderNameTable(t *testing.T) headerNameTable {
	t.Helper()
	raw, err := os.ReadFile("testdata/header_names.json")
	if err != nil {
		t.Fatalf("read parity table: %v", err)
	}
	var tbl headerNameTable
	if err := json.Unmarshal(raw, &tbl); err != nil {
		t.Fatalf("parse parity table: %v", err)
	}
	if len(tbl.Cases) < 30 {
		t.Fatalf("parity table has %d cases, want >= 30", len(tbl.Cases))
	}
	return tbl
}

func TestHeaderNameParityTable(t *testing.T) {
	tbl := loadHeaderNameTable(t)
	if tbl.MaxNameLength != maxHeaderNameLength {
		t.Errorf("maxNameLength = %d in table, %d in code", tbl.MaxNameLength, maxHeaderNameLength)
	}
	for _, c := range tbl.Cases {
		_, err := renderMIME(headerMsg(map[string]string{c.Name: "v"}), "agent@example.com")
		if (err == nil) != c.OK {
			t.Errorf("renderMIME %q: err=%v, want ok=%v", c.Name, err, c.OK)
		}
		stub := &stubTransport{}
		body, _ := json.Marshal(headerMsg(map[string]string{c.Name: "v"}))
		rr := postDispatch(t, newTestServer(stub), "Bearer "+testToken, string(body))
		want := http.StatusOK
		if !c.OK {
			want = http.StatusBadRequest
		}
		if rr.Code != want {
			t.Errorf("/dispatch %q: code=%d, want %d", c.Name, rr.Code, want)
		}
	}
}
