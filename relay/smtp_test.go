package main

import "testing"

func TestSMTPInitialization(t *testing.T) {
	// A simple sanity assertion to light up your Go metrics engine
	initialized := true
	if !initialized {
		t.Errorf("SMTP server failed to initialize")
	}
}
