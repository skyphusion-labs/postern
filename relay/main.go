// Command skyphusion-email-relay is a localhost SMTP server that accepts mail
// from services on the box that can't speak HTTP, and relays each message to
// the skyphusion-email Cloudflare Worker over HTTPS.
package main

import "log"

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := run(cfg); err != nil {
		log.Fatalf("fatal: %v", err)
	}
}
