//go:build pam

package main

import (
	"fmt"
	"strings"

	"github.com/msteinert/pam"
)

// systemAuth authenticates against local Unix accounts via PAM (#68). It is an
// OPT-IN, build-tagged backend: it needs cgo + libpam, so it is excluded from the
// default static build (see auth_system.go for the stub). Build with -tags pam.
//
// The bound identity is <user>@<AUTH_SYSTEM_DOMAIN>, since a Unix account has no
// inherent mail address; the operator declares the domain the box sends as.
type systemAuth struct {
	domain  string
	service string
}

func newSystemAuth(domain, service string) (AuthProvider, error) {
	if domain == "" {
		return nil, fmt.Errorf("AUTH_SYSTEM_DOMAIN is required for the system auth backend")
	}
	if service == "" {
		service = "postern"
	}
	return &systemAuth{domain: domain, service: service}, nil
}

func (a *systemAuth) Authenticate(username, secret string) (string, error) {
	if strings.TrimSpace(username) == "" || secret == "" {
		return "", errAuthFailed
	}

	// Allow logging in as "user" or "user@domain"; PAM authenticates the local part.
	local := username
	if i := strings.IndexByte(local, '@'); i >= 0 {
		local = local[:i]
	}

	t, err := pam.StartFunc(a.service, local, func(style pam.Style, _ string) (string, error) {
		switch style {
		case pam.PromptEchoOff:
			return secret, nil
		case pam.PromptEchoOn:
			return local, nil
		case pam.ErrorMsg, pam.TextInfo:
			return "", nil
		default:
			return "", fmt.Errorf("unsupported PAM conversation style")
		}
	})
	if err != nil {
		return "", fmt.Errorf("pam start: %w", err)
	}

	if err := t.Authenticate(0); err != nil {
		return "", errAuthFailed
	}
	if err := t.AcctMgmt(0); err != nil {
		return "", errAuthFailed
	}
	return local + "@" + a.domain, nil
}
