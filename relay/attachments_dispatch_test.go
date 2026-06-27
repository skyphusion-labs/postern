package main

import (
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/mail"
	"reflect"
	"strings"
	"testing"
)

// #92: the relay /dispatch outbound transport must carry attachments. These tests
// pin the MIME construction (multipart/mixed wrapping the body + attachment parts),
// the end-to-end delivery through the SMTP sink, the decoder accepting the
// attachments field, and the oversize cap.

const onePxPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

func TestRenderMIME_WithAttachment(t *testing.T) {
	msg := OutboundMessage{
		MessageID: "att@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "with file",
		Text:      "see attached",
		Attachments: []OutboundAttachment{
			{Filename: "hello.png", MimeType: "image/png", Content: onePxPNG},
		},
	}
	raw := mustRender(t, msg)

	assertContains(t, raw, "Content-Type: multipart/mixed;")
	assertContains(t, raw, "see attached")
	assertContains(t, raw, "Content-Type: image/png; name=\"hello.png\"")
	assertContains(t, raw, "Content-Disposition: attachment; filename=\"hello.png\"")
	assertContains(t, raw, "Content-Transfer-Encoding: base64")

	// The attachment round-trips: parse the MIME and decode the part bytes.
	parts := parseAttachments(t, raw)
	if len(parts) != 1 {
		t.Fatalf("found %d attachment parts, want 1", len(parts))
	}
	wantBytes, _ := base64.StdEncoding.DecodeString(onePxPNG)
	if !reflect.DeepEqual(parts[0].body, wantBytes) {
		t.Errorf("attachment bytes did not round-trip (got %d bytes, want %d)", len(parts[0].body), len(wantBytes))
	}
	if parts[0].filename != "hello.png" {
		t.Errorf("attachment filename = %q, want hello.png", parts[0].filename)
	}
}

func TestRenderMIME_AttachmentWithHTMLBody(t *testing.T) {
	// A both-text+html body becomes a nested multipart/alternative inside the
	// multipart/mixed, with the attachment alongside.
	msg := OutboundMessage{
		MessageID: "att2@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "rich + file",
		Text:      "plain part",
		HTML:      "<p>rich part</p>",
		Attachments: []OutboundAttachment{
			{Filename: "doc.txt", MimeType: "text/plain", Content: base64.StdEncoding.EncodeToString([]byte("file body"))},
		},
	}
	raw := mustRender(t, msg)
	assertContains(t, raw, "Content-Type: multipart/mixed;")
	assertContains(t, raw, "Content-Type: multipart/alternative;")
	assertContains(t, raw, "text/html; charset=utf-8")

	parts := parseAttachments(t, raw)
	if len(parts) != 1 || string(parts[0].body) != "file body" {
		t.Fatalf("attachment did not round-trip alongside an alternative body: %#v", parts)
	}
}

func TestRenderMIME_AttachmentSanitization(t *testing.T) {
	// A filename with quotes / CRLF / path separators is reduced to a safe token,
	// and a bogus media type falls back to application/octet-stream -- neither can
	// inject a header or break the name="..." quoting.
	msg := OutboundMessage{
		MessageID: "san@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "s",
		Text:      "t",
		Attachments: []OutboundAttachment{
			{Filename: "../e\"vil\r\nX-Inject: 1.bin", MimeType: "not a type\r\nX-Bad: 1", Content: base64.StdEncoding.EncodeToString([]byte("x"))},
		},
	}
	raw := mustRender(t, msg)
	for _, line := range strings.Split(raw, "\r\n") {
		if strings.HasPrefix(line, "X-Inject:") || strings.HasPrefix(line, "X-Bad:") {
			t.Errorf("attachment metadata injected a header line: %q", line)
		}
	}
	assertContains(t, raw, "application/octet-stream")
	if strings.Contains(raw, `"evil`) || strings.Contains(raw, "../") {
		t.Errorf("filename not sanitized:\n%s", raw)
	}
}

func TestRenderMIME_RejectsBadBase64(t *testing.T) {
	msg := OutboundMessage{
		MessageID: "bad@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "s",
		Text:      "t",
		Attachments: []OutboundAttachment{
			{Filename: "x.bin", Content: "!!!! not base64 !!!!"},
		},
	}
	if raw, err := renderMIME(msg, msg.From.Email); err == nil {
		t.Fatalf("renderMIME accepted invalid base64; output:\n%s", raw)
	}
}

