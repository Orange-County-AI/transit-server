package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type adapterTestClient struct {
	connection net.Conn
	reader     *bufio.Reader
	capability string
	name       string
	generation uint64
}

func (client *adapterTestClient) close() { _ = client.connection.Close() }

// waitForAdapterGone blocks until the daemon has noticed a closed adapter
// connection, which is asynchronous: the reader goroutine deregisters.
func waitForAdapterGone(t *testing.T, d *Daemon, name string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if d.nativeAdapterByName(defaultEnrollment, name) == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("adapter %s was still registered after its connection closed", name)
}

func newAdapterTestDaemon(t *testing.T, mode string, agents []HerdrAgent, prompts *int) (*Daemon, string) {
	t.Helper()
	var mu sync.Mutex
	herdrPath := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			mu.Lock()
			list := append([]HerdrAgent(nil), agents...)
			mu.Unlock()
			return map[string]any{"type": "agent_list", "agents": list}, nil
		case "agent.get":
			params, _ := request.Params.(map[string]any)
			target, _ := params["target"].(string)
			mu.Lock()
			defer mu.Unlock()
			for index := range agents {
				if agents[index].PaneID == target || agents[index].Name == target {
					return map[string]any{"type": "agent_info", "agent": agents[index]}, nil
				}
			}
			return nil, &HerdrAPIError{Code: "agent_not_found"}
		case "agent.prompt":
			mu.Lock()
			*prompts++
			if len(agents) == 0 {
				mu.Unlock()
				return nil, &HerdrAPIError{Code: "agent_not_found"}
			}
			agent := agents[0]
			mu.Unlock()
			return map[string]any{"type": "agent_prompted", "agent": agent}, nil
		case "agent.rename":
			params, _ := request.Params.(map[string]any)
			target, _ := params["target"].(string)
			name, _ := params["name"].(string)
			mu.Lock()
			defer mu.Unlock()
			for index := range agents {
				if agents[index].PaneID == target || agents[index].Name == target {
					agents[index].Name = name
					return map[string]any{"type": "agent_info", "agent": agents[index]}, nil
				}
			}
			return nil, &HerdrAPIError{Code: "agent_not_found"}
		case "pane.read":
			return map[string]any{"type": "pane_read", "read": map[string]any{"text": ""}}, nil
		default:
			return nil, &HerdrAPIError{Code: "unexpected", Message: request.Method}
		}
	})
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d := newDaemon(&Config{URL: "https://transit.example", Host: "titan", DeliveryMode: mode}, "token", store, newHerdrSocket(herdrPath, nil))
	listenerPath := filepath.Join(t.TempDir(), "agent.sock")
	listener, err := listenAgentSocket(listenerPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		_ = listener.Close()
	})
	go func() { _ = serveAgentSocket(ctx, listener, d) }()
	return d, listenerPath
}

func connectAdapter(t *testing.T, path, harness, sessionID, name string) *adapterTestClient {
	t.Helper()
	connection, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	client := &adapterTestClient{connection: connection, reader: bufio.NewReader(connection)}
	t.Cleanup(func() { _ = connection.Close() })
	if err := writeJSONLine(connection, agentFrame{
		T: "register", Proto: agentProtocol, Harness: harness, SessionID: sessionID, PID: os.Getpid(),
		CWD: "/tmp/project", Title: "Transit", Status: "idle", Name: name,
	}); err != nil {
		t.Fatal(err)
	}
	frame := client.read(t)
	if frame.T != "registered" {
		t.Fatalf("register frame = %#v", frame)
	}
	client.capability, client.name, client.generation = frame.Capability, frame.Agent, frame.Generation
	return client
}

func registerAdapterDirect(t *testing.T, d *Daemon, frame agentFrame) *agentAdapter {
	t.Helper()
	server, client := net.Pipe()
	t.Cleanup(func() {
		_ = server.Close()
		_ = client.Close()
	})
	adapter, code, message := d.registerAgentAdapter(frame, os.Getpid(), 0, server)
	if code != "" {
		t.Fatalf("register = %q, %q", code, message)
	}
	return adapter
}

func setAdapterTestHerdrAgents(d *Daemon, agents []HerdrAgent) {
	d.mu.Lock()
	d.herdrAgents = agents
	d.mu.Unlock()
}

