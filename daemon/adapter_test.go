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

func newAdapterTestDaemon(t *testing.T, mode string, agents []HerdrAgent, prompts *int) (*Daemon, string) {
	t.Helper()
	var mu sync.Mutex
	herdrPath := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			return map[string]any{"type": "agent_list", "agents": agents}, nil
		case "agent.prompt":
			mu.Lock()
			*prompts++
			mu.Unlock()
			if len(agents) == 0 {
				return nil, &HerdrAPIError{Code: "agent_not_found"}
			}
			return map[string]any{"type": "agent_prompted", "agent": agents[0]}, nil
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

func TestNativeDeliveryAcknowledgementRecordsHistory(t *testing.T) {
	var prompts int
	d, path := newAdapterTestDaemon(t, "prefer", nil, &prompts)
	client := connectAdapter(t, path, "claude", "delivery-session", "claude-delivery")
	result := make(chan error, 1)
	go func() {
		code, retryable, err := d.deliver(context.Background(), WireFrame{ID: "tx_native_ack", Agent: client.name, Envelope: "<transit/>"})
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
		code, retryable, err := d.deliver(context.Background(), WireFrame{ID: "tx_native_nak", Agent: client.name, Envelope: "<transit/>"})
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
		code, retryable, err := prefer.deliver(context.Background(), WireFrame{ID: "tx_prefer", Agent: agent.Name, Envelope: "native"})
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
	code, retryable, err := shadow.deliver(context.Background(), WireFrame{ID: "tx_shadow", Agent: agent.Name, Envelope: "herdr"})
	if code != "" || retryable || err != nil || shadowPrompts != 1 {
		t.Fatalf("shadow delivery = %q, %t, %v; prompts=%d", code, retryable, err, shadowPrompts)
	}

	var requirePrompts int
	required, _ := newAdapterTestDaemon(t, "require", []HerdrAgent{agent}, &requirePrompts)
	if _, err := required.refreshRoster(context.Background()); err != nil {
		t.Fatal(err)
	}
	code, retryable, err = required.deliver(context.Background(), WireFrame{ID: "tx_require", Agent: agent.Name, Envelope: "blocked"})
	if code != "adapter_unavailable" || !retryable || err == nil || requirePrompts != 0 {
		t.Fatalf("require claude = %q, %t, %v; prompts=%d", code, retryable, err, requirePrompts)
	}
	other := HerdrAgent{Name: "other-mode", Kind: "other", PaneID: "p2", Status: "idle"}
	required.herdrAgents = []HerdrAgent{other}
	code, retryable, err = required.deliver(context.Background(), WireFrame{ID: "tx_other", Agent: other.Name, Envelope: "fallback"})
	if code != "" || retryable || err != nil || requirePrompts != 1 {
		t.Fatalf("require other = %q, %t, %v; prompts=%d", code, retryable, err, requirePrompts)
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
