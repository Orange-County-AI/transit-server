package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// twoOrgDaemon is a daemon enrolled with two organizations. `acme` gets its
// own device token and its own spool; `default` keeps the data directory, as a
// single-organization box always has.
func twoOrgDaemon(t *testing.T) *Daemon {
	t.Helper()
	root := t.TempDir()
	t.Setenv("TRANSIT_DATA_DIR", root)
	if err := os.WriteFile(filepath.Join(root, "token-acme"), []byte("acme-device-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{
		URL: "https://transit.example", Host: "titan", DeliveryMode: "prefer",
		Enrollments: []Enrollment{
			{ID: defaultEnrollment, URL: "https://transit.example", Host: "titan"},
			{ID: "acme", URL: "https://acme.example", Host: "titan-acme"},
		},
	}
	return newDaemon(cfg, "default-device-token", store, newHerdrSocket("/nonexistent/herdr.sock", nil))
}

// One name, two organizations, two different agents. A flat name map handed
// one organization's delivery to the other's agent.
func TestSameNameInTwoOrganizationsDoesNotCross(t *testing.T) {
	d := twoOrgDaemon(t)
	first := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "s1", Name: "clem"})
	second := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "s2", Name: "clem", Enrollment: "acme",
	})

	if first == second {
		t.Fatal("both registrations resolved to one adapter")
	}
	if got := d.nativeAdapterByName(defaultEnrollment, "clem"); got != first {
		t.Fatalf("default clem resolved to %#v", got)
	}
	if got := d.nativeAdapterByName("acme", "clem"); got != second {
		t.Fatalf("acme clem resolved to %#v", got)
	}
	if first.token == second.token {
		t.Fatal("the two identities share a credential")
	}
}

// A token issued in one organization must not resolve an identity in another,
// however the client labels its registration.
func TestATokenDoesNotCrossOrganizations(t *testing.T) {
	d := twoOrgDaemon(t)
	first := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "s1"})

	crossed := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "s2", AgentToken: first.token, Enrollment: "acme",
	})
	if crossed.anchor != "session" {
		t.Fatalf("anchor = %q; a foreign token must not resolve an identity", crossed.anchor)
	}
	if crossed.name == first.name {
		t.Fatalf("name = %q; the other organization's identity was adopted", crossed.name)
	}
}

// An enrollment the config does not define is a configuration error, not a
// silent fallback to whichever organization happens to be first.
func TestRegistrationRefusesAnUnknownEnrollment(t *testing.T) {
	d := twoOrgDaemon(t)
	_, code, _ := d.registerAgentAdapter(agentFrame{
		Harness: "omp", SessionID: "s1", Enrollment: "nowhere",
	}, 0, 0, nil)
	if code != "unknown_enrollment" {
		t.Fatalf("register = %q; want unknown_enrollment", code)
	}
}

// Each organization publishes its own roster. Herdr panes carry no
// organization, so they belong to the one the box enrolled with.
func TestRosterIsPartitionedByOrganization(t *testing.T) {
	d := twoOrgDaemon(t)
	registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "s1", Name: "here"})
	registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "s2", Name: "there", Enrollment: "acme",
	})
	d.mu.Lock()
	d.herdrAgents = []HerdrAgent{{Name: "paned", Kind: "omp", PaneID: "p1"}}
	d.mu.Unlock()

	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	if names := rosterNames(d.roster[defaultEnrollment]); names != "here,paned" {
		t.Fatalf("default roster = %q; want the default adapter and last healthy Herdr pane", names)
	}
	if names := rosterNames(d.roster["acme"]); names != "there" {
		t.Fatalf("acme roster = %q; want the acme adapter alone", names)
	}
}

func rosterNames(agents []WireAgent) string {
	joined := ""
	for _, agent := range agents {
		if joined != "" {
			joined += ","
		}
		joined += agent.Name
	}
	return joined
}

// A spool is per organization: a message queued for one must never be flushed
// over the other's socket, which sharing one directory would allow.
func TestSpoolsArePartitionedByOrganization(t *testing.T) {
	d := twoOrgDaemon(t)
	acme := d.enrollment("acme")
	if acme.store == nil {
		t.Fatal("the acme enrollment has no spool; its token was not read")
	}
	if acme.store.root == d.store.root {
		t.Fatalf("both organizations share the spool at %s", acme.store.root)
	}

	if err := acme.store.Enqueue(&OutboxMessage{ID: txID(), From: "a@titan-acme", To: "b@titan-acme", Body: "hi"}); err != nil {
		t.Fatal(err)
	}
	defaultOutbox, _, err := d.store.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if defaultOutbox != 0 {
		t.Fatalf("default outbox holds %d messages queued for another organization", defaultOutbox)
	}
}

// A single-organization config keeps the exact spool and token path it has
// today. Anything else silently strands a running daemon's queue on upgrade.
func TestASingleOrganizationConfigKeepsItsExistingPaths(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TRANSIT_DATA_DIR", root)
	cfg := &Config{URL: "https://transit.example", Host: "titan"}
	if err := normaliseEnrollments(cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Enrollments) != 1 || cfg.Enrollments[0].ID != defaultEnrollment {
		t.Fatalf("enrollments = %#v; want one synthesised default", cfg.Enrollments)
	}
	if got := cfg.Enrollments[0].storeRoot(); got != root {
		t.Fatalf("store root = %q, want the data directory %q", got, root)
	}
	if got := cfg.Enrollments[0].tokenFile(); got != "token" {
		t.Fatalf("token file = %q, want the historical `token`", got)
	}
}
