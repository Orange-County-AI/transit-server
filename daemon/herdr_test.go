package main

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
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
	return map[string]any{"type": "pong", "version": "0.8.0", "protocol": 20}
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

func TestHerdrProtocolOverride(t *testing.T) {
	t.Setenv("TRANSIT_HERDR_PROTOCOL_ALLOW", "19")
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		return pong(), nil
	})
	_, _, err := newHerdrSocket(path, func(string) {}).Ping(context.Background())
	if err == nil {
		t.Fatal("protocol 20 accepted despite override to 19")
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
