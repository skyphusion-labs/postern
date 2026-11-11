package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
	"time"
)

type infraAuth struct{}

func (infraAuth) Authenticate(username, secret string) (string, error) {
	return "", errSentinel("backend down")
}

type errSentinel string

func (e errSentinel) Error() string { return string(e) }

func TestInfraErrorDoesNotLogTheUsername(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	th := newAuthThrottle(ThrottleCfg{Enabled: true, MaxFailures: 5, Lockout: time.Minute, MaxLockout: time.Minute}, nil)
	s := &submissionSession{
		cfg:      Config{},
		auth:     infraAuth{},
		throttle: th,
	}
	secretName := "typed-as-the-username"
	if err := s.authenticate(secretName, "pw"); err == nil {
		t.Fatal("expected auth to fail")
	}
	if strings.Contains(buf.String(), secretName) {
		t.Fatal("backend error log included the username")
	}
}

func TestGlobalThrottleDefaultsOff(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Submission.Throttle.GlobalMax != 0 {
		t.Fatalf("global max = %d, want 0", cfg.Submission.Throttle.GlobalMax)
	}
}
