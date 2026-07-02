package main

import (
	"crypto/tls"
	"fmt"
	"testing"

	"github.com/go-ldap/ldap/v3"
)

// fakeLDAP is an in-memory directory: bindFn decides whether a (dn, password)
// bind succeeds, searchFn answers searches. Either may be nil (no-op success /
// empty result).
type fakeLDAP struct {
	bindFn       func(dn, password string) error
	searchFn     func(*ldap.SearchRequest) (*ldap.SearchResult, error)
	startTLS     bool
	startTLSConf *tls.Config // the config the door handed to the StartTLS upgrade
	bindCalls    []string
}

func (f *fakeLDAP) StartTLS(tc *tls.Config) error { f.startTLS = true; f.startTLSConf = tc; return nil }
func (f *fakeLDAP) Bind(dn, password string) error {
	f.bindCalls = append(f.bindCalls, dn)
	if f.bindFn != nil {
		return f.bindFn(dn, password)
	}
	return nil
}
func (f *fakeLDAP) Search(r *ldap.SearchRequest) (*ldap.SearchResult, error) {
	if f.searchFn != nil {
		return f.searchFn(r)
	}
	return &ldap.SearchResult{}, nil
}
func (f *fakeLDAP) Close() error { return nil }

func entryResult(dn, attr, value string) *ldap.SearchResult {
	return &ldap.SearchResult{Entries: []*ldap.Entry{ldap.NewEntry(dn, map[string][]string{attr: {value}})}}
}

func TestLDAPAuth_SimpleBind(t *testing.T) {
	t.Run("good password returns the mail attribute", func(t *testing.T) {
		fake := &fakeLDAP{
			bindFn: func(dn, pw string) error { return nil },
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResult("uid=alice,dc=x", "mail", "alice@example.com"), nil
			},
		}
		a := &ldapAuth{
			cfg:  LDAPCfg{URL: "ldaps://x", BindDNTemplate: "uid=%s,ou=people,dc=x", MailAttr: "mail"},
			dial: func(string) (ldapConn, error) { return fake, nil },
		}
		id, err := a.Authenticate("alice", "pw")
		if err != nil {
			t.Fatalf("Authenticate: %v", err)
		}
		if id != "alice@example.com" {
			t.Errorf("identity = %q, want alice@example.com", id)
		}
	})

	t.Run("bad password is errAuthFailed", func(t *testing.T) {
		fake := &fakeLDAP{bindFn: func(dn, pw string) error { return fmt.Errorf("invalid credentials") }}
		a := &ldapAuth{
			cfg:  LDAPCfg{URL: "ldaps://x", BindDNTemplate: "uid=%s,dc=x", MailAttr: "mail"},
			dial: func(string) (ldapConn, error) { return fake, nil },
		}
		if _, err := a.Authenticate("alice", "wrong"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
	})

	t.Run("empty password never reaches the wire", func(t *testing.T) {
		dialed := false
		a := &ldapAuth{
			cfg:  LDAPCfg{URL: "ldaps://x", BindDNTemplate: "uid=%s,dc=x"},
			dial: func(string) (ldapConn, error) { dialed = true; return &fakeLDAP{}, nil },
		}
		if _, err := a.Authenticate("alice", ""); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
		if dialed {
			t.Error("dialed the directory for an empty password (anonymous-bind bypass risk)")
		}
	})

	t.Run("missing mail attr falls back to an email-shaped login", func(t *testing.T) {
		fake := &fakeLDAP{searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) { return &ldap.SearchResult{}, nil }}
		a := &ldapAuth{
			cfg:  LDAPCfg{URL: "ldaps://x", BindDNTemplate: "uid=%s,dc=x", MailAttr: "mail"},
			dial: func(string) (ldapConn, error) { return fake, nil },
		}
		id, err := a.Authenticate("bob@example.com", "pw")
		if err != nil || id != "bob@example.com" {
			t.Errorf("id=%q err=%v, want bob@example.com fallback", id, err)
		}
	})
}

