package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The pin tests in auth_ldap_pin_test.go call the callback directly. These run a REAL
// TLS handshake against a local listener, so they prove what crypto/tls actually does
// with the shipped config: the callback is reached, a matching leaf connects, and a
// swapped leaf is refused on the wire.

// pinWireServer starts a TLS listener presenting a fresh self-signed leaf (bare-*
// SAN, like the Authentik default cert) and returns its address and leaf DER. Each
// accepted connection completes the handshake, writes one byte (so a TLS 1.3 client
// reads the session ticket), and closes.
func pinWireServer(t *testing.T) (string, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "pin wire test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"*"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("createcert: %v", err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				c.SetDeadline(time.Now().Add(5 * time.Second))
				if c.(*tls.Conn).Handshake() == nil {
					c.Write([]byte{'x'})
				}
			}(c)
		}
	}()
	return ln.Addr().String(), der
}

// pinDial dials addr with cfg and reads the server byte. It returns the resumption
// flag and the dial error.
func pinDial(addr string, cfg *tls.Config) (bool, error) {
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", addr, cfg)
	if err != nil {
		return false, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(c, make([]byte, 1)); err != nil {
		return false, err
	}
	return c.ConnectionState().DidResume, nil
}

// A matching pin connects and a mismatched pin is refused, over a real handshake,
// on every one of several dials.
func TestLDAPPinWire_MatchConnectsMismatchRefused(t *testing.T) {
	addr, der := pinWireServer(t)
	match, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://127.0.0.1:389", TLSPinSHA256: fpHex(der)})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig(match): %v", err)
	}
	mismatch, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://127.0.0.1:389", TLSPinSHA256: fpHex(selfSignedDER(t))})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig(mismatch): %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := pinDial(addr, match); err != nil {
			t.Errorf("dial %d with the matching pin: %v", i, err)
		}
		_, err := pinDial(addr, mismatch)
		if err == nil {
			t.Fatalf("dial %d with a mismatched pin CONNECTED; the pin must refuse it", i)
		}
		if !strings.Contains(err.Error(), "does not match LDAP_TLS_PIN_SHA256") {
			t.Errorf("dial %d with a mismatched pin failed for the wrong reason: %v", i, err)
		}
	}
}

// The pin callback runs on a RESUMED session too. The shipped config sets no session
// cache; this adds one to a clone to prove the pin would still be checked if one were
// ever added. This is the property VerifyPeerCertificate lacks.
func TestLDAPPinWire_PinRunsOnResumedSession(t *testing.T) {
	addr, der := pinWireServer(t)
	cfg, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://127.0.0.1:389", TLSPinSHA256: fpHex(der)})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	cfg = cfg.Clone()
	cfg.ClientSessionCache = tls.NewLRUClientSessionCache(4)
	pin := cfg.VerifyConnection
	if pin == nil {
		t.Fatal("pin mode installed no VerifyConnection callback")
	}
	var calls atomic.Int32
	cfg.VerifyConnection = func(cs tls.ConnectionState) error {
		calls.Add(1)
		return pin(cs)
	}
	if _, err := pinDial(addr, cfg); err != nil {
		t.Fatalf("first dial: %v", err)
	}
	resumed, err := pinDial(addr, cfg)
	if err != nil {
		t.Fatalf("second dial: %v", err)
	}
	if !resumed {
		t.Fatal("second dial did not resume, so this test proved nothing about resumption")
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("pin callback ran %d times over 2 dials (one resumed); want 2", got)
	}
}
