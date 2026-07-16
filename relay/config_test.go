package main

import (
	"strings"
	"testing"
)

// clearRelayEnv unsets every variable loadConfig reads so each case starts clean.
func clearRelayEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"SMTP_LISTEN", "MAX_MESSAGE_BYTES",
		"POSTERN_INGEST_URL", "POSTERN_TRANSPORT_TOKEN",
		"EMAIL_WORKER_URL", "EMAIL_RELAY_TOKEN",
		"DEFAULT_FROM", "FROM_DOMAIN",
		"POSTERN_RELAY_HTTP_LISTEN", "POSTERN_OUTBOUND_FROM",
		"SMTP_OUT_HOST", "SMTP_OUT_PORT", "SMTP_OUT_USERNAME",
		"SMTP_OUT_PASSWORD", "SMTP_OUT_STARTTLS", "SMTP_OUT_TIMEOUT_SECONDS",
		"HTTP_TIMEOUT_SECONDS",
		"SUBMISSION_LISTENERS", "SUBMISSION_TLS_CERT", "SUBMISSION_TLS_KEY",
		"SUBMISSION_HOSTNAME", "AUTH_BACKEND",
		"POSTERN_SEND_URL", "POSTERN_SEND_TOKEN", "POSTERN_SMTP_AUTH_URL",
	} {
		t.Setenv(k, "") // t.Setenv restores the prior value at test end
	}
}

func TestLoadConfig_IngestMode(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.inboundMode() != "ingest" {
		t.Errorf("inboundMode = %q, want ingest", cfg.inboundMode())
	}
}

func TestLoadConfig_IngestRequiresTransportToken(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	// no POSTERN_TRANSPORT_TOKEN
	if _, err := loadConfig(); err == nil {
		t.Error("expected error when ingest URL set without transport token")
	}
}

func TestLoadConfig_LegacyMode(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("EMAIL_WORKER_URL", "https://worker.example/send")
	t.Setenv("EMAIL_RELAY_TOKEN", "tok")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.inboundMode() != "legacy-send" {
		t.Errorf("inboundMode = %q, want legacy-send", cfg.inboundMode())
	}
}

func TestLoadConfig_NoInboundDestinationFails(t *testing.T) {
	clearRelayEnv(t)
	if _, err := loadConfig(); err == nil {
		t.Error("expected error when neither ingest nor worker URL is set")
	}
}

func TestLoadConfig_DispatchBridgeNeedsTokenAndHost(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")
	t.Setenv("POSTERN_RELAY_HTTP_LISTEN", "127.0.0.1:2526")
	// SMTP_OUT_HOST missing -> error
	if _, err := loadConfig(); err == nil {
		t.Error("expected error when dispatch bridge enabled without SMTP_OUT_HOST")
	}

	t.Setenv("SMTP_OUT_HOST", "smtp.example.com")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig with host: %v", err)
	}
	if cfg.SMTPOut.Port != 587 {
		t.Errorf("default SMTP_OUT_PORT = %d, want 587", cfg.SMTPOut.Port)
	}
	if !cfg.SMTPOut.StartTLS {
		t.Error("SMTP_OUT_STARTTLS should default to true")
	}
}

func TestEnvBool(t *testing.T) {
	cases := map[string]bool{
		"1": true, "true": true, "yes": true, "on": true, "TRUE": true,
		"0": false, "false": false, "no": false, "off": false,
	}
	for in, want := range cases {
		t.Setenv("POSTERN_TEST_BOOL", in)
		if got := envBool("POSTERN_TEST_BOOL", !want); got != want {
			t.Errorf("envBool(%q) = %v, want %v", in, got, want)
		}
	}
	t.Setenv("POSTERN_TEST_BOOL", "")
	if !envBool("POSTERN_TEST_BOOL", true) {
		t.Error("envBool empty should return default")
	}
	t.Setenv("POSTERN_TEST_BOOL", "garbage")
	if !envBool("POSTERN_TEST_BOOL", true) {
		t.Error("envBool garbage should return default")
	}
}

// setSubmissionOnlyEnv configures a submission-only deploy: the submission seam is
// fully set, and NO inbound destination (POSTERN_INGEST_URL / EMAIL_WORKER_URL) is
// configured. This is the #93 attack-surface-reduction shape: bind 587 only, no
// vestigial inbound intake port.
func setSubmissionOnlyEnv(t *testing.T) {
	t.Helper()
	clearRelayEnv(t)
	t.Setenv("SUBMISSION_LISTENERS", "587:starttls")
	t.Setenv("SUBMISSION_TLS_CERT", "/tmp/cert.pem")
	t.Setenv("SUBMISSION_TLS_KEY", "/tmp/key.pem")
	t.Setenv("POSTERN_SEND_URL", "https://core.example/api/send")
	t.Setenv("POSTERN_SEND_TOKEN", "api-secret")
	// native backend needs an auth URL + transport token, but the transport token
	// here gates ONLY the per-user /api/smtp-auth check; it is NOT an inbound
	// destination, so inbound stays inactive.
	t.Setenv("POSTERN_SMTP_AUTH_URL", "https://core.example/api/smtp-auth")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "transport-secret")
}