// entryResultAttrs builds a single-entry result carrying several attributes (mail
// + memberOf), so the self-read group gate can be exercised.
func entryResultAttrs(dn string, attrs map[string][]string) *ldap.SearchResult {
	return &ldap.SearchResult{Entries: []*ldap.Entry{ldap.NewEntry(dn, attrs)}}
}

// The mail-users gate DN exactly as Authentik renders it (and as the deploy sets
// LDAP_REQUIRE_GROUP).
const mailUsersDN = "cn=mail-users,ou=groups,dc=ldap,dc=goauthentik,dc=io"

func TestLDAPAuth_DirectBind_SelfRead(t *testing.T) {
	cfg := func() LDAPCfg {
		return LDAPCfg{
			URL:            "ldaps://x",
			BindDNTemplate: "cn=%s,ou=users,dc=ldap,dc=goauthentik,dc=io",
			MailAttr:       "mail",
			GroupAttr:      "memberOf",
			RequireGroup:   mailUsersDN,
		}
	}

	t.Run("good password, in mail-users -> returns mail, binds ONCE as the user", func(t *testing.T) {
		userDN := "cn=conrad,ou=users,dc=ldap,dc=goauthentik,dc=io"
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResultAttrs(userDN, map[string][]string{
					"mail":     {"conrad@skyphusion.org"},
					"memberOf": {"cn=other,ou=groups,dc=ldap,dc=goauthentik,dc=io", mailUsersDN},
				}), nil
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		id, err := a.Authenticate("conrad", "pw")
		if err != nil {
			t.Fatalf("Authenticate: %v", err)
		}
		if id != "conrad@skyphusion.org" {
			t.Errorf("identity = %q, want conrad@skyphusion.org", id)
		}
		// Direct-bind = exactly ONE bind, as the user's own DN (no service account).
		if len(fake.bindCalls) != 1 || fake.bindCalls[0] != userDN {
			t.Errorf("bindCalls = %#v, want exactly [%q]", fake.bindCalls, userDN)
		}
	})

	t.Run("the self-read is base-scoped on the user's OWN DN", func(t *testing.T) {
		userDN := "cn=conrad,ou=users,dc=ldap,dc=goauthentik,dc=io"
		var gotBase string
		var gotScope int
		fake := &fakeLDAP{
			searchFn: func(r *ldap.SearchRequest) (*ldap.SearchResult, error) {
				gotBase, gotScope = r.BaseDN, r.Scope
				return entryResultAttrs(userDN, map[string][]string{
					"mail": {"conrad@skyphusion.org"}, "memberOf": {mailUsersDN},
				}), nil
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		if _, err := a.Authenticate("conrad", "pw"); err != nil {
			t.Fatalf("Authenticate: %v", err)
		}
		if gotBase != userDN {
			t.Errorf("self-read base = %q, want the user's own DN %q", gotBase, userDN)
		}
		if gotScope != ldap.ScopeBaseObject {
			t.Errorf("self-read scope = %d, want ScopeBaseObject (%d)", gotScope, ldap.ScopeBaseObject)
		}
	})

	t.Run("bad password is errAuthFailed (no self-read attempted)", func(t *testing.T) {
		searched := false
		fake := &fakeLDAP{
			bindFn: func(dn, pw string) error { return fmt.Errorf("invalid credentials") },
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				searched = true
				return &ldap.SearchResult{}, nil
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		if _, err := a.Authenticate("conrad", "wrong"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
		if searched {
			t.Error("self-read ran after a failed bind")
		}
	})

	t.Run("valid password but NOT in mail-users is errAuthFailed", func(t *testing.T) {
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResultAttrs("cn=nobody,ou=users,dc=ldap,dc=goauthentik,dc=io", map[string][]string{
					"mail":     {"nobody@skyphusion.org"},
					"memberOf": {"cn=other,ou=groups,dc=ldap,dc=goauthentik,dc=io"},
				}), nil
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		if _, err := a.Authenticate("nobody", "pw"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed (gate must reject a non-mail-users account)", err)
		}
	})

	t.Run("gate DN match is case- and whitespace-insensitive", func(t *testing.T) {
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResultAttrs("cn=conrad,ou=users,dc=ldap,dc=goauthentik,dc=io", map[string][]string{
					"mail":     {"conrad@skyphusion.org"},
					"memberOf": {"CN=mail-users, OU=groups, DC=ldap, DC=goauthentik, DC=io"},
				}), nil
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		if _, err := a.Authenticate("conrad", "pw"); err != nil {
			t.Errorf("Authenticate: %v, want success (DN compare must ignore case + spacing)", err)
		}
	})

	t.Run("gate FAILS CLOSED when the self-read errors", func(t *testing.T) {
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return nil, fmt.Errorf("directory unavailable")
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		// A gate that cannot be confirmed must DENY, not authenticate.
		if id, err := a.Authenticate("conrad", "pw"); err == nil {
			t.Errorf("got id=%q err=nil, want a denial when the authz self-read fails", id)
		}
	})

	t.Run("gate FAILS CLOSED when the self-read returns no entry", func(t *testing.T) {
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return &ldap.SearchResult{}, nil
			},
		}
		a := &ldapAuth{cfg: cfg(), dial: func(string) (ldapConn, error) { return fake, nil }}
		if _, err := a.Authenticate("conrad", "pw"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed when the self-read returns no entry", err)
		}
	})

	t.Run("no gate configured: self-read failure falls back to an email-shaped login", func(t *testing.T) {
		c := cfg()
		c.RequireGroup = "" // gate off
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return &ldap.SearchResult{}, nil
			},
		}
		a := &ldapAuth{cfg: c, dial: func(string) (ldapConn, error) { return fake, nil }}
		id, err := a.Authenticate("bob@example.com", "pw")
		if err != nil || id != "bob@example.com" {
			t.Errorf("id=%q err=%v, want bob@example.com fallback with no gate", id, err)
		}
	})
}