func attachNativeCaller(t *testing.T, d *Daemon, name string) *agentAdapter {
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
	adapter := &agentAdapter{
		key: defaultEnrollment + "|session:caller", harness: "omp", sessionID: "caller",
		pid: os.Getpid(), pidStart: start, enrollment: defaultEnrollment,
		name: name, namedBy: "herdr", generation: 7, connection: server, waiters: make(map[string]chan agentDeliveryOutcome),
	}
	d.mu.Lock()
	d.adapters[adapter.key] = adapter
	d.bindNativeNameLocked(defaultEnrollment, name, adapter)
	d.nativeNames[adapter.key] = nativeName{
		Name: name, NamedBy: "herdr", Generation: adapter.generation, Enrollment: defaultEnrollment,
	}
	d.mu.Unlock()
	return adapter
}

func (client *adapterTestClient) read(t *testing.T) agentFrame {
	t.Helper()
	if err := client.connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	defer client.connection.SetReadDeadline(time.Time{})
	line, err := client.reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var frame agentFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func (client *adapterTestClient) send(t *testing.T, frame agentFrame) {
	t.Helper()
	frame.Capability = client.capability
	if err := writeJSONLine(client.connection, frame); err != nil {
		t.Fatal(err)
	}
}

func TestAdapterRegistrationKeepsSessionIdentity(t *testing.T) {
	for _, harness := range []string{"claude", "omp", "pi", "opencode"} {
		t.Run(harness, func(t *testing.T) {
			var prompts int
			_, path := newAdapterTestDaemon(t, "prefer", nil, &prompts)
			first := connectAdapter(t, path, harness, "session-one", "")
			second := connectAdapter(t, path, harness, "session-one", "")
			if first.name != second.name {
				t.Fatalf("re-register name = %q, want %q", second.name, first.name)
			}
			if second.generation <= first.generation {
				t.Fatalf("generation = %d, want > %d", second.generation, first.generation)
			}
			third := connectAdapter(t, path, harness, "session-two", "")
			if third.name == first.name {
				t.Fatalf("different session reused %q", third.name)
			}
		})
	}
}

func TestAdapterRegistrationAdoptsHerdrPaneName(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	setAdapterTestHerdrAgents(d, []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}})

	adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: "pane-1"})
	if adapter.name != "omp-pane" {
		t.Fatalf("adapter name = %q, want %q", adapter.name, "omp-pane")
	}
	if adapter.namedBy != "herdr" {
		t.Fatalf("adapter named by = %q, want %q", adapter.namedBy, "herdr")
	}
	if record := d.nativeNames[defaultEnrollment+"|session:session-1"]; record.NamedBy != "herdr" {
		t.Fatalf("stored named by = %q, want %q", record.NamedBy, "herdr")
	}
}

func TestAdapterRegistrationExplicitNameWinsOverHerdrPane(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	setAdapterTestHerdrAgents(d, []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}})

	adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: "pane-1", Name: "explicit"})
	if adapter.name != "explicit" || adapter.namedBy != "user" {
		t.Fatalf("adapter = %#v, want explicit user name", adapter)
	}
}

// A stored name someone chose outranks the pane: renaming an agent must stick
// across a reconnect.
func TestAdapterRegistrationStoredChosenNameWinsOverHerdrPane(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	setAdapterTestHerdrAgents(d, []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}})
	d.nativeNames[defaultEnrollment+"|session:session-1"] = nativeName{Name: "stored", NamedBy: "user"}

	adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: "pane-1"})
	if adapter.name != "stored" || adapter.namedBy != "user" {
		t.Fatalf("adapter = %#v, want the stored chosen name", adapter)
	}
}