func TestLoadConfig_SubmissionOnlyLoadsClean(t *testing.T) {
	setSubmissionOnlyEnv(t)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("submission-only loadConfig: %v", err)
	}
	if cfg.inboundActive() {
		t.Error("inboundActive() = true for a submission-only deploy, want false")
	}
}

// TestRun_SubmissionOnlyBindsNoIntake asserts the #93 core property at the binding
// seam: a submission-only config yields ZERO inbound intake addresses, so run()
// binds no intake port. inboundIntakeAddrs is the pure decision run() uses, so this
// tests the real binding logic without standing up live listeners.
func TestRun_SubmissionOnlyBindsNoIntake(t *testing.T) {
	setSubmissionOnlyEnv(t)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("submission-only loadConfig: %v", err)
	}
	if addrs := inboundIntakeAddrs(cfg); len(addrs) != 0 {
		t.Errorf("inboundIntakeAddrs = %v, want none (submission-only binds no intake)", addrs)
	}
}

// TestInboundIntakeAddrs_ActiveBindsDefault is the converse: when an inbound
// destination IS configured, the default SMTP_LISTEN is bound.
func TestInboundIntakeAddrs_ActiveBindsDefault(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	addrs := inboundIntakeAddrs(cfg)
	if len(addrs) != 1 || addrs[0] != "127.0.0.1:2525" {
		t.Errorf("inboundIntakeAddrs = %v, want [127.0.0.1:2525]", addrs)
	}
}

// TestLoadConfig_NothingToDo covers the no-inbound + no-submission + no-dispatch
// case: loadConfig must reject it with the "nothing to do" guard rather than start
// a daemon that serves nothing.
func TestLoadConfig_NothingToDo(t *testing.T) {
	clearRelayEnv(t)
	_, err := loadConfig()
	if err == nil {
		t.Fatal("expected the nothing-to-do error when no seam is configured")
	}
	if !strings.Contains(err.Error(), "nothing to do") {
		t.Errorf("err = %v, want a \"nothing to do\" error", err)
	}
}

// TestRun_NothingToDo asserts run() carries the same guard (it is also driven
// directly from tests, not only via loadConfig).
func TestRun_NothingToDo(t *testing.T) {
	clearRelayEnv(t)
	// Build a config by hand (loadConfig would reject this), inbound inactive,
	// submission disabled, dispatch disabled.
	cfg := Config{Listen: "127.0.0.1:2525"}
	err := run(cfg)
	if err == nil || !strings.Contains(err.Error(), "nothing to do") {
		t.Fatalf("run() err = %v, want a nothing-to-do error", err)
	}
}

// TestIntakeAddrIsLoopback covers the F4 loopback classifier directly: only
// addresses that bind a loopback interface (or the conventional localhost name) are
// loopback; wildcard binds, 0.0.0.0, public IPs, and unresolvable hostnames are not.
func TestIntakeAddrIsLoopback(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:2525", true},
		{"127.0.0.5:2525", true}, // all of 127.0.0.0/8 is loopback
		{"[::1]:2525", true},
		{"localhost:2525", true},
		{"LocalHost:2525", true}, // case-insensitive
		{":2525", false},         // wildcard bind, every interface
		{"0.0.0.0:2525", false},
		{"[::]:2525", false},
		{"192.0.2.10:2525", false}, // a real interface
		{"smtp.example.com:2525", false},
	}
	for _, tc := range cases {
		got, err := intakeAddrIsLoopback(tc.addr)
		if err != nil {
			t.Errorf("intakeAddrIsLoopback(%q): unexpected error %v", tc.addr, err)
			continue
		}
		if got != tc.want {
			t.Errorf("intakeAddrIsLoopback(%q) = %v, want %v", tc.addr, got, tc.want)
		}
	}
}

// TestCheckIntakeLoopback_RejectsNonLoopback asserts the enforced invariant: a
// non-loopback intake bind is refused with a clear error; a malformed address is
// also refused.
func TestCheckIntakeLoopback_RejectsNonLoopback(t *testing.T) {
	if err := checkIntakeLoopback([]string{"127.0.0.1:2525", "[::1]:2525"}); err != nil {
		t.Fatalf("loopback-only set rejected: %v", err)
	}
	err := checkIntakeLoopback([]string{"127.0.0.1:2525", "0.0.0.0:2525"})
	if err == nil || !strings.Contains(err.Error(), "loopback only") {
		t.Fatalf("err = %v, want a loopback-only rejection for a public bind", err)
	}
	if err := checkIntakeLoopback([]string{"not-a-host-port"}); err == nil {
		t.Fatal("want an error for a malformed intake address")
	}
}

// TestRun_RejectsNonLoopbackIntake drives the real binding path: an inbound-active
// config whose SMTP_LISTEN binds a public interface must make run() refuse to start.
func TestRun_RejectsNonLoopbackIntake(t *testing.T) {
	clearRelayEnv(t)
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "tok")
	t.Setenv("SMTP_LISTEN", "0.0.0.0:2525")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	err = run(cfg)
	if err == nil || !strings.Contains(err.Error(), "loopback only") {
		t.Fatalf("run() err = %v, want a loopback-only rejection", err)
	}
}
