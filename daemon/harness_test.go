package main

import (
	"testing"
)

// The harness allowlist meant a client this build had never heard of could not
// register at all, so every new harness needed a daemon release before it
// could receive anything.
func TestRegistrationAcceptsAnUnknownHarness(t *testing.T) {
	d := herdrlessDaemon(t)
	adapter := registerAdapterDirect(t, d, agentFrame{
		Harness: "acme-cli", SessionID: "s1", Name: "acme", Status: "idle",
	})
	if adapter.harness != "acme-cli" {
		t.Fatalf("harness = %q; want the value the client declared", adapter.harness)
	}
	if d.nativeAdapterByName(defaultEnrollment, "acme") != adapter {
		t.Fatal("an unknown harness registered but is not routable by name")
	}
}

// The shape is still checked: the value is printed in `status`, compared in
// the roster, and read back out of a persisted record.
func TestRegistrationRejectsAMalformedHarness(t *testing.T) {
	for _, harness := range []string{"", "ACME CLI", "acme cli", "1acme", "-acme", "acme_cli"} {
		d := herdrlessDaemon(t)
		_, code, _ := d.registerAgentAdapter(agentFrame{
			Harness: harness, SessionID: "s1", Name: "acme",
		}, 0, 0, nil)
		if code != "unsupported_harness" {
			t.Fatalf("register harness %q = %q; want unsupported_harness", harness, code)
		}
	}
}

// An unrecognized harness has no composer parser, and the guard's contract for
// "cannot tell" is to deliver. Turning an unknown harness into a hold would
// stall every delivery to a client we have not taught the daemon to read.
func TestComposerDetectionFailsOpenForAnUnknownHarness(t *testing.T) {
	screen := readScreenFixture(t, "omp-draft.txt")
	if state := DetectComposer("acme-cli", screen); state != ComposerUnknown {
		t.Fatalf("DetectComposer(acme-cli) = %v; want ComposerUnknown", state)
	}
}