// A stored name the DAEMON invented is a placeholder and yields to the pane.
// It used to win, which is how a name minted during a restart — when the
// roster was still empty and the pane could not be seen — became permanent
// and left the agent registered beside its own pane under two names.
func TestAdapterRegistrationStoredAutoNameYieldsToHerdrPane(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	setAdapterTestHerdrAgents(d, []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}})
	d.nativeNames[defaultEnrollment+"|session:session-1"] = nativeName{
		Name: "omp-placeholder", NamedBy: "auto", Generation: 4, Token: "0123456789abcdef0123456789abcdef",
	}

	adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: "pane-1"})
	if adapter.name != "omp-pane" || adapter.namedBy != "herdr" {
		t.Fatalf("adapter = %q/%q, want the pane's name", adapter.name, adapter.namedBy)
	}
	if adapter.token != "0123456789abcdef0123456789abcdef" {
		t.Fatal("the identity credential rotated on a rename")
	}
	if adapter.generation != 5 {
		t.Fatalf("generation = %d, want the stored 4 carried forward", adapter.generation)
	}
}

// Every adapter on the box reconnects at once when the daemon restarts, which
// is precisely when the cached roster is still empty. Registering off that
// empty cache minted a placeholder beside a pane that already had a name.
func TestAdapterRegistrationResolvesItsPaneWithAnEmptyRoster(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}}, &prompts)
	// The roster cache is deliberately NOT primed: no refreshRoster has run.
	d.mu.RLock()
	cached := len(d.herdrAgents)
	d.mu.RUnlock()
	if cached != 0 {
		t.Fatalf("herdr cache holds %d agents; the test would pass for the wrong reason", cached)
	}

	adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: "pane-1"})
	if adapter.name != "omp-pane" {
		t.Fatalf("adapter name = %q, want the pane's name resolved directly from Herdr", adapter.name)
	}
}

func TestAdapterRegistrationFallsBackToAutoNameWithoutAvailablePaneName(t *testing.T) {
	for _, test := range []struct {
		name   string
		paneID string
	}{
		{name: "unknown pane", paneID: "unknown"},
		{name: "empty pane", paneID: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			var prompts int
			d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
			setAdapterTestHerdrAgents(d, []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}})

			adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: test.paneID})
			if adapter.name == "omp-pane" {
				t.Fatalf("adapter adopted unavailable pane name %q", adapter.name)
			}
			if adapter.namedBy != "auto" {
				t.Fatalf("adapter named by = %q, want %q", adapter.namedBy, "auto")
			}
		})
	}
}

// A dead record holding the pane's name is an earlier incarnation of the agent
// in that pane, not a rival for the name. Treating it as a claimant is what
// left four titan agents registered beside their own panes under invented
// names after the identity keys changed shape.
func TestAdapterRegistrationAbsorbsADeadRecordHoldingItsPaneName(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	setAdapterTestHerdrAgents(d, []HerdrAgent{{Name: "omp-pane", Kind: "omp", PaneID: "pane-1"}})
	// The shape a pre-upgrade record had: keyed by harness and session id.
	d.nativeNames["omp:other-session"] = nativeName{
		Name: "omp-pane", NamedBy: "herdr", Generation: 9, Token: "0123456789abcdef0123456789abcdef",
	}

	adapter := registerAdapterDirect(t, d, agentFrame{Harness: "omp", SessionID: "session-1", PaneID: "pane-1"})
	if adapter.name != "omp-pane" {
		t.Fatalf("adapter name = %q; a dead record blocked its own pane's name", adapter.name)
	}
	if adapter.generation != 10 || adapter.token != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("generation/token = %d/%q; want the absorbed record's", adapter.generation, adapter.token)
	}
	if _, stale := d.nativeNames["omp:other-session"]; stale {
		t.Fatal("the superseded record survived, so the name stays double-claimed")
	}
}

func TestClaimCallerNameRebindsNativeAdapter(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	adapter := attachNativeCaller(t, d, "omp-old")

	address, err := d.claimCallerName(context.Background(), map[string]any{"pid": os.Getpid(), "name": "omp-new"})
	if err != nil || address != "omp-new@titan" {
		t.Fatalf("claimCallerName = %q, %v", address, err)
	}
	record := d.nativeNames[adapter.key]
	if adapter.name != "omp-new" || adapter.namedBy != "user" || adapter.generation != 8 {
		t.Fatalf("adapter = %#v, want renamed user generation 8", adapter)
	}
	if record.Name != "omp-new" || record.NamedBy != "user" || record.Generation != 8 {
		t.Fatalf("stored native name = %#v, want renamed user generation 8", record)
	}
}

