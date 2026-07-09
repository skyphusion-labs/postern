package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/jhillyerd/enmime"
)

// FuzzReadEnvelopeBuildParsedInbound exercises the relay MIME parse -> ParsedInbound
// projection path (#198). Goal: no panic or hang on arbitrary bytes; parse errors
// are expected and fine.
func FuzzReadEnvelopeBuildParsedInbound(f *testing.F) {
	seed := "From: Alice <alice@example.com>\r\n" +
		"Subject: Hello\r\n" +
		"Content-Type: multipart/mixed; boundary=abc\r\n\r\n" +
		"--abc\r\nContent-Type: text/plain\r\n\r\nbody\r\n--abc--\r\n"
	f.Add([]byte(seed))

	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256*1024 {
			t.Skip("cap fuzz input size")
		}
		env, err := enmime.ReadEnvelope(bytes.NewReader(raw))
		if err != nil {
			return
		}
		_ = buildParsedInbound([]string{"dest@skyphusion.org"}, "mailfrom@example.com", len(raw), env)
		_ = collectMIMEParts(env)
	})
}

// Corpus cases that previously broke naive parsers or are easy regression shapes.
func TestMIMEParseCorpus_NoPanic(t *testing.T) {
	corpus := []string{
		"",
		"From: \r\n\r\n",
		"From: a@example.com\r\nSubject: \x00\xFF nested\r\n\r\n",
		strings.Repeat("X: " + strings.Repeat("v", 200) + "\r\n", 50) + "\r\nbody",
		"Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\na\r\n--x--",
	}
	for _, raw := range corpus {
		env, err := enmime.ReadEnvelope(strings.NewReader(raw))
		if err != nil {
			continue
		}
		_ = buildParsedInbound([]string{"dest@skyphusion.org"}, "mailfrom@example.com", len(raw), env)
		_ = collectMIMEParts(env)
	}
}
