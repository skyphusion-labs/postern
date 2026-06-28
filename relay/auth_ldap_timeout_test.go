package main

import (
	"crypto/tls"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// #88: LDAP_TIMEOUT must reach the production dialer so a dead/slow directory
// cannot hang a login. newLDAPAuth wires cfg.Timeout into the real ldapDial; this
// captures the value the dialer is handed.
func TestLDAPAuth_TimeoutWiredToDialer(t *testing.T) {
	orig := ldapDial
	t.Cleanup(func() { ldapDial = orig })

	var got time.Duration
	called := false
	ldapDial = func(url string, timeout time.Duration, _ *tls.Config) (ldapConn, error) {
		called = true
		got = timeout
		return &fakeLDAP{
			searchFn: func(*ldap.SearchRequest) (*ldap.SearchResult, error) {
				return entryResult("uid=alice,dc=x", "mail", "alice@example.com"), nil
			},
		}, nil
	}

	a, err := newLDAPAuth(LDAPCfg{
		URL:            "ldaps://x",
		BindDNTemplate: "uid=%s,dc=x",
		MailAttr:       "mail",
		Timeout:        7 * time.Second,
	})
	if err != nil {
		t.Fatalf("newLDAPAuth: %v", err)
	}
	if _, err := a.Authenticate("alice", "pw"); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if !called {
		t.Fatal("production dialer was never invoked")
	}
	if got != 7*time.Second {
		t.Errorf("dialer timeout = %v, want 7s", got)
	}
}

// LDAP_TIMEOUT parses to a duration in seconds, defaulting to 10s when unset.
func TestConfig_LDAPTimeout(t *testing.T) {
	t.Run("defaults to 10s when unset", func(t *testing.T) {
		clearRelayEnv(t)
		t.Setenv("LDAP_TIMEOUT", "")
		t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
		t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")
		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.Submission.LDAP.Timeout != 10*time.Second {
			t.Errorf("LDAP timeout = %v, want 10s default", cfg.Submission.LDAP.Timeout)
		}
	})

	t.Run("honors an explicit value (seconds)", func(t *testing.T) {
		clearRelayEnv(t)
		t.Setenv("LDAP_TIMEOUT", "25")
		t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
		t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")
		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.Submission.LDAP.Timeout != 25*time.Second {
			t.Errorf("LDAP timeout = %v, want 25s", cfg.Submission.LDAP.Timeout)
		}
	})
}
