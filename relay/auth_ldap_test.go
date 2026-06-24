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
	bindFn    func(dn, password string) error
	searchFn  func(*ldap.SearchRequest) (*ldap.SearchResult, error)
	startTLS  bool
	bindCalls []string
}

func (f *fakeLDAP) StartTLS(*tls.Config) error { f.startTLS = true; return nil }
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

func TestLDAPAuth_SearchBind(t *testing.T) {
	t.Run("service search then user bind returns mail", func(t *testing.T) {
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResult("uid=carol,ou=people,dc=x", "mail", "carol@example.com"), nil
			},
		}
		a := &ldapAuth{
			cfg: LDAPCfg{
				URL: "ldaps://x", BindDN: "cn=svc,dc=x", BindPassword: "svcpw",
				SearchBase: "ou=people,dc=x", SearchFilter: "(uid=%s)", MailAttr: "mail",
			},
			dial: func(string) (ldapConn, error) { return fake, nil },
		}
		id, err := a.Authenticate("carol", "pw")
		if err != nil {
			t.Fatalf("Authenticate: %v", err)
		}
		if id != "carol@example.com" {
			t.Errorf("identity = %q", id)
		}
		// First bind is the service account, second is the user DN.
		if len(fake.bindCalls) != 2 || fake.bindCalls[0] != "cn=svc,dc=x" || fake.bindCalls[1] != "uid=carol,ou=people,dc=x" {
			t.Errorf("bindCalls = %#v, want [service, userDN]", fake.bindCalls)
		}
	})

	t.Run("no entry is errAuthFailed", func(t *testing.T) {
		fake := &fakeLDAP{searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) { return &ldap.SearchResult{}, nil }}
		a := &ldapAuth{
			cfg: LDAPCfg{
				URL: "ldaps://x", BindDN: "cn=svc,dc=x", BindPassword: "svcpw",
				SearchBase: "ou=people,dc=x", SearchFilter: "(uid=%s)", MailAttr: "mail",
			},
			dial: func(string) (ldapConn, error) { return fake, nil },
		}
		if _, err := a.Authenticate("ghost", "pw"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
	})

	t.Run("wrong user password after a found entry is errAuthFailed", func(t *testing.T) {
		fake := &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResult("uid=dave,ou=people,dc=x", "mail", "dave@example.com"), nil
			},
			bindFn: func(dn, pw string) error {
				if dn == "uid=dave,ou=people,dc=x" {
					return fmt.Errorf("invalid credentials")
				}
				return nil // service bind ok
			},
		}
		a := &ldapAuth{
			cfg: LDAPCfg{
				URL: "ldaps://x", BindDN: "cn=svc,dc=x", BindPassword: "svcpw",
				SearchBase: "ou=people,dc=x", SearchFilter: "(uid=%s)", MailAttr: "mail",
			},
			dial: func(string) (ldapConn, error) { return fake, nil },
		}
		if _, err := a.Authenticate("dave", "wrong"); err != errAuthFailed {
			t.Errorf("err = %v, want errAuthFailed", err)
		}
	})
}

func TestNewLDAPAuth_Validation(t *testing.T) {
	t.Run("plaintext ldap rejected", func(t *testing.T) {
		if _, err := newLDAPAuth(LDAPCfg{URL: "ldap://x", BindDNTemplate: "uid=%s,dc=x"}); err == nil {
			t.Error("want TLS-required error")
		}
	})
	t.Run("missing bind config rejected", func(t *testing.T) {
		if _, err := newLDAPAuth(LDAPCfg{URL: "ldaps://x"}); err == nil {
			t.Error("want error for no template and no search config")
		}
	})
	t.Run("ldaps simple bind ok, defaults mail attr", func(t *testing.T) {
		a, err := newLDAPAuth(LDAPCfg{URL: "ldaps://x", BindDNTemplate: "uid=%s,dc=x"})
		if err != nil {
			t.Fatalf("newLDAPAuth: %v", err)
		}
		if a.cfg.MailAttr != "mail" {
			t.Errorf("MailAttr default = %q, want mail", a.cfg.MailAttr)
		}
	})
}
