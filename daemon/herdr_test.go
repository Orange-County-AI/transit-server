package main

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func fakeHerdr(t *testing.T, handler func(herdrRequest) (any, *HerdrAPIError)) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "herdr.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		listener.Close()
	})
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				var request herdrRequest
				if json.NewDecoder(connection).Decode(&request) != nil {
					return
				}
				result, apiError := handler(request)
				response := map[string]any{"id": request.ID}
				if apiError != nil {
					response["error"] = apiError
				} else {
					response["result"] = result
				}
				_ = json.NewEncoder(connection).Encode(response)
			}()
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	return path
}

func pong() map[string]any {
	return map[string]any{"type": "pong", "version": "0.9.0", "protocol": minHerdrProtocol}
}

func TestHerdrListAndPromptWait(t *testing.T) {
	var mu sync.Mutex
	var promptParams map[string]any
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			return map[string]any{
				"type": "agent_list",
				"agents": []map[string]any{{
					"name": "alice", "agent": "omp", "agent_status": "idle",
					"pane_id": "w1:p1", "cwd": "/work", "terminal_title_stripped": "Alice",
				}},
			}, nil
		case "agent.prompt":
			mu.Lock()
			promptParams, _ = request.Params.(map[string]any)
			mu.Unlock()
			return map[string]any{
				"type": "agent_prompted",
				"agent": map[string]any{
					"name": "alice", "agent": "omp", "agent_status": "idle", "pane_id": "w1:p1",
				},
			}, nil
		default:
			return nil, &HerdrAPIError{Code: "unknown_method", Message: request.Method}
		}
	})
	driver := newHerdrSocket(path, func(string) {})
	agents, err := driver.ListAgents(context.Background())
	if err != nil || len(agents) != 1 || agents[0].Name != "alice" {
		t.Fatalf("ListAgents() = %#v, %v", agents, err)
	}
	result := driver.PromptAgent(context.Background(), "alice", "hello", time.Second)
	if !result.OK {
		t.Fatalf("PromptAgent() = %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()
	wait, ok := promptParams["wait"].(map[string]any)
	if !ok || wait["timeout_ms"] != float64(1000) {
		t.Fatalf("prompt wait = %#v", promptParams["wait"])
	}
}

// agent.prompt can legitimately wait for a whole agent turn. Every Herdr RPC
// uses its own Unix connection, so that wait must not serialize roster and
// health calls behind it.
func TestHerdrLongPromptDoesNotBlockRosterCalls(t *testing.T) {
	promptStarted := make(chan struct{})
	releasePrompt := make(chan struct{})
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.prompt":
			close(promptStarted)
			<-releasePrompt
			return map[string]any{
				"type": "agent_prompted",
				"agent": map[string]any{
					"name": "alice", "agent": "omp", "agent_status": "idle", "pane_id": "w1:p1",
				},
			}, nil
		case "agent.list":
			return map[string]any{
				"type": "agent_list",
				"agents": []map[string]any{{
					"name": "alice", "agent": "omp", "agent_status": "idle", "pane_id": "w1:p1",
				}},
			}, nil
		default:
			return nil, &HerdrAPIError{Code: "unknown_method", Message: request.Method}
		}
	})
	driver := newHerdrSocket(path, func(string) {})
	promptDone := make(chan PromptResult, 1)
	go func() {
		promptDone <- driver.PromptAgent(context.Background(), "alice", "hello", time.Second)
	}()
	<-promptStarted
	timer := time.AfterFunc(300*time.Millisecond, func() { close(releasePrompt) })
	defer timer.Stop()

	started := time.Now()
	agents, err := driver.ListAgents(context.Background())
	elapsed := time.Since(started)
	if err != nil || len(agents) != 1 || agents[0].Name != "alice" {
		t.Fatalf("ListAgents() = %#v, %v", agents, err)
	}
	if elapsed >= 150*time.Millisecond {
		t.Fatalf("ListAgents blocked %s behind agent.prompt; independent connections must run concurrently", elapsed)
	}
	if result := <-promptDone; !result.OK {
		t.Fatalf("PromptAgent() = %+v", result)
	}
}

func TestHerdrProtocolFloorRejectsOlder(t *testing.T) {
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		return map[string]any{"type": "pong", "version": "0.8.2", "protocol": minHerdrProtocol - 1}, nil
	})
	_, _, err := newHerdrSocket(path, func(string) {}).Ping(context.Background())
	if err == nil {
		t.Fatalf("protocol %d accepted below the floor %d", minHerdrProtocol-1, minHerdrProtocol)
	}
}

// A newer Herdr must not take the Herdr path down: Herdr bumps this number for
// same-install concerns that never touch the JSON API this daemon speaks.
func TestHerdrProtocolFloorAcceptsNewer(t *testing.T) {
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		return map[string]any{"type": "pong", "version": "9.9.9", "protocol": minHerdrProtocol + 7}, nil
	})
	if _, _, err := newHerdrSocket(path, func(string) {}).Ping(context.Background()); err != nil {
		t.Fatalf("newer protocol rejected: %v", err)
	}
}

func TestHerdrProtocolMinOverride(t *testing.T) {
	t.Setenv("TRANSIT_HERDR_PROTOCOL_MIN", strconv.Itoa(minHerdrProtocol+1))
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		return pong(), nil
	})
	_, _, err := newHerdrSocket(path, func(string) {}).Ping(context.Background())
	if err == nil {
		t.Fatalf("protocol %d accepted despite floor raised above it", minHerdrProtocol)
	}
}

func TestDeliveryFailureCodeNeverEmpty(t *testing.T) {
	if got := deliveryFailureCode(PromptResult{}); got != "agent_prompt_failed" {
		t.Fatalf("deliveryFailureCode(empty) = %q", got)
	}
	if got := deliveryFailureCode(PromptResult{Code: "agent_prompt_stalled"}); got != "agent_prompt_stalled" {
		t.Fatalf("deliveryFailureCode(stalled) = %q", got)
	}
}
