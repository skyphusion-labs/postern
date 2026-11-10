package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"testing"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
)

// The no-knob default (no LDAP_TLS_CA, no LDAP_TLS_PIN_SHA256, no
// LDAP_TLS_SERVER_NAME) on a REAL handshake: real go-ldap StartTLS, real crypto/tls,
// a local fake directory. The property asserted is whether the bind password
// reaches the peer. ldapDefaultRoots stands in for the system roots so a trusted
// certificate can be driven too; in production it is nil (the system roots).

const defaultTLSWirePassword = "wire-test-bind-password-canary"

type wireCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newWireCA(t *testing.T) wireCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "postern wire test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create CA: %v", err)
	}
	cert, _ := x509.ParseCertificate(der)
	return wireCA{cert: cert, key: key}
}

// leaf issues a server cert for name, signed by ca (or self-signed when ca is nil).
func wireLeaf(t *testing.T, ca *wireCA, name string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{name},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	parent, signer := tmpl, any(key)
	if ca != nil {
		parent, signer = ca.cert, ca.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatalf("create leaf: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// startTLSDirectory accepts ONE connection, answers the StartTLS extended op with
// success, serves TLS with cert, and reports on the returned channel whether the
// bind password arrived over that channel.
func startTLSDirectory(t *testing.T, cert tls.Certificate) (string, <-chan bool) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan bool, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			got <- false
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		p, err := ber.ReadPacket(c)
		if err != nil || len(p.Children) == 0 {
			got <- false
			return
		}
		id, _ := p.Children[0].Value.(int64)
		resp := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "")
		resp.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, ""))
		ext := ber.Encode(ber.ClassApplication, ber.TypeConstructed, 24, nil, "") // ExtendedResponse
		ext.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, 0, ""))
		ext.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", ""))
		ext.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", ""))
		resp.AppendChild(ext)
		if _, err := c.Write(resp.Bytes()); err != nil {
			got <- false
			return
		}
		tc := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}})
		if err := tc.Handshake(); err != nil {
			got <- false
			return
		}
		buf := make([]byte, 4096)
		n, _ := tc.Read(buf)
		got <- bytes.Contains(buf[:n], []byte(defaultTLSWirePassword))
	}()
	return ln.Addr().String(), got
}

// withDefaultRoots points the no-knob default at pool for one test.
func withDefaultRoots(t *testing.T, pool *x509.CertPool) {
	t.Helper()
	saved := ldapDefaultRoots
	ldapDefaultRoots = pool
	t.Cleanup(func() { ldapDefaultRoots = saved })
}

// defaultStartTLSBind runs the shipped Authenticate with NO TLS knob against a
// fake directory at host:port presenting cert. It returns the Authenticate error
// and whether the directory received the bind password.
func defaultStartTLSBind(t *testing.T, host string, cert tls.Certificate) (error, bool) {
	t.Helper()
	addr, got := startTLSDirectory(t, cert)
	_, port, _ := net.SplitHostPort(addr)
	a, err := newLDAPAuth(LDAPCfg{
		URL:            "ldap://" + net.JoinHostPort(host, port),
		StartTLS:       true,
		BindDNTemplate: "cn=%s,dc=example",
		MailAttr:       "mail",
		Timeout:        5 * time.Second,
	})
	if err != nil {
		t.Fatalf("newLDAPAuth: %v", err)
	}
	_, aerr := a.Authenticate("alice", defaultTLSWirePassword)
	select {
	case received := <-got:
		return aerr, received
	case <-time.After(6 * time.Second):
		return aerr, false
	}
}

func wirePool(ca wireCA) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(ca.cert)
	return p
}

// A certificate the default roots trust, for the LDAP_URL host, verifies and the
// bind goes through. This is the case that could never work before: StartTLS
// carried no ServerName, so crypto/tls refused every handshake.
func TestLDAPDefaultStartTLS_TrustedCertForHostVerifies(t *testing.T) {
	ca := newWireCA(t)
	withDefaultRoots(t, wirePool(ca))
	err, received := defaultStartTLSBind(t, "localhost", wireLeaf(t, &ca, "localhost"))
	if !received {
		t.Fatalf("a trusted directory cert for the LDAP_URL host did not carry the bind (Authenticate err=%v)", err)
	}
}

// An untrusted (self-signed) directory certificate is refused before the bind.
func TestLDAPDefaultStartTLS_UntrustedCertRefused(t *testing.T) {
	ca := newWireCA(t)
	withDefaultRoots(t, wirePool(ca))
	err, received := defaultStartTLSBind(t, "localhost", wireLeaf(t, nil, "localhost"))
	if received {
		t.Fatal("the bind password reached a directory with an untrusted certificate")
	}
	if err == nil {
		t.Fatal("Authenticate succeeded against an untrusted directory certificate")
	}
}

// A trusted certificate that names a DIFFERENT host is refused before the bind.
func TestLDAPDefaultStartTLS_TrustedCertForOtherHostRefused(t *testing.T) {
	ca := newWireCA(t)
	withDefaultRoots(t, wirePool(ca))
	err, received := defaultStartTLSBind(t, "localhost", wireLeaf(t, &ca, "other.test"))
	if received {
		t.Fatal("the bind password reached a directory whose certificate names another host")
	}
	if err == nil {
		t.Fatal("Authenticate succeeded against a certificate for another host")
	}
}

// ldaps:// with no knob goes through go-ldap's own dial (system roots, ServerName
// derived from the address). An untrusted certificate is refused there too.
func TestLDAPDefaultLDAPS_UntrustedCertRefused(t *testing.T) {
	cert := wireLeaf(t, nil, "localhost")
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			c.(*tls.Conn).Handshake()
			c.Close()
		}
	}()
	c, err := ldapDial("ldaps://"+ln.Addr().String(), 5*time.Second, nil)
	if err == nil {
		c.Close()
		t.Fatal("ldaps:// with no TLS knob connected to an untrusted directory certificate")
	}
}
