package main

import "testing"

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
