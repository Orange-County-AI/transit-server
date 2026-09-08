package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// rejectingHerdr answers everything but `ping` the way Herdr answers a frame it
// could not parse: an `invalid_request` error under an EMPTY id, because the id
// is parsed from the same frame it rejected. Shape verified against herdr
// 0.9.0, which is what an unknown method and a missing field both return.
func rejectingHerdr(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "herdr.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
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
				response := map[string]any{"id": "", "error": map[string]any{
					"code":    "invalid_request",
					"message": "invalid request: unknown variant `" + request.Method + "`",
				}}
				if request.Method == "ping" {
					response = map[string]any{"id": request.ID, "result": pong()}
				}
				_ = json.NewEncoder(connection).Encode(response)
			}()
		}
	}()
	return path
}

// Herdr's protocol asks JSON clients to treat an unsupported method as an
// ordinary error. Transit reported every one as "id mismatch" instead, which
// discarded the code saying why and read as a transport bug rather than skew.
func TestUnsupportedMethodSurfacesHerdrError(t *testing.T) {
	driver := newHerdrSocket(rejectingHerdr(t), func(string) {})
	_, err := driver.ListAgents(context.Background())
	if err == nil {
		t.Fatal("ListAgents succeeded against a herdr that rejects the method")
	}
	var apiError *HerdrAPIError
	if !errors.As(err, &apiError) || apiError.Code != "invalid_request" {
		t.Fatalf("ListAgents() error = %v; want herdr's invalid_request code", err)
	}
}

// A method this Herdr build will not accept is a version skew that clears on
// upgrade, not the agent refusing a prompt. Reporting agent_prompt_failed
// blamed the agent for the transport, the same mistake herdr_unavailable
// already exists to prevent against agent_not_found.
func TestUnsupportedPromptReportsHerdrUnavailable(t *testing.T) {
	driver := newHerdrSocket(rejectingHerdr(t), func(string) {})
	result := driver.PromptAgent(context.Background(), "alice", "hello", time.Second)
	if result.OK {
		t.Fatal("PromptAgent succeeded against a herdr that rejects the method")
	}
	if code := deliveryFailureCode(result); code != "herdr_unavailable" {
		t.Fatalf("deliveryFailureCode(%+v) = %q; want herdr_unavailable", result, code)
	}
}

// One pane that will not take an auto-name must not take the roster with it.
// rosterLoop skips sendRosters on a refresh error, so a single rejected rename
// blacked out the whole published map — native adapters included, which have
// nothing to do with Herdr.
func TestFailedAutoNameKeepsRosterPublishing(t *testing.T) {
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			return map[string]any{"type": "agent_list", "agents": []map[string]any{{
				"agent": "omp", "agent_status": "idle", "pane_id": "w1:p1", "cwd": "/tmp",
			}}}, nil
		}
		return nil, &HerdrAPIError{Code: "invalid_request", Message: "unknown variant `" + request.Method + "`"}
	})
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d := newDaemon(
		&Config{URL: "https://transit.example", Host: "titan", DeliveryMode: "prefer"},
		"token", store, newHerdrSocket(path, func(string) {}),
	)
	registerAdapterDirect(t, d, agentFrame{
		Harness: "omp", SessionID: "session-1", Name: "solo", Status: "idle",
	})

	if _, err := d.refreshRoster(context.Background()); err != nil {
		t.Fatalf("refreshRoster = %v; a rejected rename must not fail the refresh", err)
	}
	d.mu.RLock()
	roster := append([]WireAgent(nil), d.roster[defaultEnrollment]...)
	d.mu.RUnlock()
	for _, agent := range roster {
		if agent.Name == "solo" {
			return
		}
	}
	t.Fatalf("roster = %#v; the native adapter was dropped by a failed rename", roster)
}
