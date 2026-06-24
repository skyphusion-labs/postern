package main

import (
	"crypto/tls"
	"fmt"
	"testing"
	"time"
)

func TestCertReloader_HotReloadsOnChange(t *testing.T) {
	var loadCount int
	var modTime = time.Unix(1000, 0)

	r := &certReloader{
		certPath: "cert.pem",
		keyPath:  "key.pem",
		statFn:   func(string) (time.Time, error) { return modTime, nil },
		loadFn: func(_, _ string) (tls.Certificate, error) {
			loadCount++
			return tls.Certificate{}, nil
		},
	}
	if err := r.reload(); err != nil {
		t.Fatalf("initial reload: %v", err)
	}
	if loadCount != 1 {
		t.Fatalf("loadCount after initial reload = %d, want 1", loadCount)
	}

	// Same mtime: GetCertificate must NOT reload (cheap path).
	if _, err := r.GetCertificate(nil); err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}
	if loadCount != 1 {
		t.Errorf("loadCount with unchanged mtime = %d, want 1 (no reload)", loadCount)
	}

	// Advance the cert file mtime (simulating a renewal): next handshake reloads.
	modTime = time.Unix(2000, 0)
	if _, err := r.GetCertificate(nil); err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}
	if loadCount != 2 {
		t.Errorf("loadCount after mtime change = %d, want 2 (hot reload)", loadCount)
	}
}

func TestCertReloader_KeepsPreviousCertOnReloadFailure(t *testing.T) {
	var fail bool
	var modTime = time.Unix(1000, 0)
	good := tls.Certificate{Certificate: [][]byte{{0x01}}}

	r := &certReloader{
		certPath: "cert.pem",
		statFn:   func(string) (time.Time, error) { return modTime, nil },
		loadFn: func(_, _ string) (tls.Certificate, error) {
			if fail {
				return tls.Certificate{}, fmt.Errorf("half-written file mid-renewal")
			}
			return good, nil
		},
	}
	if err := r.reload(); err != nil {
		t.Fatalf("initial reload: %v", err)
	}

	// A renewal that fails to load (e.g. read mid-write) must keep serving the
	// last good cert, not nil.
	fail = true
	modTime = time.Unix(2000, 0)
	cert, err := r.GetCertificate(nil)
	if err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}
	if cert == nil || len(cert.Certificate) != 1 {
		t.Errorf("served cert = %#v, want the previous good cert", cert)
	}
}
