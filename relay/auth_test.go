package main

import (
	"testing"
)

type fakeAuth struct{ id string }

func (f fakeAuth) Authenticate(_, _ string) (string, error) { return f.id, nil }

func TestSelectAuthProvider(t *testing.T) {
	native := fakeAuth{id: "native"}

	t.Run("default + native return the passed native provider", func(t *testing.T) {
		for _, backend := range []string{"", "native"} {
			cfg := Config{Submission: SubmissionCfg{Backend: backend}}
			got, err := selectAuthProvider(cfg, native)
			if err != nil {
				t.Fatalf("backend %q: %v", backend, err)
			}
			if got != native {
				t.Errorf("backend %q: provider = %#v, want the native provider", backend, got)
			}
		}
	})

	t.Run("ldap returns an ldapAuth", func(t *testing.T) {
		cfg := Config{Submission: SubmissionCfg{
			Backend: "ldap",
			LDAP:    LDAPCfg{URL: "ldaps://x", BindDNTemplate: "uid=%s,dc=x"},
		}}
		got, err := selectAuthProvider(cfg, native)
		if err != nil {
			t.Fatalf("ldap: %v", err)
		}
		if _, ok := got.(*ldapAuth); !ok {
			t.Errorf("provider = %T, want *ldapAuth", got)
		}
	})

	// The system/PAM backend behaves differently per build tag (stub error in the
	// default cgo-free build, real provider under -tags pam), so its assertion lives
	// in a build-tagged helper (auth_system_select_{default,pam}_test.go).
	t.Run("system backend", func(t *testing.T) {
		assertSystemBackend(t, native)
	})

	t.Run("unknown backend is rejected", func(t *testing.T) {
		cfg := Config{Submission: SubmissionCfg{Backend: "radius"}}
		if _, err := selectAuthProvider(cfg, native); err == nil {
			t.Fatal("want error for an unknown backend")
		}
	})
}
