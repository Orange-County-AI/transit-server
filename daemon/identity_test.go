package main

import (
	"context"
	"testing"
)

// OMP mints a fresh session id on every `--resume`, and the identity key used
// to be harness plus session id, so a resumed agent came back as a stranger
// with a new auto-name. The token the daemon hands out is what carries the
// identity across that gap.
func TestRegistrationKeepsItsNameAcrossANewSessionID(t *testing.T) {
	d := herdrlessDaemon(t)
	first := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1"})
	if first.token == "" {
		t.Fatal("registration issued no identity token, so nothing can be re-presented")
	}
	if first.anchor != "session" {
		t.Fatalf("anchor = %q; a registration with nothing but a session id is session-anchored", first.anchor)
	}

	resumed := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-2", AgentToken: first.token,
	})
	if resumed.name != first.name {
		t.Fatalf("resumed name = %q, want %q; the address did not survive the resume", resumed.name, first.name)
	}
	if resumed.anchor != "token" {
		t.Fatalf("anchor = %q; the identity was recovered from the token", resumed.anchor)
	}
	if resumed.generation <= first.generation {
		t.Fatalf("generation %d did not advance past %d", resumed.generation, first.generation)
	}
	if resumed.token != first.token {
		t.Fatal("the token rotated, so the next resume would lose the identity again")
	}
	if d.nativeAdapterByName(defaultEnrollment, first.name) != resumed {
		t.Fatal("the name still routes to the old adapter")
	}
}

// A harness the client reports wrongly must not change who it is. Before this
// the harness was half the key, so a mislabelled client became a new agent.
func TestIdentityIgnoresTheHarnessString(t *testing.T) {
	d := herdrlessDaemon(t)
	first := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1"})
	again := registerAdapterDirect(t, d, agentFrame{Harness: "claude", SessionID: "session-1"})
	if again.name != first.name {
		t.Fatalf("name = %q, want %q; the harness string moved the identity", again.name, first.name)
	}
	if again.harness != "claude" {
		t.Fatalf("harness = %q; the reported harness is still recorded as a label", again.harness)
	}
}

// A Herdr-named adapter follows the pane it occupies. Before this reconciliation
// a pane rename updated Herdr while Transit kept routing and authorizing the old
// generated name, leaving the agent able to receive but unable to send.
func TestRefreshRosterRekeysHerdrNamedAdapterAfterPaneRename(t *testing.T) {
	var prompts int
	agents := []HerdrAgent{{Name: "claude-old", Kind: "claude", PaneID: "pane-1", Status: "idle"}}
	d, _ := newAdapterTestDaemon(t, "prefer", agents, &prompts)
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	adapter := registerAdapterDirect(t, d, agentFrame{
		Harness: "claude", SessionID: "session-1", PaneID: "pane-1",
	})
	if adapter.name != "claude-old" || adapter.namedBy != "herdr" {
		t.Fatalf("initial adapter = %q/%q; want the Herdr pane name", adapter.name, adapter.namedBy)
	}

	agents[0].Name = "main"
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	if adapter.name != "main" || adapter.namedBy != "herdr" {
		t.Fatalf("renamed adapter = %q/%q; want main/herdr", adapter.name, adapter.namedBy)
	}
	if d.nativeAdapterByName(defaultEnrollment, "claude-old") != nil {
		t.Fatal("the stale generated name still routes to the adapter")
	}
	if d.nativeAdapterByName(defaultEnrollment, "main") != adapter {
		t.Fatal("the current pane name does not route to the adapter")
	}
	if record := d.nativeNames[adapter.key]; record.Name != "main" || record.NamedBy != "herdr" {
		t.Fatalf("persisted name = %#v; want main/herdr", record)
	}
}

func TestRefreshRosterDoesNotOverrideExplicitTransitName(t *testing.T) {
	var prompts int
	agents := []HerdrAgent{{Name: "pane-name", Kind: "omp", PaneID: "pane-1", Status: "idle"}}
	d, _ := newAdapterTestDaemon(t, "prefer", agents, &prompts)
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	adapter := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", PaneID: "pane-1", Name: "declared-name",
	})

	agents[0].Name = "renamed-pane"
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	if adapter.name != "declared-name" || adapter.namedBy != "user" {
		t.Fatalf("adapter = %q/%q; an explicit Transit name must outrank the Herdr pane", adapter.name, adapter.namedBy)
	}
}