func TestClaimCallerNameRenamesPaneWithoutNativeAdapter(t *testing.T) {
	var prompts int
	agents := []HerdrAgent{{Name: "omp-old", Kind: "omp", PaneID: "pane-1"}}
	d, _ := newAdapterTestDaemon(t, "prefer", agents, &prompts)
	setAdapterTestHerdrAgents(d, agents)

	address, err := d.claimCallerName(context.Background(), map[string]any{"pane_id": "pane-1", "name": "omp-new"})
	if err != nil || address != "omp-new@titan" {
		t.Fatalf("claimCallerName = %q, %v", address, err)
	}
	if agents[0].Name != "omp-new" {
		t.Fatalf("Herdr agent name = %q, want %q", agents[0].Name, "omp-new")
	}
}

func TestClaimCallerNameRenamesNativeAdapterAndPane(t *testing.T) {
	var prompts int
	agents := []HerdrAgent{{Name: "omp-old", Kind: "omp", PaneID: "pane-1"}}
	d, _ := newAdapterTestDaemon(t, "prefer", agents, &prompts)
	setAdapterTestHerdrAgents(d, agents)
	adapter := attachNativeCaller(t, d, "omp-old")

	address, err := d.claimCallerName(context.Background(), map[string]any{
		"pane_id": "pane-1", "pid": os.Getpid(), "name": "omp-new",
	})
	if err != nil || address != "omp-new@titan" {
		t.Fatalf("claimCallerName = %q, %v", address, err)
	}
	if agents[0].Name != "omp-new" || adapter.name != "omp-new" {
		t.Fatalf("pane/native names = %q/%q, want %q", agents[0].Name, adapter.name, "omp-new")
	}
}

func TestClaimCallerNameRejectsNativeNameHeldByAnotherSessionWithoutRenamingPane(t *testing.T) {
	var prompts int
	agents := []HerdrAgent{{Name: "omp-old", Kind: "omp", PaneID: "pane-1"}}
	d, _ := newAdapterTestDaemon(t, "prefer", agents, &prompts)
	setAdapterTestHerdrAgents(d, agents)
	adapter := attachNativeCaller(t, d, "omp-old")
	d.nativeNames["omp:other"] = nativeName{Name: "omp-taken", NamedBy: "user", Generation: 3}

	_, err := d.claimCallerName(context.Background(), map[string]any{
		"pane_id": "pane-1", "pid": os.Getpid(), "name": "omp-taken",
	})
	if err == nil || err.Error() != "name is already claimed by another native session" {
		t.Fatalf("claimCallerName error = %v", err)
	}
	if agents[0].Name != "omp-old" || adapter.name != "omp-old" {
		t.Fatalf("pane/native names mutated to %q/%q", agents[0].Name, adapter.name)
	}
	if record := d.nativeNames[adapter.key]; record.Name != "omp-old" || record.Generation != 7 {
		t.Fatalf("native record mutated to %#v", record)
	}
}

func TestNativeDeliveryAcknowledgementRecordsHistory(t *testing.T) {
	var prompts int
	d, path := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	client := connectAdapter(t, path, "claude", "delivery-session", "claude-delivery")
	result := make(chan error, 1)
	go func() {
		code, retryable, err := d.deliver(context.Background(), d.defaultEnrollmentRuntime(), WireFrame{ID: "tx_native_ack", Agent: client.name, Envelope: "<transit/>"})
		if code != "" || retryable {
			result <- fmt.Errorf("deliver = %q, %t, %v", code, retryable, err)
			return
		}
		result <- err
	}()
	deliver := client.read(t)
	if deliver.T != "deliver" || deliver.ID != "tx_native_ack" || deliver.Envelope != "<transit/>" {
		t.Fatalf("deliver frame = %#v", deliver)
	}
	client.send(t, agentFrame{T: "deliver_ack", ID: deliver.ID, Persisted: true})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if !d.store.IncomingRecorded("tx_native_ack") {
		t.Fatal("successful native delivery was not recorded")
	}
}

