package main

import (
	"crypto/tls"
	"testing"
)

// The BYO-SMTP StartTLS hop carries AUTH PLAIN credentials upstream; its TLS
// floor is stated explicitly rather than inherited from whatever the stdlib
// default happens to be (#186), matching the rest of the codebase.
func TestOutboundTLSConfig(t *testing.T) {
	tc := outboundTLSConfig("smtp.example.com")
	if tc.ServerName != "smtp.example.com" {
		t.Errorf("ServerName = %q, want smtp.example.com", tc.ServerName)
	}
	if tc.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion = %x, want TLS 1.2 (%x)", tc.MinVersion, tls.VersionTLS12)
	}
	if tc.InsecureSkipVerify {
		t.Error("outbound StartTLS must verify the upstream certificate")
	}
}
