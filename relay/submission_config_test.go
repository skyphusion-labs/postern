package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseSubmissionListeners(t *testing.T) {
	tests := []struct {
		name    string
		spec    string
		want    []submissionListener
		wantErr bool
	}{
		{
			name: "canonical 587 starttls + 465 implicit",
			spec: "587:starttls,465:implicit",
			want: []submissionListener{{Addr: ":587", Implicit: false}, {Addr: ":465", Implicit: true}},
		},
		{
			name: "alternate port to dodge blocking",
			spec: "2525:starttls",
			want: []submissionListener{{Addr: ":2525", Implicit: false}},
		},
		{
			name: "host:port:mode",
			spec: "0.0.0.0:587:starttls,127.0.0.1:8025:implicit",
			want: []submissionListener{{Addr: "0.0.0.0:587", Implicit: false}, {Addr: "127.0.0.1:8025", Implicit: true}},
		},
		{
			name: "ipv6 bracketed host",
			spec: "[::1]:465:implicit",
			want: []submissionListener{{Addr: "[::1]:465", Implicit: true}},
		},
		{
			name: "tls is an alias for implicit; spaces trimmed",
			spec: " 465:tls , 587:starttls ",
			want: []submissionListener{{Addr: ":465", Implicit: true}, {Addr: ":587", Implicit: false}},
		},
		{name: "unknown mode", spec: "587:plain", wantErr: true},
		{name: "missing mode", spec: "587", wantErr: true},
		{name: "non-numeric bare addr", spec: "foo:starttls", wantErr: true},
		{name: "empty spec", spec: "   ", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSubmissionListeners(tt.spec)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSubmissionListeners(%q) = %#v, want error", tt.spec, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSubmissionListeners(%q): %v", tt.spec, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseSubmissionListeners(%q) = %#v, want %#v", tt.spec, got, tt.want)
			}
		})
	}
}

// setSubmissionBaseEnv configures the inbound destination + submission essentials
// so loadConfig reaches the submission validation branch under test.
func setSubmissionBaseEnv(t *testing.T) {
	t.Helper()
	t.Setenv("POSTERN_INGEST_URL", "https://core.example/ingest")
	t.Setenv("POSTERN_TRANSPORT_TOKEN", "transport-secret")
	t.Setenv("SUBMISSION_LISTENERS", "587:starttls")
	t.Setenv("SUBMISSION_TLS_CERT", "/tmp/cert.pem")
	t.Setenv("SUBMISSION_TLS_KEY", "/tmp/key.pem")
	t.Setenv("POSTERN_SEND_URL", "https://core.example/api/send")
	t.Setenv("POSTERN_SEND_TOKEN", "api-secret")
	t.Setenv("POSTERN_SMTP_AUTH_URL", "https://core.example/api/smtp-auth")
}

func TestLoadConfig_SubmissionValidation(t *testing.T) {
	t.Run("native happy path", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		if _, err := loadConfig(); err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
	})

	t.Run("missing cert is rejected", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		t.Setenv("SUBMISSION_TLS_CERT", "")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "TLS") {
			t.Fatalf("err = %v, want a TLS-required error", err)
		}
	})

	t.Run("native without auth url is rejected", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		t.Setenv("POSTERN_SMTP_AUTH_URL", "")
		if _, err := loadConfig(); err == nil {
			t.Fatal("want error for native backend without POSTERN_SMTP_AUTH_URL")
		}
	})

	t.Run("ldap without TLS is rejected", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		t.Setenv("AUTH_BACKEND", "ldap")
		t.Setenv("LDAP_URL", "ldap://dir.example:389")
		t.Setenv("LDAP_BIND_DN_TEMPLATE", "uid=%s,ou=people,dc=example,dc=com")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "TLS") {
			t.Fatalf("err = %v, want a TLS-required error for plaintext ldap", err)
		}
	})

	t.Run("ldaps is accepted", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		t.Setenv("AUTH_BACKEND", "ldap")
		t.Setenv("LDAP_URL", "ldaps://dir.example:636")
		t.Setenv("LDAP_BIND_DN_TEMPLATE", "uid=%s,ou=people,dc=example,dc=com")
		if _, err := loadConfig(); err != nil {
			t.Fatalf("loadConfig (ldaps): %v", err)
		}
	})

	t.Run("system without domain is rejected", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		t.Setenv("AUTH_BACKEND", "system")
		if _, err := loadConfig(); err == nil {
			t.Fatal("want error for system backend without AUTH_SYSTEM_DOMAIN")
		}
	})

	t.Run("unknown backend is rejected", func(t *testing.T) {
		setSubmissionBaseEnv(t)
		t.Setenv("AUTH_BACKEND", "kerberos")
		if _, err := loadConfig(); err == nil {
			t.Fatal("want error for an unknown AUTH_BACKEND")
		}
	})
}