func TestHasGroupValue(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   string
		ok     bool
	}{
		{"exact match", []string{mailUsersDN}, mailUsersDN, true},
		{"absent", []string{"cn=other,ou=groups,dc=ldap,dc=goauthentik,dc=io"}, mailUsersDN, false},
		{"case-insensitive", []string{"CN=Mail-Users,OU=Groups,DC=ldap,DC=goauthentik,DC=io"}, mailUsersDN, true},
		{"spaces after commas", []string{"cn=mail-users, ou=groups, dc=ldap, dc=goauthentik, dc=io"}, mailUsersDN, true},
		{"empty values", nil, mailUsersDN, false},
		{"one of several", []string{"cn=a,dc=x", mailUsersDN, "cn=b,dc=x"}, mailUsersDN, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasGroupValue(tc.values, tc.want); got != tc.ok {
				t.Errorf("hasGroupValue(%#v, %q) = %v, want %v", tc.values, tc.want, got, tc.ok)
			}
		})
	}
}

func TestNewLDAPAuth_Validation(t *testing.T) {
	t.Run("plaintext ldap rejected", func(t *testing.T) {
		if _, err := newLDAPAuth(LDAPCfg{URL: "ldap://x", BindDNTemplate: "uid=%s,dc=x"}); err == nil {
			t.Error("want TLS-required error")
		}
	})
	t.Run("missing bind template rejected", func(t *testing.T) {
		if _, err := newLDAPAuth(LDAPCfg{URL: "ldaps://x"}); err == nil {
			t.Error("want error for a missing LDAP_BIND_DN_TEMPLATE")
		}
	})
	t.Run("ldaps direct-bind ok, defaults mail + group attrs", func(t *testing.T) {
		a, err := newLDAPAuth(LDAPCfg{URL: "ldaps://x", BindDNTemplate: "cn=%s,dc=x"})
		if err != nil {
			t.Fatalf("newLDAPAuth: %v", err)
		}
		if a.cfg.MailAttr != "mail" {
			t.Errorf("MailAttr default = %q, want mail", a.cfg.MailAttr)
		}
		if a.cfg.GroupAttr != "memberOf" {
			t.Errorf("GroupAttr default = %q, want memberOf", a.cfg.GroupAttr)
		}
	})
}
