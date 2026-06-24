package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"os"
	"sync"
	"time"
)

// certReloader serves the submission TLS certificate and hot-reloads it when the
// cert file changes on disk, so a renewal (certbot, acme.sh, Cloudflare DNS-01,
// whatever the operator uses) takes effect WITHOUT restarting the daemon. The
// check is a cheap stat per TLS handshake; on a detected change it reloads the
// keypair. If a reload fails (e.g. a half-written file mid-renewal), it keeps
// serving the previous good certificate and logs.
//
// How the cert is OBTAINED is the operator's choice; the daemon only reads paths.
type certReloader struct {
	certPath string
	keyPath  string

	mu      sync.RWMutex
	cached  *tls.Certificate
	modTime time.Time

	// Injection points for tests; default to the real filesystem + loader.
	statFn func(string) (time.Time, error)
	loadFn func(certPath, keyPath string) (tls.Certificate, error)
}

func newCertReloader(certPath, keyPath string) (*certReloader, error) {
	r := &certReloader{
		certPath: certPath,
		keyPath:  keyPath,
		statFn:   statModTime,
		loadFn:   tls.LoadX509KeyPair,
	}
	if err := r.reload(); err != nil {
		return nil, fmt.Errorf("load submission TLS keypair: %w", err)
	}
	return r, nil
}

// GetCertificate is wired into tls.Config so every handshake (STARTTLS and
// implicit TLS alike) gets the current cert and picks up renewals automatically.
func (r *certReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	if mt, err := r.statFn(r.certPath); err == nil {
		r.mu.RLock()
		changed := mt.After(r.modTime)
		r.mu.RUnlock()
		if changed {
			if err := r.reload(); err != nil {
				log.Printf("submission TLS cert reload failed, serving previous cert: %v", err)
			} else {
				log.Printf("submission TLS cert reloaded from %s", r.certPath)
			}
		}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.cached, nil
}

func (r *certReloader) reload() error {
	cert, err := r.loadFn(r.certPath, r.keyPath)
	if err != nil {
		return err
	}
	mt, _ := r.statFn(r.certPath)
	r.mu.Lock()
	r.cached = &cert
	r.modTime = mt
	r.mu.Unlock()
	return nil
}

func statModTime(path string) (time.Time, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	return fi.ModTime(), nil
}
