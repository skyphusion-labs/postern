package main

import "testing"

func TestThrottleKeyMatchesWorkerTrim(t *testing.T) {
	// U+FEFF is stripped by the worker's trim, then the name is lower-cased.
	if got := canonicalThrottleKey("native", "\uFEFFAlice"); got != "alice" {
		t.Fatalf("native key = %q, want alice", got)
	}
	if got := canonicalThrottleKey("native", "  Alice@Example.ORG "); got != "alice@example.org" {
		t.Fatalf("native key = %q, want alice@example.org", got)
	}
}

func TestThrottleKeySystemUsesLocalPart(t *testing.T) {
	a := canonicalThrottleKey("system", "alice@a.example")
	b := canonicalThrottleKey("system", "Alice@b.example")
	c := canonicalThrottleKey("system", "\uFEFFalice@c.example")
	if a != "alice" || b != "alice" || c != "alice" {
		t.Fatalf("system keys = %q %q %q, want alice", a, b, c)
	}
}
