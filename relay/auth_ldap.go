package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// ldapAuth is the LDAP auth backend (#68): it verifies a login by binding to the
// directory over TLS DIRECTLY as the authenticating user (no privileged service
// account), then SELF-READS that user's own entry (base scope, their own DN) for
// the mail identity and, when LDAP_REQUIRE_GROUP is set, the memberOf authz gate.
// Auth success is bind success; the self-read resolves From == mail and enforces
// the group gate. This is the "direct-bind + self-read" model of record (Option A):
// the directory (Authentik 2024.12.3) has no privileged search account to do a
// service-account search+bind, so the user reads its OWN entry instead, which a
// non-superuser bind is permitted to do. TLS is mandatory; a bind carries the
// password in the clear. See docs/AUTH-CONTRACT.md section 5b.
type ldapAuth struct {
	cfg     LDAPCfg
	tlsConf *tls.Config // nil unless an LDAP_TLS_* knob is set; carries the pinned trust (CA-pin or fingerprint-pin) for the directory connection
	dial    func(url string) (ldapConn, error)
}

// ldapConn is the slice of *ldap.Conn the backend uses, behind an interface so
// tests can substitute a fake directory without a live LDAP server.
type ldapConn interface {
	StartTLS(*tls.Config) error
	Bind(username, password string) error
	Search(*ldap.SearchRequest) (*ldap.SearchResult, error)
	Close() error
}

// ldapDial is the production dialer (overridable in tests). timeout (LDAP_TIMEOUT)
// bounds BOTH the TCP connect (net.Dialer) AND every later operation on the conn
// (SetTimeout: bind/search read deadline), so a dead or slow directory can neither
// hang the connect nor hang a bind/search mid-login. A non-positive timeout leaves
// go-ldap's defaults in place (no timeout); the config default is 10s.
var ldapDial = func(url string, timeout time.Duration, tlsConf *tls.Config) (ldapConn, error) {
	var opts []ldap.DialOpt
	if timeout > 0 {
		opts = append(opts, ldap.DialWithDialer(&net.Dialer{Timeout: timeout}))
	}
	if tlsConf != nil {
		// Applies to an ldaps:// dial (implicit TLS). Harmless for ldap://, where TLS
		// is negotiated later via StartTLS (which uses the same tlsConf, below).
		opts = append(opts, ldap.DialWithTLSConfig(tlsConf))
	}
	c, err := ldap.DialURL(url, opts...)
	if err != nil {
		return nil, err
	}
	if timeout > 0 {
		// Read deadline for the binds + search that follow (set before any bind).
		c.SetTimeout(timeout)
	}
	return c, nil
}

func newLDAPAuth(cfg LDAPCfg) (*ldapAuth, error) {
	if cfg.URL == "" {
		return nil, fmt.Errorf("LDAP_URL is required for the ldap auth backend")
	}
	secure := strings.HasPrefix(strings.ToLower(cfg.URL), "ldaps://") || cfg.StartTLS
	if !secure {
		return nil, fmt.Errorf("ldap auth requires TLS: use an ldaps:// LDAP_URL or set LDAP_STARTTLS=true")
	}
	if cfg.BindDNTemplate == "" {
		return nil, fmt.Errorf("ldap auth needs LDAP_BIND_DN_TEMPLATE for direct-bind (e.g. cn=%%s,ou=users,dc=ldap,dc=goauthentik,dc=io)")
	}
	if cfg.MailAttr == "" {
		cfg.MailAttr = "mail"
	}
	if cfg.GroupAttr == "" {
		cfg.GroupAttr = "memberOf"
	}
	tlsConf, err := buildLDAPTLSConfig(cfg)
	if err != nil {
		return nil, err
	}
	// Bind the production dialer with the configured timeout. The struct's dial
	// seam stays a func(url) so tests inject a fake directory unchanged; the real
	// wiring carries LDAP_TIMEOUT through to the net.Dialer + conn read deadline,
	// and the pinned TLS config (nil unless an LDAP_TLS_* knob is set) through to
	// both the ldaps:// dial and the ldap:// StartTLS upgrade.
	return &ldapAuth{cfg: cfg, tlsConf: tlsConf, dial: func(url string) (ldapConn, error) {
		return ldapDial(url, cfg.Timeout, tlsConf)
	}}, nil
}

