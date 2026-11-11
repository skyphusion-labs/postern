package main

import (
	"net/http"
	"net/mail"
	"strings"
	"testing"
)

// #740 S4 (send_as): core sends From = the granted human, Sender = the agent identity,
// Reply-To = the human. These tests pin that the relay accepts the sender field, writes
// a Sender header, refuses a malformed one, and that the header reaches the SMTP wire end
// to end: the real /dispatch handler, the real SMTPTransport, an in-process SMTP sink.

func TestRenderMIME_WritesSender(t *testing.T) {
	msg := OutboundMessage{
		MessageID: "sa@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "conrad@skyphusion.org", Name: "Human Owner"},
		Sender:    &EmailAddress{Email: "agent@skyphusion.org", Name: "Triage Agent"},
		ReplyTo:   &EmailAddress{Email: "conrad@skyphusion.org", Name: "Human Owner"},
		Subject:   "on behalf",
		Text:      "body",
	}
	raw := mustRender(t, msg)
	assertContains(t, raw, "From: \"Human Owner\" <conrad@skyphusion.org>")
	assertContains(t, raw, "Sender: \"Triage Agent\" <agent@skyphusion.org>")
}

func TestRenderMIME_NoSenderWhenAbsent(t *testing.T) {
	raw := mustRender(t, OutboundMessage{
		MessageID: "plain@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "agent@skyphusion.org"},
		Subject:   "plain",
		Text:      "body",
	})
	if strings.Contains(raw, "\r\nSender:") || strings.HasPrefix(raw, "Sender:") {
		t.Fatalf("a message with no sender must carry no Sender header:\n%s", raw)
	}
}

func TestRenderMIME_RejectsMalformedSender(t *testing.T) {
	_, err := renderMIME(OutboundMessage{
		MessageID: "bad@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "conrad@skyphusion.org"},
		Sender:    &EmailAddress{Email: "agent@skyphusion.org\r\nBcc: evil@example.com"},
		Subject:   "s",
		Text:      "t",
	}, "conrad@skyphusion.org")
	if err == nil || !strings.Contains(err.Error(), "Sender") {
		t.Fatalf("a malformed Sender must be refused, got err=%v", err)
	}
}

func TestDispatch_SenderEndToEnd(t *testing.T) {
	be, tr := startSink(t)
	h := newTestServer(tr)
	body := `{"messageId":"e2e-sa@skyphusion.org","to":["dest@example.com"],` +
		`"from":{"email":"conrad@skyphusion.org","name":"Human Owner"},` +
		`"sender":{"email":"agent@skyphusion.org","name":"Triage Agent"},` +
		`"replyTo":{"email":"conrad@skyphusion.org","name":"Human Owner"},` +
		`"subject":"on behalf","text":"body"}`
	rr := postDispatch(t, h, "Bearer "+testToken, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	waitData(t, be)

	be.mu.Lock()
	data := be.data
	be.mu.Unlock()
	parsed, err := mail.ReadMessage(strings.NewReader(data))
	if err != nil {
		t.Fatalf("the sink received an unparseable message: %v\n%s", err, data)
	}
	for _, c := range []struct{ header, name, addr string }{
		{"From", "Human Owner", "conrad@skyphusion.org"},
		{"Sender", "Triage Agent", "agent@skyphusion.org"},
		{"Reply-To", "Human Owner", "conrad@skyphusion.org"},
	} {
		a, err := mail.ParseAddress(parsed.Header.Get(c.header))
		if err != nil {
			t.Fatalf("%s on the wire did not parse: %v (raw %q)", c.header, err, parsed.Header.Get(c.header))
		}
		if a.Name != c.name || a.Address != c.addr {
			t.Errorf("%s on the wire = %q <%s>, want %q <%s>", c.header, a.Name, a.Address, c.name, c.addr)
		}
	}
}

func TestDispatch_NoSenderEndToEnd(t *testing.T) {
	// CONTROL: the same path without the sender field puts no Sender on the wire, so the
	// header above is the field, not something the relay adds on its own.
	be, tr := startSink(t)
	h := newTestServer(tr)
	body := `{"messageId":"e2e-plain@skyphusion.org","to":["dest@example.com"],` +
		`"from":{"email":"agent@skyphusion.org"},"subject":"plain","text":"body"}`
	if rr := postDispatch(t, h, "Bearer "+testToken, body); rr.Code != http.StatusOK {
		t.Fatalf("code = %d; body=%s", rr.Code, rr.Body.String())
	}
	waitData(t, be)
	be.mu.Lock()
	data := be.data
	be.mu.Unlock()
	parsed, err := mail.ReadMessage(strings.NewReader(data))
	if err != nil {
		t.Fatalf("unparseable: %v", err)
	}
	if got := parsed.Header.Get("Sender"); got != "" {
		t.Fatalf("no sender field, yet Sender on the wire: %q", got)
	}
}
