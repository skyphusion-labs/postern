package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"
	"time"
)

// selfSignedDER generates a throwaway self-signed leaf and returns its DER bytes.
// A bare-wildcard SAN mirrors the live Authentik default cert, but the fingerprint
// pin is SAN-independent so the SAN is irrelevant to these tests.
func selfSignedDER(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "authentik default certificate"},
		NotBefore:    time.Unix(0, 0),
		NotAfter:     time.Unix(1<<31-1, 0),
		DNSNames:     []string{"*"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("createcert: %v", err)
	}
	return der
}

func fpHex(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// A fingerprint pin builds a config that skips the built-in chain/hostname checks
// (so our callback is the sole gate) and carries a VerifyPeerCertificate callback;
// it sets no RootCAs (SAN/CA-independent).
func TestBuildLDAPTLSConfig_PinShape(t *testing.T) {
	der := selfSignedDER(t)
	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://192.0.2.10:389", TLSPinSHA256: fpHex(der)})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	if tc == nil {
		t.Fatal("expected a non-nil tls.Config when LDAP_TLS_PIN_SHA256 is set")
	}
	if !tc.InsecureSkipVerify {
		t.Error("pin mode must set InsecureSkipVerify so the callback is the sole gate")
	}
	if tc.VerifyPeerCertificate == nil {
		t.Error("pin mode must install a VerifyPeerCertificate callback")
	}
	if tc.RootCAs != nil {
		t.Error("pin mode must not set RootCAs (it is SAN/CA-independent)")
	}
}

// The callback accepts the pinned leaf and rejects any other (MITM swap), regardless
// of the unusable bare-* SAN.
func TestBuildLDAPTLSConfig_PinMatchAndMITM(t *testing.T) {
	der := selfSignedDER(t)
	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://192.0.2.10:389", TLSPinSHA256: fpHex(der)})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig: %v", err)
	}
	if err := tc.VerifyPeerCertificate([][]byte{der}, nil); err != nil {
		t.Errorf("matching leaf should verify, got %v", err)
	}
	other := selfSignedDER(t) // a different cert = a MITM swap
	if err := tc.VerifyPeerCertificate([][]byte{other}, nil); err == nil {
		t.Error("a swapped leaf must be REJECTED (MITM-resistant)")
	}
	if err := tc.VerifyPeerCertificate(nil, nil); err == nil {
		t.Error("an empty peer chain must be rejected")
	}
}

// The pin accepts the common fingerprint spellings: colon-separated, uppercase, and
// surrounding whitespace (so `openssl x509 -fingerprint -sha256` output pastes in).
func TestBuildLDAPTLSConfig_PinAcceptsColonsAndCase(t *testing.T) {
	der := selfSignedDER(t)
	bare := fpHex(der)
	// rebuild a colon-separated, uppercase, whitespace-padded spelling
	var groups []string
	for i := 0; i < len(bare); i += 2 {
		groups = append(groups, bare[i:i+2])
	}
	colonUpper := "  " + strings.ToUpper(strings.Join(groups, ":")) + "\n"

	tc, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://192.0.2.10:389", TLSPinSHA256: colonUpper})
	if err != nil {
		t.Fatalf("buildLDAPTLSConfig with colon/upper/space pin: %v", err)
	}
	if err := tc.VerifyPeerCertificate([][]byte{der}, nil); err != nil {
		t.Errorf("normalized pin should match the leaf, got %v", err)
	}
}

// A malformed pin (bad hex or wrong length) is a loud startup error, never a silent
// fallback to an open trust.
func TestBuildLDAPTLSConfig_PinMalformed(t *testing.T) {
	for _, bad := range []string{
		"nothex-nothex",
		"abcd",                   // too short
		"00",                     // 1 byte
		strings.Repeat("ab", 33), // 33 bytes, too long
	} {
		if _, err := buildLDAPTLSConfig(LDAPCfg{URL: "ldap://192.0.2.10:389", TLSPinSHA256: bad}); err == nil {
			t.Errorf("expected an error for malformed pin %q", bad)
		}
	}
}

// LDAP_TLS_CA and LDAP_TLS_PIN_SHA256 are two trust models; setting both is a loud
// error rather than a silent pick.
func TestBuildLDAPTLSConfig_PinAndCAMutuallyExclusive(t *testing.T) {
	der := selfSignedDER(t)
	_, err := buildLDAPTLSConfig(LDAPCfg{
		URL:          "ldap://192.0.2.10:389",
		TLSCAFile:    "/some/ca.pem",
		TLSPinSHA256: fpHex(der),
	})
	if err == nil {
		t.Fatal("expected an error when both LDAP_TLS_CA and LDAP_TLS_PIN_SHA256 are set")
	}
}

// newLDAPAuth constructs cleanly with a pin and carries the pinned config onto the
// provider (so both the dialer and the StartTLS upgrade use it).
func TestNewLDAPAuth_CarriesPinnedTLSConf(t *testing.T) {
	der := selfSignedDER(t)
	a, err := newLDAPAuth(LDAPCfg{
		URL:            "ldap://192.0.2.10:389",
		StartTLS:       true,
		BindDNTemplate: "cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io",
		MailAttr:       "mail",
		TLSPinSHA256:   fpHex(der),
		Timeout:        10 * time.Second,
	})
	if err != nil {
		t.Fatalf("newLDAPAuth: %v", err)
	}
	if a.tlsConf == nil || !a.tlsConf.InsecureSkipVerify || a.tlsConf.VerifyPeerCertificate == nil {
		t.Fatal("expected newLDAPAuth to carry the pinned tls.Config (InsecureSkipVerify + callback)")
	}
}

// Direct unit coverage of the normalizer.
func TestNormalizePinSHA256(t *testing.T) {
	der := selfSignedDER(t)
	bare := fpHex(der)
	b, err := normalizePinSHA256(bare)
	if err != nil {
		t.Fatalf("normalizePinSHA256(bare): %v", err)
	}
	if len(b) != sha256.Size {
		t.Fatalf("decoded len = %d, want %d", len(b), sha256.Size)
	}
	if hex.EncodeToString(b) != bare {
		t.Errorf("round-trip mismatch: %s != %s", hex.EncodeToString(b), bare)
	}
	if _, err := normalizePinSHA256(""); err == nil {
		t.Error("empty pin should error")
	}
}
