package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is loaded entirely from the environment so the systemd unit can drive
// it via an EnvironmentFile. No config file, no flags.
type Config struct {
	Listen      string        // SMTP_LISTEN, comma-separated, default 127.0.0.1:2525
	WorkerURL   string        // EMAIL_WORKER_URL, required (.../send)
	Token       string        // EMAIL_RELAY_TOKEN, required
	DefaultFrom string        // DEFAULT_FROM, used when the sender is off-domain
	FromDomain  string        // FROM_DOMAIN, the only domain the worker accepts
	HTTPTimeout time.Duration // HTTP_TIMEOUT_SECONDS, default 30
	MaxSize     int64         // MAX_MESSAGE_BYTES, default 25 MiB
}

func loadConfig() (Config, error) {
	c := Config{
		Listen:      env("SMTP_LISTEN", "127.0.0.1:2525"),
		WorkerURL:   os.Getenv("EMAIL_WORKER_URL"),
		Token:       os.Getenv("EMAIL_RELAY_TOKEN"),
		DefaultFrom: env("DEFAULT_FROM", "noreply@skyphusion.org"),
		FromDomain:  env("FROM_DOMAIN", "skyphusion.org"),
		HTTPTimeout: time.Duration(envInt("HTTP_TIMEOUT_SECONDS", 30)) * time.Second,
		MaxSize:     int64(envInt("MAX_MESSAGE_BYTES", 25*1024*1024)),
	}
	if c.WorkerURL == "" {
		return c, fmt.Errorf("EMAIL_WORKER_URL is required (e.g. https://skyphusion-email.<acct>.workers.dev/send)")
	}
	if c.Token == "" {
		return c, fmt.Errorf("EMAIL_RELAY_TOKEN is required (must match the worker's RELAY_TOKEN secret)")
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