func TestSMTPTransport_Dispatch_WithAttachment_EndToEnd(t *testing.T) {
	be, tr := startSink(t)
	msg := OutboundMessage{
		MessageID: "e2e-att@skyphusion.org",
		To:        []string{"dest@example.com"},
		From:      EmailAddress{Email: "noreply@skyphusion.org"},
		Subject:   "delivery with file",
		Text:      "body text",
		Attachments: []OutboundAttachment{
			{Filename: "report.pdf", MimeType: "application/pdf", Content: base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))},
		},
	}
	if _, err := tr.Dispatch(msg); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	waitData(t, be)

	be.mu.Lock()
	defer be.mu.Unlock()
	parts := parseAttachments(t, be.data)
	if len(parts) != 1 {
		t.Fatalf("sink received %d attachment parts, want 1\n%s", len(parts), be.data)
	}
	if parts[0].filename != "report.pdf" || string(parts[0].body) != "%PDF-1.4 fake" {
		t.Errorf("delivered attachment = %q / %q", parts[0].filename, string(parts[0].body))
	}
}

func TestDispatch_CarriesAttachments(t *testing.T) {
	// The /dispatch decoder must ACCEPT the attachments field (previously rejected
	// loud by DisallowUnknownFields) and hand them to the transport intact.
	stub := &stubTransport{}
	h := newTestServer(stub)
	body := `{"messageId":"m@x","to":["d@x"],"from":{"email":"n@skyphusion.org"},"subject":"s","text":"t","attachments":[{"filename":"a.txt","mimeType":"text/plain","content":"aGk="}]}`

	rr := postDispatch(t, h, "Bearer "+testToken, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	if len(stub.last.Attachments) != 1 {
		t.Fatalf("transport got %d attachments, want 1", len(stub.last.Attachments))
	}
	got := stub.last.Attachments[0]
	if got.Filename != "a.txt" || got.MimeType != "text/plain" || got.Content != "aGk=" {
		t.Errorf("attachment not carried verbatim: %#v", got)
	}
}

func TestDispatch_OversizeIs413(t *testing.T) {
	// The dispatch body cap still bounds total size with attachments present: a
	// request larger than maxBytes is rejected before decode.
	h := newTestServer(&stubTransport{})
	big := strings.Repeat("A", (1<<20)+1024) // > the 1 MiB test cap
	body := `{"messageId":"m@x","to":["d@x"],"from":{"email":"n@x"},"subject":"s","text":"t","attachments":[{"filename":"big.bin","content":"` + big + `"}]}`
	rr := postDispatch(t, h, "Bearer "+testToken, body)
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize: code = %d, want 413", rr.Code)
	}
}

// --- helpers ---

type parsedAttachment struct {
	filename string
	body     []byte
}

// parseAttachments parses a rendered message and returns its attachment parts
// (Content-Disposition: attachment), base64-decoded. It walks one level of
// multipart/mixed; the body part (text / html / alternative) is skipped.
func parseAttachments(t *testing.T, raw string) []parsedAttachment {
	t.Helper()
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("parse message: %v", err)
	}
	mediaType, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("parse top Content-Type: %v", err)
	}
	if !strings.HasPrefix(mediaType, "multipart/mixed") {
		t.Fatalf("top media type = %q, want multipart/mixed", mediaType)
	}
	mr := multipart.NewReader(m.Body, params["boundary"])
	var out []parsedAttachment
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("next part: %v", err)
		}
		disp, dParams, _ := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
		if disp != "attachment" {
			continue
		}
		// multipart.Part does NOT transparently decode base64; do it here.
		rawPart, _ := io.ReadAll(p)
		decoded, err := base64.StdEncoding.DecodeString(stripWS(string(rawPart)))
		if err != nil {
			t.Fatalf("attachment base64 decode: %v", err)
		}
		out = append(out, parsedAttachment{filename: dParams["filename"], body: decoded})
	}
	return out
}

func stripWS(s string) string {
	return strings.NewReplacer("\r", "", "\n", "", " ", "", "\t", "").Replace(s)
}
