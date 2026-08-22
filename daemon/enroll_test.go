package main

import (
	"strings"
	"testing"
)

func TestResolveEnrollURLFlagBeatsEnvironment(t *testing.T) {
	t.Setenv("TRANSIT_URL", "https://from-environment.example")

	got, err := resolveEnrollURL("https://from-flag.example", true)
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://from-flag.example" {
		t.Fatalf("resolveEnrollURL() = %q, want flag value", got)
	}
}

func TestResolveEnrollURLEnvironmentBeatsDefault(t *testing.T) {
	t.Setenv("TRANSIT_URL", "https://self-hosted.example")

	got, err := resolveEnrollURL("", false)
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://self-hosted.example" {
		t.Fatalf("resolveEnrollURL() = %q, want environment value", got)
	}
}

func TestResolveEnrollURLDefaultsToHostedServer(t *testing.T) {
	t.Setenv("TRANSIT_URL", "")

	got, err := resolveEnrollURL("", false)
	if err != nil {
		t.Fatal(err)
	}
	if got != hostedTransitURL {
		t.Fatalf("resolveEnrollURL() = %q, want %q", got, hostedTransitURL)
	}
}

func TestResolveEnrollURLRejectsMalformedEnvironment(t *testing.T) {
	t.Setenv("TRANSIT_URL", "not a URL")

	_, err := resolveEnrollURL("", false)
	if err == nil || !strings.Contains(err.Error(), "TRANSIT_URL") {
		t.Fatalf("resolveEnrollURL() error = %v, want invalid TRANSIT_URL error", err)
	}
}
