package main

import (
	"context"
	"fmt"
	"net"
	"os"
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

// registerLiveAdapter registers the way a real client does, with this process's
// true start time, so `nativeAdapterForProcess` can resolve it from a pid the
// way an MCP call does.
func registerLiveAdapter(t *testing.T, d *Daemon, frame agentFrame) *agentAdapter {
	t.Helper()
	start, err := processStartTime(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	t.Cleanup(func() {
		_ = server.Close()
		_ = client.Close()
	})
	adapter, code, message := d.registerAgentAdapter(frame, os.Getpid(), start, server)
	if code != "" {
		t.Fatalf("register = %q, %q", code, message)
	}
	return adapter
}

// Identity is the piece that used to look like a Herdr dependency: the roster
// is built from pane listings, so a box without them appeared to have no
// agents. A native adapter is the other registry, and it must be able to name
// itself, answer `whoami` and re-claim a name with the socket gone.
func TestIdentityIsEstablishedWithoutHerdr(t *testing.T) {
	d := herdrlessDaemon(t)
	adapter := registerLiveAdapter(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", Name: "solo", Status: "idle",
	})
	if adapter.name != "solo" {
		t.Fatalf("registered name = %q; a declared name is authority without Herdr", adapter.name)
	}

	who := d.whoamiResponse(map[string]any{"pid": os.Getpid()})
	if ok, _ := who["ok"].(bool); !ok {
		t.Fatalf("whoami = %#v; a native caller resolves from its pid, not a pane", who)
	}
	if address, _ := who["address"].(string); address != "solo@titan" {
		t.Fatalf("address = %q, want solo@titan", address)
	}

	claimed := d.handleIPC(context.Background(), map[string]any{
		"op": "claim_name", "name": "scout", "pid": os.Getpid(),
	})
	if ok, _ := claimed["ok"].(bool); !ok {
		t.Fatalf("claim_name = %#v; claiming a name needs nothing from Herdr", claimed)
	}
	if address, _ := claimed["address"].(string); address != "scout@titan" {
		t.Fatalf("claimed address = %q, want scout@titan", address)
	}
	if d.nativeAdapterByName(defaultEnrollment, "scout") != adapter {
		t.Fatal("the claimed name does not route to the adapter that claimed it")
	}
}

// A pane rename used to be fatal to a native claim. Herdr dying between the
// last roster refresh and the call — cached pane still there, socket gone —
// then failed a claim that needs nothing from Herdr to succeed.
func TestClaimNameSurvivesAFailedPaneRename(t *testing.T) {
	d := herdrlessDaemon(t)
	adapter := registerLiveAdapter(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", Name: "solo", Status: "idle",
	})
	// The roster snapshot Herdr left behind before it died.
	setAdapterTestHerdrAgents(d, []HerdrAgent{
		{Name: "solo", Kind: "omp", PaneID: "pane-1", Status: "idle"},
	})

	claimed := d.handleIPC(context.Background(), map[string]any{
		"op": "claim_name", "name": "scout", "pid": os.Getpid(), "pane_id": "pane-1",
	})
	if ok, _ := claimed["ok"].(bool); !ok {
		t.Fatalf("claim_name = %#v; a dead Herdr must not fail a native claim", claimed)
	}
	if adapter.name != "scout" {
		t.Fatalf("adapter name = %q; the native registry did not take the claim", adapter.name)
	}
}

// The auto-name ledger records which names the daemon invented. It used to be
// pruned against the pane list, and an outage produces an empty one — so a
// Herdr restart silently promoted every invented name to `user`, which inverts
// the rule that a placeholder yields to the pane it sits beside.
func TestAutoNameLedgerSurvivesAHerdrOutage(t *testing.T) {
	d := herdrlessDaemon(t)
	if err := d.saveAutoNames(map[string]string{"pane-1": "omp-abcd"}); err != nil {
		t.Fatal(err)
	}

	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}

	names := d.loadAutoNames()
	if names["pane-1"] != "omp-abcd" {
		t.Fatalf("auto names = %#v; an outage erased provenance it could not verify", names)
	}
}

// The roster, rooms and inbox reads all reach the Worker over the wire. None
// of them may consult Herdr on the way, so an offline daemon must fail with
// "offline" rather than anything Herdr-shaped.
func TestPullRPCsDoNotConsultHerdr(t *testing.T) {
	d := herdrlessDaemon(t)
	registerLiveAdapter(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", Name: "solo", Status: "idle",
	})

	for _, method := range []string{"read_inbox", "read_room", "list_agents", "list_rooms"} {
		response := d.rpcResponse(context.Background(), map[string]any{
			"method": method, "pid": os.Getpid(),
			"params": map[string]any{"room": "standup"},
		})
		if ok, _ := response["ok"].(bool); ok {
			t.Fatalf("%s succeeded with no Worker connection", method)
		}
		if code, _ := response["code"].(string); code != "rpc_failed" {
			t.Fatalf("%s = %#v; want the offline failure, not a Herdr one", method, response)
		}
	}
}

// `as_agent` is the operator's caller: a person at a terminal has no adapter
// and no pane, so without it there is no way to read an agent's queue from the
// box the agent runs on. It must resolve a caller that `callerAgent` cannot.
func TestOperatorCallerResolvesWithoutASession(t *testing.T) {
	d := herdrlessDaemon(t)
	response := d.rpcResponse(context.Background(), map[string]any{
		"method": "read_inbox", "as_agent": "solo", "params": map[string]any{},
	})
	// Offline, because no Worker is attached — but it got past caller
	// resolution, which is what this pins. A missing caller reads
	// `agent_not_found` instead.
	if code, _ := response["code"].(string); code != "rpc_failed" {
		t.Fatalf("read_inbox as operator = %#v; the explicit caller was not accepted", response)
	}
}