// A declared name may absorb a stale record from the same pre-token identity.
func TestDeclaredNameAdoptsAStaleRecordInsteadOfRefusing(t *testing.T) {
	d := herdrlessDaemon(t)
	d.nativeNames["omp:pre-upgrade-session"] = nativeName{Name: "clem", NamedBy: "user", Generation: 24}

	adapter := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", Name: "clem",
	})
	if adapter.name != "clem" || adapter.anchor != "name" {
		t.Fatalf("adapter = %q/%q; want the declared name, name-anchored", adapter.name, adapter.anchor)
	}
	if adapter.generation != 25 {
		t.Fatalf("generation = %d; want the stale record's 24 carried forward", adapter.generation)
	}
	if _, stale := d.nativeNames["omp:pre-upgrade-session"]; stale {
		t.Fatal("the superseded record was left behind, so the name stays double-claimed")
	}
}

func TestDeclaredNameDoesNotDisplaceAnotherLivePane(t *testing.T) {
	var prompts int
	agents := []HerdrAgent{
		{Name: "stub", Kind: "omp", PaneID: "pane-1"},
		{Name: "status-overlay", Kind: "omp", PaneID: "pane-4"},
	}
	d, _ := newAdapterTestDaemon(t, "prefer", agents, &prompts)
	setAdapterTestHerdrAgents(d, agents)
	first := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", PaneID: "pane-1", Name: "stub",
	})
	helper := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-2", PaneID: "pane-4", Name: "stub",
	})

	if helper.name != "status-overlay" || helper.anchor != "session" {
		t.Fatalf("helper = %q/%q; want its pane identity, not the inherited configured name", helper.name, helper.anchor)
	}
	if d.nativeAdapterByName(defaultEnrollment, "stub") != first {
		t.Fatal("the helper displaced the live stub adapter")
	}
}

func TestConfiguredNameDoesNotOverrideAValidIdentityToken(t *testing.T) {
	d := herdrlessDaemon(t)
	stub := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "stub-session", Name: "stub",
	})
	helper := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "helper-session",
	})
	if _, err := d.claimNativeAdapterName(helper, "status-overlay"); err != nil {
		t.Fatal(err)
	}

	resumed := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "helper-resumed", Name: "stub", AgentToken: helper.token,
	})
	if resumed.name != "status-overlay" || resumed.anchor != "token" {
		t.Fatalf("resumed helper = %q/%q; want token-owned status-overlay identity", resumed.name, resumed.anchor)
	}
	if d.nativeAdapterByName(defaultEnrollment, "stub") != stub {
		t.Fatal("the resumed helper displaced stub despite presenting its own token")
	}
}

// The token index has to survive a daemon restart, or every agent falls back
// to its session id on the first reconnect after one.
func TestIdentityTokensSurviveADaemonRestart(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{URL: "https://transit.example", Host: "titan", DeliveryMode: "prefer"}
	first := newDaemon(cfg, "token", store, newHerdrSocket("/nonexistent/herdr.sock", nil))
	adapter := registerAdapterDirect(t, first, agentFrame{Harness: "omp", SessionID: "session-1"})

	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	restarted := newDaemon(cfg, "token", reopened, newHerdrSocket("/nonexistent/herdr.sock", nil))
	recovered := registerAdapterDirect(t, restarted, agentFrame{
		Harness: "omp", SessionID: "session-9", AgentToken: adapter.token,
	})
	if recovered.name != adapter.name || recovered.anchor != "token" {
		t.Fatalf("recovered = %q/%q, want %q recovered from the token", recovered.name, recovered.anchor, adapter.name)
	}
}

// A token nobody issued is not an identity; it must fall through to the
// session id rather than being trusted or refused.
func TestUnknownTokenFallsBackToTheSessionAnchor(t *testing.T) {
	d := herdrlessDaemon(t)
	adapter := registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", AgentToken: "0123456789abcdef0123456789abcdef",
	})
	if adapter.anchor != "session" {
		t.Fatalf("anchor = %q; an unissued token must not resolve an identity", adapter.anchor)
	}
	if adapter.token == "0123456789abcdef0123456789abcdef" {
		t.Fatal("the daemon adopted a token it never issued")
	}
}