// buildLDAPTLSConfig assembles the tls.Config for the directory connection, used
// for BOTH StartTLS (ldap://) and implicit TLS (ldaps://). It returns nil when no
// LDAP_TLS_* knob is set, so the default path (system roots) is byte-for-byte
// unchanged.
//
// LDAP_TLS_CA, when set, makes the PEM bundle the ONLY trust anchor: the directory
// cert must chain to it (an exact pin, NOT added to the system roots), so a private
// CA such as an Authentik outpost self-signed CA is trusted with FULL verification
// (a pinned root, never an insecure-skip).
//
// ServerName is the name verified against the cert SANs. go-ldap StartTLS hands the
// config straight to tls.Client WITHOUT deriving ServerName, so we MUST set it or
// verification fails: LDAP_TLS_SERVER_NAME when given (the cert name when LDAP_URL
// dials an IP), else the LDAP_URL host.
func buildLDAPTLSConfig(cfg LDAPCfg) (*tls.Config, error) {
	if cfg.TLSCAFile == "" && cfg.TLSServerName == "" && cfg.TLSPinSHA256 == "" {
		return nil, nil
	}

	// A CA-pin and a fingerprint-pin are two distinct trust models; refuse to guess
	// which the operator meant rather than silently pick one.
	if cfg.TLSCAFile != "" && cfg.TLSPinSHA256 != "" {
		return nil, fmt.Errorf("ldap tls: set LDAP_TLS_CA or LDAP_TLS_PIN_SHA256, not both (they are different trust models)")
	}

	tc := &tls.Config{MinVersion: tls.VersionTLS12}

	// Fingerprint-pin mode: pin the EXACT leaf certificate by its SHA-256. This is
	// SAN-independent, which is the point: a directory cert can carry an unusable SAN
	// (e.g. an Authentik default cert whose only SAN is the bare wildcard `*`, which
	// matches NO name in modern Go, so CA-pin + ServerName cannot verify it at all).
	//
	// InsecureSkipVerify is set ONLY so our VerifyPeerCertificate becomes the sole
	// gate. Despite the field name this is NOT an insecure bypass: it is an EXACT
	// certificate pin, STRICTER than CA verification (it trusts one specific cert, not
	// anything a CA signed) and MITM-resistant -- a swapped cert fails the SHA-256
	// match. crypto/tls honors VerifyPeerCertificate even when InsecureSkipVerify is
	// true. (Static analysis note: gosec G402 / a CodeQL InsecureSkipVerify finding
	// here is a JUSTIFIED suppression, not a real issue -- the pin is the verification.)
	if cfg.TLSPinSHA256 != "" {
		want, err := normalizePinSHA256(cfg.TLSPinSHA256)
		if err != nil {
			return nil, err
		}
		// ServerName, when given, is sent as SNI only; it plays no verification role
		// under the pin (the SHA-256 match is the verification).
		tc.ServerName = cfg.TLSServerName
		tc.InsecureSkipVerify = true // #nosec G402 -- gated by the exact-leaf SHA-256 pin below; verification is stricter, not skipped
		tc.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("ldap tls: peer presented no certificate")
			}
			got := sha256.Sum256(rawCerts[0]) // rawCerts[0] is the leaf DER
			if subtle.ConstantTimeCompare(got[:], want) != 1 {
				return fmt.Errorf("ldap tls: leaf certificate SHA-256 does not match LDAP_TLS_PIN_SHA256")
			}
			return nil
		}
		return tc, nil
	}

	// CA-pin / system-roots mode: verify the chain to a trusted root (a pinned
	// private CA when LDAP_TLS_CA is set, else the system roots) and the ServerName
	// against the cert SANs.
	tc.ServerName = cfg.TLSServerName
	if tc.ServerName == "" {
		if u, err := url.Parse(cfg.URL); err == nil {
			tc.ServerName = u.Hostname()
		}
	}

	if cfg.TLSCAFile != "" {
		pem, err := os.ReadFile(cfg.TLSCAFile)
		if err != nil {
			return nil, fmt.Errorf("ldap tls: reading LDAP_TLS_CA %q: %w", cfg.TLSCAFile, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("ldap tls: LDAP_TLS_CA %q contained no valid PEM certificate", cfg.TLSCAFile)
		}
		tc.RootCAs = pool
	}
	return tc, nil
}

// normalizePinSHA256 parses an LDAP_TLS_PIN_SHA256 value into its 32 raw bytes. It
// accepts the common fingerprint spellings -- colon-separated or bare hex, any case,
// surrounding whitespace -- so an operator can paste `openssl x509 -fingerprint
// -sha256` output directly. A SHA-256 is 32 bytes / 64 hex chars; anything else is a
// loud config error (we never start with a malformed pin that would reject every cert).
func normalizePinSHA256(s string) ([]byte, error) {
	clean := strings.Map(func(r rune) rune {
		switch r {
		case ':', ' ', '\t', '\n', '\r':
			return -1
		}
		return r
	}, s)
	clean = strings.ToLower(clean)
	b, err := hex.DecodeString(clean)
	if err != nil {
		return nil, fmt.Errorf("ldap tls: LDAP_TLS_PIN_SHA256 is not valid hex: %w", err)
	}
	if len(b) != sha256.Size {
		return nil, fmt.Errorf("ldap tls: LDAP_TLS_PIN_SHA256 must be a %d-byte SHA-256 (%d hex chars), got %d bytes", sha256.Size, sha256.Size*2, len(b))
	}
	return b, nil
}

