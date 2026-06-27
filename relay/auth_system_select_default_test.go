//go:build !pam

package main

import (
	"strings"
	"testing"
)

// assertSystemBackend (default, cgo-free build): the system/PAM backend is NOT
// compiled in, so selecting it must fail with an actionable "rebuild with -tags
// pam" error rather than silently doing nothing. The -tags pam build provides the
// success-path variant of this helper (auth_system_select_pam_test.go).
func assertSystemBackend(t *testing.T, native AuthProvider) {
	t.Helper()
	cfg := Config{Submission: SubmissionCfg{Backend: "system", SystemDomain: "example.com"}}
	_, err := selectAuthProvider(cfg, native)
	if err == nil || !strings.Contains(err.Error(), "pam") {
		t.Fatalf("err = %v, want an error mentioning the pam build tag", err)
	}
}
