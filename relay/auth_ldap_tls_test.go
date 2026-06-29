package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// writeTestCAPEM generates a throwaway self-signed CA cert and writes it as PEM to
// a temp file, returning the path. Used to exercise the LDAP_TLS_CA pin without a
// live directory.
func writeTestCAPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "postern-test-ca"},
		NotBefore:             time.Unix(0, 0),
		NotAfter:              time.Unix(1<<31-1, 0),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("createcert: %v", err)
	}
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write pem: %v", err)
	}
	return path
}

// With no LDAP_TLS_* knob, buildLDAPTLSConfig returns nil so the default
// verification path (system roots, go-ldap's own ServerName handling) is unchanged.
func TestBuildLDAPTLSConfig_NilWhenUnset(t *testing.T) {
	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://10.1.1.2:389"})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	if tc != nil {
		t.Fatalf("expected nil tls.Config when no LDAP_TLS_* knob is set, got %+v", tc)
	}
}

// LDAP_TLS_SERVER_NAME alone pins the verified name (no CA => system roots).
func TestBuildLDAPTLSConfig_ServerNameExplicit(t *testing.T) {
	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://10.1.1.2:389", TLSServerName: "ak-outpost.internal"})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	if tc == nil {
		t.Fatal("expected a non-nil tls.Config when LDAP_TLS_SERVER_NAME is set")
	}
	if tc.ServerName != "ak-outpost.internal" {
		t.Errorf("ServerName = %q, want ak-outpost.internal", tc.ServerName)
	}
	if tc.RootCAs != nil {
		t.Error("RootCAs should be nil (system roots) when only LDAP_TLS_SERVER_NAME is set")
	}
	if tc.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion = %x, want TLS 1.2 (%x)", tc.MinVersion, tls.VersionTLS12)
	}
}

// When a CA is pinned but no ServerName is given, ServerName is derived from the
// LDAP_URL host. This matters because go-ldap's StartTLS does NOT derive it.
func TestBuildLDAPTLSConfig_ServerNameDerivedFromURLHost(t *testing.T) {
	ca := writeTestCAPEM(t)
	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldaps://dischord.internal:636", TLSCAFile: ca})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	if tc == nil || tc.RootCAs == nil {
		t.Fatal("expected a non-nil tls.Config with RootCAs set when LDAP_TLS_CA is given")
	}
	if tc.ServerName != "dischord.internal" {
		t.Errorf("ServerName = %q, want host-derived dischord.internal", tc.ServerName)
	}
}

// An explicit LDAP_TLS_SERVER_NAME overrides the host-derived default even with a CA.
func TestBuildLDAPTLSConfig_ServerNameOverridesHost(t *testing.T) {
	ca := writeTestCAPEM(t)
	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://10.1.1.2:389", TLSCAFile: ca, TLSServerName: "ak-outpost.internal"})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	if tc.ServerName != "ak-outpost.internal" {
		t.Errorf("ServerName = %q, want explicit ak-outpost.internal", tc.ServerName)
	}
}

// A missing or unreadable CA file is a loud startup error, not a silent fallback.
func TestBuildLDAPTLSConfig_MissingCAFileErrors(t *testing.T) {
	_, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://10.1.1.2:389", TLSCAFile: "/nonexistent/ca.pem"})
	if err == nil {
		t.Fatal("expected an error for an unreadable LDAP_TLS_CA path")
	}
}

// A file with no valid PEM certificate is rejected (we never start with an empty
// trust pool, which would reject every directory cert at first login).
func TestBuildLDAPTLSConfig_GarbageCAFileErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "junk.pem")
	if err := os.WriteFile(path, []byte("not a certificate\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://10.1.1.2:389", TLSCAFile: path})
	if err == nil {
		t.Fatal("expected an error for an LDAP_TLS_CA file with no PEM certificate")
	}
}

// newLDAPAuth wires the built TLS config onto the provider (so the dialer and the
// StartTLS upgrade both use the pinned trust). A direct-bind config with a CA pin
// must construct cleanly and carry a non-nil tlsConf.
func TestNewLDAPAuth_CarriesTLSConf(t *testing.T) {
	ca := writeTestCAPEM(t)
	a, err := newLDAPAuth(LDAPCfg{
		URL:            "ldap://10.1.1.2:389",
		StartTLS:       true,
		BindDNTemplate: "cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io",
		MailAttr:       "mail",
		TLSCAFile:      ca,
		TLSServerName:  "ak-outpost.internal",
		Timeout:        10 * time.Second,
	})
	if err != nil {
		t.Fatalf("newLDAPAuth: %v", err)
	}
	if a.tlsConf == nil {
		t.Fatal("expected newLDAPAuth to carry a non-nil tlsConf when an LDAP_TLS_* knob is set")
	}
	if a.tlsConf.ServerName != "ak-outpost.internal" {
		t.Errorf("tlsConf.ServerName = %q, want ak-outpost.internal", a.tlsConf.ServerName)
	}
}

// The pinned TLS config reaches the production dialer (parity with the #88 timeout
// wiring): a CA-pinned provider hands a non-nil *tls.Config to ldapDial.
func TestNewLDAPAuth_TLSConfReachesDialer(t *testing.T) {
	orig := ldapDial
	t.Cleanup(func() { ldapDial = orig })

	var gotTLS *tls.Config
	ldapDial = func(_ string, _ time.Duration, tlsConf *tls.Config) (ldapConn, error) {
		gotTLS = tlsConf
		return &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResult("uid=alice,dc=x", "mail", "alice@example.com"), nil
			},
		}, nil
	}

	a, err := newLDAPAuth(LDAPCfg{
		URL:            "ldaps://dischord.internal:636",
		BindDNTemplate: "uid=%s,dc=x",
		MailAttr:       "mail",
		TLSServerName:  "dischord.internal",
		Timeout:        5 * time.Second,
	})
	if err != nil {
		t.Fatalf("newLDAPAuth: %v", err)
	}
	if _, err := a.Authenticate("alice", "pw"); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if gotTLS == nil {
		t.Fatal("production dialer received a nil *tls.Config; the pinned trust did not reach it")
	}
	if gotTLS.ServerName != "dischord.internal" {
		t.Errorf("dialer tls ServerName = %q, want dischord.internal", gotTLS.ServerName)
	}
}