func (a *ldapAuth) Authenticate(username, secret string) (string, error) {
	// An empty password must never bind: many directories treat an empty password
	// as an unauthenticated (anonymous) bind that SUCCEEDS, which would be an auth
	// bypass. Reject before we ever reach the wire.
	if strings.TrimSpace(username) == "" || secret == "" {
		return "", errAuthFailed
	}

	conn, err := a.dial(a.cfg.URL)
	if err != nil {
		return "", fmt.Errorf("ldap dial: %w", err)
	}
	defer conn.Close()

	if a.cfg.StartTLS && strings.HasPrefix(strings.ToLower(a.cfg.URL), "ldap://") {
		// a.tlsConf is nil unless an LDAP_TLS_* knob is set, so the default stays the
		// empty config (system roots). go-ldap passes this straight to tls.Client, so
		// when a CA is pinned the config carries RootCAs + ServerName.
		tc := a.tlsConf
		if tc == nil {
			tc = &tls.Config{}
		}
		if err := conn.StartTLS(tc); err != nil {
			return "", fmt.Errorf("ldap starttls: %w", err)
		}
	}

	return a.directBind(conn, username, secret)
}

// directBind binds DIRECTLY as the templated user DN (auth success == bind
// success), then self-reads that DN for the identity + authz gate. No privileged
// service account is involved.
func (a *ldapAuth) directBind(conn ldapConn, username, secret string) (string, error) {
	dn := fmt.Sprintf(a.cfg.BindDNTemplate, ldap.EscapeDN(username))
	if err := conn.Bind(dn, secret); err != nil {
		return "", errAuthFailed
	}
	return a.selfRead(conn, dn, username)
}

// selfRead reads the bound user's OWN entry (base scope, their own DN) for the
// mail identity and, when a group gate is configured (LDAP_REQUIRE_GROUP), the
// memberOf attribute. A non-superuser bind is permitted to read its own entry, so
// no privileged account is needed.
//
// The authz gate is FAIL-CLOSED: when LDAP_REQUIRE_GROUP is set, a self-read that
// errors, returns no entry, or returns an entry NOT carrying the required group is
// a denied login (never authenticate an account we cannot positively authorize).
// When no gate is set the prior behavior is preserved: a missing/failed self-read
// falls back to the login (pickIdentity) so a directory that hides own-mail still
// resolves an email-shaped login.
func (a *ldapAuth) selfRead(conn ldapConn, dn, username string) (string, error) {
	gate := a.cfg.RequireGroup != ""

	attrs := []string{a.cfg.MailAttr}
	if gate {
		attrs = append(attrs, a.cfg.GroupAttr)
	}
	req := ldap.NewSearchRequest(
		dn, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, 0, false,
		"(objectClass=*)", attrs, nil,
	)
	res, err := conn.Search(req)
	if err != nil {
		if gate {
			// Cannot confirm authorization -> deny. An infra fault, not a bad
			// credential, so surface the error (the session maps it to 535 too).
			return "", fmt.Errorf("ldap self-read for the %s authz gate failed: %w", a.cfg.GroupAttr, err)
		}
		return pickIdentity("", username, a.cfg.MailAttr)
	}
	if len(res.Entries) != 1 {
		if gate {
			return "", errAuthFailed
		}
		return pickIdentity("", username, a.cfg.MailAttr)
	}

	entry := res.Entries[0]
	if gate && !hasGroupValue(entry.GetAttributeValues(a.cfg.GroupAttr), a.cfg.RequireGroup) {
		// Bound OK (valid password) but NOT in the required group: a non-mail
		// account must not open the mail door. Denied, not an infra fault.
		return "", errAuthFailed
	}
	return pickIdentity(entry.GetAttributeValue(a.cfg.MailAttr), username, a.cfg.MailAttr)
}

// hasGroupValue reports whether want appears among the entry's group-attribute
// values, comparing as DNs: case-insensitive and insensitive to whitespace around
// the RDN separators (a directory may render memberOf with or without spaces after
// commas). This is a membership check, not full RFC 4514 normalization, which is
// sufficient for the fixed mail-users gate DN.
func hasGroupValue(values []string, want string) bool {
	target := normalizeDN(want)
	for _, v := range values {
		if normalizeDN(v) == target {
			return true
		}
	}
	return false
}

// normalizeDN lower-cases a DN and trims whitespace around each RDN so two
// spellings of the same DN compare equal.
func normalizeDN(dn string) string {
	parts := strings.Split(dn, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	return strings.ToLower(strings.Join(parts, ","))
}

// pickIdentity prefers the directory mail attribute; if absent it falls back to
// the login when the login is itself an address, else errors (we will not invent
// an unverifiable From identity).
func pickIdentity(mail, username, attr string) (string, error) {
	if mail != "" {
		return mail, nil
	}
	if strings.Contains(username, "@") {
		return username, nil
	}
	return "", fmt.Errorf("could not resolve a mail address (%s) for %q", attr, username)
}
