package main

import (
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
	if d.nativeAdapterByName(first.name) != resumed {
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

// A declared name is the identity outright, so it must not collide with the
// record the same agent left behind under an older key — which is exactly the
// state every pod is in the first time it registers after this upgrade.
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

// A declared name IS the identity, so a second client declaring one already in
// use is the same agent reconnecting as far as the daemon can tell — a
// relaunch and a misconfigured second launcher are the same two frames. It
// takes the name over, and the adapter it displaces is disconnected rather
// than left registered and silently undeliverable.
func TestDeclaredNameTakesOverAndDisconnectsTheAdapterItDisplaces(t *testing.T) {
	d := herdrlessDaemon(t)
	path := serveHerdrlessAdapters(t, d)
	first := connectAdapter(t, path, "omp", "session-1", "clem")
	second := connectAdapter(t, path, "claude", "session-2", "clem")

	if second.name != "clem" {
		t.Fatalf("second registration = %q; want the declared name", second.name)
	}
	if _, err := first.reader.ReadBytes('\n'); err == nil {
		t.Fatal("the displaced adapter is still connected, so it would look alive and receive nothing")
	}
	adapter := d.nativeAdapterByName("clem")
	if adapter == nil || adapter.sessionID != "session-2" {
		t.Fatalf("clem routes to %#v; want the session that took the name", adapter)
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
