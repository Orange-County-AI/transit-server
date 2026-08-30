package main

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

// herdrlessDaemon is a daemon whose Herdr socket does not exist, which is the
// shape of a box that runs only harnesses with native adapters.
func herdrlessDaemon(t *testing.T) *Daemon {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return newDaemon(
		&Config{URL: "https://transit.example", Host: "titan", DeliveryMode: "prefer"},
		"token", store, newHerdrSocket("/nonexistent/herdr.sock", nil),
	)
}

// serveHerdrlessAdapters exposes the daemon's agent socket so an adapter can
// register and answer over it, as a live extension does.
func serveHerdrlessAdapters(t *testing.T, d *Daemon) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.sock")
	listener, err := listenAgentSocket(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		_ = listener.Close()
	})
	go func() { _ = serveAgentSocket(ctx, listener, d) }()
	return path
}

// A Herdr outage used to abort the whole refresh, which took the natively
// registered adapters off the published roster along with the panes.
func TestRefreshRosterPublishesAdaptersWithoutHerdr(t *testing.T) {
	d := herdrlessDaemon(t)
	registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", Name: "solo", Status: "idle",
	})

	changed, err := d.refreshRoster(context.Background())
	if err != nil {
		t.Fatalf("refreshRoster = %v; an absent herdr must not fail the refresh", err)
	}
	if !changed {
		t.Fatal("roster did not change; the adapter was never published")
	}
	if d.herdrReachable() {
		t.Fatal("herdr reported reachable through a socket that does not exist")
	}
	d.mu.RLock()
	roster := append([]WireAgent(nil), d.roster[defaultEnrollment]...)
	d.mu.RUnlock()
	if len(roster) != 1 || roster[0].Name != "solo" {
		t.Fatalf("roster = %#v; want the native adapter alone", roster)
	}
}

// A transient Herdr timeout is not an empty roster. Publishing adapters alone
// during that timeout tells the Worker every pane departed, strands their mail,
// and turns a healthy remote host into list_agents=[] until the next refresh.
func TestRefreshRosterRetainsLastHealthyHerdrAgentsDuringOutage(t *testing.T) {
	agent := HerdrAgent{Name: "alice", Kind: "claude", PaneID: "pane-1", Status: "idle"}
	var mu sync.Mutex
	available, present := true, true
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			mu.Lock()
			defer mu.Unlock()
			if !available {
				return nil, &HerdrAPIError{Code: "timeout", Message: "temporary timeout"}
			}
			agents := []HerdrAgent{}
			if present {
				agents = append(agents, agent)
			}
			return map[string]any{"type": "agent_list", "agents": agents}, nil
		default:
			return nil, &HerdrAPIError{Code: "unexpected", Message: request.Method}
		}
	})
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d := newDaemon(
		&Config{URL: "https://transit.example", Host: "titan", DeliveryMode: "prefer"},
		"token", store, newHerdrSocket(path, nil),
	)
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	available = false
	mu.Unlock()

	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatalf("refresh during a transient outage = %v", err)
	}
	if d.herdrReachable() {
		t.Fatal("Herdr remained available after agent.list timed out")
	}
	d.mu.RLock()
	roster := append([]WireAgent(nil), d.roster[defaultEnrollment]...)
	d.mu.RUnlock()
	if len(roster) != 1 || roster[0].Name != agent.Name {
		t.Fatalf("roster = %#v; want the last healthy Herdr snapshot", roster)
	}

	mu.Lock()
	available, present = true, false
	mu.Unlock()
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !d.herdrReachable() {
		t.Fatal("Herdr did not recover after agent.list succeeded")
	}
	d.mu.RLock()
	roster = append([]WireAgent(nil), d.roster[defaultEnrollment]...)
	d.mu.RUnlock()
	if len(roster) != 0 {
		t.Fatalf("recovered empty roster = %#v; a real departure must publish after Herdr recovers", roster)
	}
}

// An empty roster reads as `agent_not_found`, which blames the agent for a
// transport outage. The two failures clear differently and must not share a
// code.
func TestDeliverReportsHerdrUnavailableRatherThanAgentNotFound(t *testing.T) {
	d := herdrlessDaemon(t)
	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}

	code, retryable, err := d.deliverOnce(context.Background(), d.defaultEnrollmentRuntime(), WireFrame{
		ID: "tx_herdrless01", Agent: "pane-only", Envelope: "<transit id=\"tx_herdrless01\"/>",
	})
	if code != "herdr_unavailable" || !retryable || err == nil {
		t.Fatalf("deliverOnce = %q, %v, %v; want a retryable herdr_unavailable", code, retryable, err)
	}
}

// The native path does not touch Herdr, so an adapter must still receive while
// Herdr is down — that is the entire point of making it optional.
func TestNativeDeliveryWorksWithoutHerdr(t *testing.T) {
	d := herdrlessDaemon(t)
	client := connectAdapter(t, serveHerdrlessAdapters(t, d), "omp", "session-1", "solo")

	result := make(chan error, 1)
	go func() {
		code, retryable, err := d.deliver(context.Background(), d.defaultEnrollmentRuntime(), WireFrame{
			ID: "tx_herdrless02", Agent: client.name, Envelope: "<transit id=\"tx_herdrless02\"/>",
		})
		if code != "" || retryable {
			result <- fmt.Errorf("deliver = %q, %t, %v; want a native delivery with herdr down", code, retryable, err)
			return
		}
		result <- err
	}()
	deliver := client.read(t)
	if deliver.T != "deliver" || deliver.ID != "tx_herdrless02" {
		t.Fatalf("deliver frame = %#v", deliver)
	}
	client.send(t, agentFrame{T: "deliver_ack", ID: deliver.ID, Persisted: true})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if !d.store.IncomingRecorded("tx_herdrless02") {
		t.Fatal("a native delivery made with herdr down was not archived")
	}
}
