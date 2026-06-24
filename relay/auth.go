package main

import (
	"errors"
	"fmt"
)

// errAuthFailed is the shared sentinel meaning "bad credential" across every auth
// backend. The submission session maps it to SMTP 535; any OTHER error from a
// provider is an infra fault (logged, also surfaced to the client as 535 so a
// misconfig never leaks whether a username exists).
var errAuthFailed = errors.New("authentication failed")

// AuthProvider verifies a submission login and returns the authoritative bound
// identity (the address the message From must match). The From-enforcement rule
// is identical for every backend; only the verification differs. Postern stays
// domain-agnostic: the identity is whatever the backend resolves, never a
// hardcoded domain.
type AuthProvider interface {
	Authenticate(username, secret string) (identity string, err error)
}

// selectAuthProvider builds the AuthProvider chosen by AUTH_BACKEND. native is
// the zero-extra-dependency default (it reuses the worker /api/smtp-auth check,
// so the fresh-clone quickstart needs no LDAP/PAM). native reuses the same
// *SubmitClient that performs the /api/send bridge, passed in as nativeAuth.
func selectAuthProvider(cfg Config, nativeAuth AuthProvider) (AuthProvider, error) {
	switch cfg.Submission.Backend {
	case "", "native":
		return nativeAuth, nil
	case "ldap":
		return newLDAPAuth(cfg.Submission.LDAP)
	case "system":
		return newSystemAuth(cfg.Submission.SystemDomain, cfg.Submission.SystemService)
	default:
		return nil, fmt.Errorf("unknown AUTH_BACKEND %q (want native|ldap|system)", cfg.Submission.Backend)
	}
}
