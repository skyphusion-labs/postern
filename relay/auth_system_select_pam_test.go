//go:build pam

package main

import "testing"

// assertSystemBackend (-tags pam build): the system/PAM backend IS compiled in, so
// selecting it with a domain returns a real *systemAuth, and a missing
// AUTH_SYSTEM_DOMAIN is rejected. Mirrors the default-build helper, which instead
// asserts the stub error (auth_system_select_default_test.go).
func assertSystemBackend(t *testing.T, native AuthProvider) {
	t.Helper()
	got, err := selectAuthProvider(Config{Submission: SubmissionCfg{Backend: "system", SystemDomain: "example.com"}}, native)
	if err != nil {
		t.Fatalf("system backend with a domain: %v", err)
	}
	if _, ok := got.(*systemAuth); !ok {
		t.Errorf("provider = %T, want *systemAuth", got)
	}
	if _, err := selectAuthProvider(Config{Submission: SubmissionCfg{Backend: "system"}}, native); err == nil {
		t.Fatal("system backend without AUTH_SYSTEM_DOMAIN: want an error")
	}
}