func TestNativeDeliveryNakDoesNotRecordHistory(t *testing.T) {
	var prompts int
	d, path := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	client := connectAdapter(t, path, "claude", "nak-session", "claude-nak")
	result := make(chan struct {
		code      string
		retryable bool
		err       error
	}, 1)
	go func() {
		code, retryable, err := d.deliver(context.Background(), d.defaultEnrollmentRuntime(), WireFrame{ID: "tx_native_nak", Agent: client.name, Envelope: "<transit/>"})
		result <- struct {
			code      string
			retryable bool
			err       error
		}{code, retryable, err}
	}()
	deliver := client.read(t)
	client.send(t, agentFrame{T: "deliver_nak", ID: deliver.ID, Code: "transcript_timeout", Retryable: true})
	outcome := <-result
	if outcome.code != "transcript_timeout" || !outcome.retryable || outcome.err == nil {
		t.Fatalf("nak outcome = %#v", outcome)
	}
	if d.store.IncomingRecorded("tx_native_nak") {
		t.Fatal("nacked native delivery was recorded")
	}
}

func TestDeliveryModeMatrix(t *testing.T) {
	agent := HerdrAgent{Name: "claude-mode", Kind: "claude", PaneID: "p1", Status: "idle"}
	var preferPrompts int
	prefer, preferPath := newAdapterTestDaemon(t, "prefer", []HerdrAgent{agent}, &preferPrompts)
	if _, err := prefer.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	preferClient := connectAdapter(t, preferPath, "claude", "prefer-session", agent.Name)
	preferResult := make(chan error, 1)
	go func() {
		code, retryable, err := prefer.deliver(context.Background(), prefer.defaultEnrollmentRuntime(), WireFrame{ID: "tx_prefer", Agent: agent.Name, Envelope: "native"})
		if code != "" || retryable {
			preferResult <- fmt.Errorf("prefer delivery = %q, %t, %v", code, retryable, err)
			return
		}
		preferResult <- err
	}()
	preferDelivery := preferClient.read(t)
	preferClient.send(t, agentFrame{T: "deliver_ack", ID: preferDelivery.ID, Persisted: true})
	if err := <-preferResult; err != nil {
		t.Fatal(err)
	}
	if preferPrompts != 0 {
		t.Fatalf("prefer used Herdr %d times", preferPrompts)
	}

	var shadowPrompts int
	shadow, shadowPath := newAdapterTestDaemon(t, "shadow", []HerdrAgent{agent}, &shadowPrompts)
	if _, err := shadow.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	_ = connectAdapter(t, shadowPath, "claude", "shadow-session", agent.Name)
	code, retryable, err := shadow.deliver(context.Background(), shadow.defaultEnrollmentRuntime(), WireFrame{ID: "tx_shadow", Agent: agent.Name, Envelope: "herdr"})
	if code != "" || retryable || err != nil || shadowPrompts != 1 {
		t.Fatalf("shadow delivery = %q, %t, %v; prompts=%d", code, retryable, err, shadowPrompts)
	}

	// `require` refuses the Herdr path for an agent that has an adapter, which
	// is a fact the daemon recorded when that adapter registered — not the
	// harness kind the pane reports about itself.
	var requirePrompts int
	required, requirePath := newAdapterTestDaemon(t, "require", []HerdrAgent{agent}, &requirePrompts)
	if _, err := required.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	requireClient := connectAdapter(t, requirePath, "claude", "require-session", agent.Name)
	requireClient.close()
	waitForAdapterGone(t, required, agent.Name)
	code, retryable, err = required.deliver(context.Background(), required.defaultEnrollmentRuntime(), WireFrame{ID: "tx_require", Agent: agent.Name, Envelope: "blocked"})
	if code != "adapter_unavailable" || !retryable || err == nil || requirePrompts != 0 {
		t.Fatalf("require with a known adapter = %q, %t, %v; prompts=%d", code, retryable, err, requirePrompts)
	}
	// An agent that never presented an adapter still falls back to typing.
	// Refusing it would strand every pane-only agent on a `require` box.
	other := HerdrAgent{Name: "other-mode", Kind: "claude", PaneID: "p2", Status: "idle"}
	required.herdrAgents = []HerdrAgent{other}
	code, retryable, err = required.deliver(context.Background(), required.defaultEnrollmentRuntime(), WireFrame{ID: "tx_other", Agent: other.Name, Envelope: "fallback"})
	if code != "" || retryable || err != nil || requirePrompts != 1 {
		t.Fatalf("require without an adapter = %q, %t, %v; prompts=%d", code, retryable, err, requirePrompts)
	}
}

