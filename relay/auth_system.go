//go:build !pam

package main

import "fmt"

// newSystemAuth (default build): the system (PAM) backend is NOT compiled in, so
// the default relay binary stays cgo-free and static. Selecting AUTH_BACKEND=system
// without the `pam` build tag fails with an actionable message. See auth_system_pam.go.
func newSystemAuth(_, _ string) (AuthProvider, error) {
	return nil, fmt.Errorf("the system (PAM) auth backend is not compiled in this build; rebuild the relay with -tags pam (and libpam headers) to enable AUTH_BACKEND=system")
}
