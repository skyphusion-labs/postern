package main

import (
	"crypto/tls"
	"fmt"
	"strings"

	"github.com/go-ldap/ldap/v3"
)

// ldapAuth is the LDAP auth backend (#68): it verifies a login by binding to the
// directory over TLS, then resolves the bound identity from the mail attribute.
// Two modes: simple bind (LDAP_BIND_DN_TEMPLATE) or search+bind (a service
// account searches for the user's DN, then the user's password is bound to
// verify it). TLS is mandatory; a bind carries the password in the clear.
type ldapAuth struct {
	cfg  LDAPCfg
	dial func(url string) (ldapConn, error)
}

// ldapConn is the slice of *ldap.Conn the backend uses, behind an interface so
// tests can substitute a fake directory without a live LDAP server.
type ldapConn interface {
	StartTLS(*tls.Config) error
	Bind(username, password string) error
	Search(*ldap.SearchRequest) (*ldap.SearchResult, error)
	Close() error
}

// ldapDial is the production dialer (overridable in tests).
var ldapDial = func(url string) (ldapConn, error) {
	c, err := ldap.DialURL(url)
	if err != nil {
		return nil, err
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
	if cfg.BindDNTemplate == "" && (cfg.BindDN == "" || cfg.SearchBase == "" || cfg.SearchFilter == "") {
		return nil, fmt.Errorf("ldap auth needs LDAP_BIND_DN_TEMPLATE (simple bind) or LDAP_BIND_DN + LDAP_SEARCH_BASE + LDAP_SEARCH_FILTER (search+bind)")
	}
	if cfg.MailAttr == "" {
		cfg.MailAttr = "mail"
	}
	return &ldapAuth{cfg: cfg, dial: ldapDial}, nil
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
		if err := conn.StartTLS(&tls.Config{}); err != nil {
			return "", fmt.Errorf("ldap starttls: %w", err)
		}
	}

	if a.cfg.BindDNTemplate != "" {
		return a.simpleBind(conn, username, secret)
	}
	return a.searchBind(conn, username, secret)
}

// simpleBind binds as the templated DN, then resolves the mail attribute.
func (a *ldapAuth) simpleBind(conn ldapConn, username, secret string) (string, error) {
	dn := fmt.Sprintf(a.cfg.BindDNTemplate, ldap.EscapeDN(username))
	if err := conn.Bind(dn, secret); err != nil {
		return "", errAuthFailed
	}
	return a.resolveMail(conn, dn, username)
}

// searchBind binds a service account, searches for the user's DN, binds the
// user's password to verify it, then returns the mail attribute.
func (a *ldapAuth) searchBind(conn ldapConn, username, secret string) (string, error) {
	if err := conn.Bind(a.cfg.BindDN, a.cfg.BindPassword); err != nil {
		return "", fmt.Errorf("ldap service bind failed: %w", err)
	}
	filter := fmt.Sprintf(a.cfg.SearchFilter, ldap.EscapeFilter(username))
	req := ldap.NewSearchRequest(
		a.cfg.SearchBase, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 2, 0, false,
		filter, []string{a.cfg.MailAttr}, nil,
	)
	res, err := conn.Search(req)
	if err != nil {
		return "", fmt.Errorf("ldap search: %w", err)
	}
	if len(res.Entries) != 1 {
		// 0 = no such user; >1 = ambiguous. Either way, do not authenticate.
		return "", errAuthFailed
	}
	userDN := res.Entries[0].DN
	mail := res.Entries[0].GetAttributeValue(a.cfg.MailAttr)
	if err := conn.Bind(userDN, secret); err != nil {
		return "", errAuthFailed
	}
	return pickIdentity(mail, username, a.cfg.MailAttr)
}

// resolveMail reads the mail attribute from a base-scoped lookup of the bound DN.
func (a *ldapAuth) resolveMail(conn ldapConn, dn, username string) (string, error) {
	req := ldap.NewSearchRequest(
		dn, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, 0, false,
		"(objectClass=*)", []string{a.cfg.MailAttr}, nil,
	)
	mail := ""
	if res, err := conn.Search(req); err == nil && len(res.Entries) == 1 {
		mail = res.Entries[0].GetAttributeValue(a.cfg.MailAttr)
	}
	return pickIdentity(mail, username, a.cfg.MailAttr)
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