func TestAdapterRejectsUnsupportedProtocol(t *testing.T) {
	var prompts int
	_, path := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	connection, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := writeJSONLine(connection, agentFrame{T: "register", Proto: 2, Harness: "claude", SessionID: "bad-proto", PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var frame agentFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.T != "register_err" || frame.Code != "unsupported_proto" {
		t.Fatalf("protocol response = %#v", frame)
	}
}

func TestAdapterByProcessFindsAncestor(t *testing.T) {
	var prompts int
	d, _ := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	command := exec.Command("sh", "-c", "sleep 30 & echo $!; wait")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatal(err)
	}
	start, err := processStartTime(command.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	adapter := &agentAdapter{key: "claude:ancestor", harness: "claude", sessionID: "123456789", pid: command.Process.Pid, pidStart: start, name: "claude-ancestor"}
	d.mu.Lock()
	d.adapters[adapter.key] = adapter
	d.mu.Unlock()
	name, paneID, found := d.adapterByProcess(childPID)
	if !found || name != adapter.name || paneID != "native:claude:12345678" {
		t.Fatalf("adapterByProcess(child) = %q, %q, %t", name, paneID, found)
	}
	if address, err := d.claimNativeName(childPID, "claude-renamed"); err != nil || address != "claude-renamed@titan" {
		t.Fatalf("claimNativeName(child) = %q, %v", address, err)
	}
	if record := d.nativeNames[adapter.key]; record.Name != "claude-renamed" || record.NamedBy != "user" {
		t.Fatalf("persisted native name = %#v", record)
	}
	if _, _, found := d.adapterByProcess(os.Getpid()); found {
		t.Fatal("unrelated process resolved to native adapter")
	}
}

// A split identity - an adapter registered under one name while the Herdr
// roster advertises another - was invisible from the CLI, because status
// reported only the roster count. Proving it took a fleet config change and
// delivery forensics; it must take one status read.
func TestStatusReportsLiveAdaptersAndMode(t *testing.T) {
	t.Setenv("TRANSIT_DELIVERY_MODE", "require")
	d, _ := newAdapterTestDaemon(t, "require", []HerdrAgent{
		{Name: "omp-4jer", PaneID: "w1:p1", Kind: "omp", Status: "idle"},
	}, new(int))
	registerAdapterDirect(t, d, agentFrame{
		T: "register", Proto: agentProtocol, Harness: "omp",
		SessionID: "01a02b49-b517-7000-a194-7a928f701e18", Name: "omp-4maz", Status: "idle",
	})

	response := d.statusResponse()
	if response["delivery_mode"] != "require" {
		t.Fatalf("delivery_mode = %v, want require", response["delivery_mode"])
	}
	adapters, ok := response["adapters"].([]map[string]any)
	if !ok || len(adapters) != 1 {
		t.Fatalf("adapters = %#v", response["adapters"])
	}
	row := adapters[0]
	// The whole point: the name that RECEIVES is readable, so it can be
	// compared against the name the agent advertises instead of inferred.
	if row["name"] != "omp-4maz" || row["harness"] != "omp" || row["named_by"] != "user" {
		t.Fatalf("adapter row = %#v", row)
	}
	if row["session_id"] != "01a02b49-b517-7000-a194-7a928f701e18" {
		t.Fatalf("adapter session = %#v", row["session_id"])
	}
}

// An agent with no adapter reports an empty list rather than omitting the
// field: "no adapters" and "this daemon cannot tell you" must not look alike.
func TestStatusReportsEmptyAdapterList(t *testing.T) {
	d, _ := newAdapterTestDaemon(t, "prefer", nil, new(int))
	response := d.statusResponse()
	adapters, ok := response["adapters"].([]map[string]any)
	if !ok || len(adapters) != 0 {
		t.Fatalf("adapters = %#v", response["adapters"])
	}
	if response["delivery_mode"] != "prefer" {
		t.Fatalf("delivery_mode = %v, want prefer", response["delivery_mode"])
	}
}
