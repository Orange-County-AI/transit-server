package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

// The Worker retries a queued delivery entry while the daemon's attempt is
// still legitimately in flight (an agent.prompt can wait out a whole agent
// turn). Those concurrent retries must coalesce into the in-flight prompt —
// each one used to type the envelope into the terminal again — while a
// sequential redelivery still prompts.
func TestDeliverCoalescesConcurrentAttemptsForSameAgent(t *testing.T) {
	agent := HerdrAgent{Name: "alice", Kind: "omp", PaneID: "titan:p1", Status: "idle"}
	var mu sync.Mutex
	prompts := 0
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	herdrPath := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			return map[string]any{"type": "agent_list", "agents": []HerdrAgent{agent}}, nil
		case "agent.prompt":
			mu.Lock()
			prompts++
			mu.Unlock()
			entered <- struct{}{}
			<-release
			return map[string]any{"type": "agent_prompted", "agent": agent}, nil
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
		"token", store, newHerdrSocket(herdrPath, nil),
	)
	d.herdrAgents = []HerdrAgent{agent}

	frame := WireFrame{ID: "tx_coalesce01", Agent: "alice", Envelope: "<transit/>"}
	outcomes := make(chan string, 2)
	deliver := func() {
		code, _, err := d.deliver(context.Background(), d.defaultEnrollmentRuntime(), frame)
		outcomes <- fmt.Sprintf("code=%q err=%v", code, err)
	}

	go deliver()
	<-entered // the leader is parked inside agent.prompt

	go deliver()
	waitForFollowers(t, d, frame, 1)

	close(release)
	for range 2 {
		if outcome := <-outcomes; outcome != `code="" err=<nil>` {
			t.Fatalf("coalesced deliver outcome = %s, want success", outcome)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if prompts != 1 {
		t.Fatalf("agent.prompt called %d times for one in-flight delivery, want 1", prompts)
	}
}

// A settled sequential redelivery is a different event from a concurrent
// retry: after the first attempt completed, the same id prompts again (the
// unsettled channel banner depends on this).
func TestDeliverSequentialAttemptsStillPrompt(t *testing.T) {
	agent := HerdrAgent{Name: "alice", Kind: "omp", PaneID: "titan:p1", Status: "idle"}
	var mu sync.Mutex
	prompts := 0
	herdrPath := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			return map[string]any{"type": "agent_list", "agents": []HerdrAgent{agent}}, nil
		case "agent.prompt":
			mu.Lock()
			prompts++
			mu.Unlock()
			return map[string]any{"type": "agent_prompted", "agent": agent}, nil
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
		"token", store, newHerdrSocket(herdrPath, nil),
	)
	d.herdrAgents = []HerdrAgent{agent}

	first := WireFrame{ID: "dlv_seq00000001", Agent: "alice", Envelope: "<transit/>"}
	for attempt := 1; attempt <= 2; attempt++ {
		if code, _, err := d.deliver(context.Background(), d.defaultEnrollmentRuntime(), first); code != "" || err != nil {
			t.Fatalf("deliver #%d = %q, %v", attempt, code, err)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if prompts != 2 {
		t.Fatalf("agent.prompt called %d times across two sequential attempts, want 2", prompts)
	}
}

// A Herdr prompt can land and then lose its response when the socket stalls.
// The roster snapshot already carries the local transcript path, so settlement
// must read that artefact before asking the same failed socket for agent.get.
func TestDeliverSettlesFromCachedTranscriptWhenHerdrResponseIsLost(t *testing.T) {
	const id = "tx_transcript01"
	transcript := t.TempDir() + "/session.jsonl"
	if err := os.WriteFile(transcript, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	agent := HerdrAgent{Name: "alice", Kind: "claude", PaneID: "titan:p1", Status: "idle"}
	agent.Session.Kind = "path"
	agent.Session.Value = transcript
	getCalls := 0
	path := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		switch request.Method {
		case "ping":
			return pong(), nil
		case "pane.read":
			return map[string]any{"type": "pane_read", "read": map[string]any{"text": ""}}, nil
		case "agent.prompt":
			if err := os.WriteFile(transcript, []byte(`{"message":"`+id+`"}`+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			return nil, &HerdrAPIError{Code: "timeout", Message: "response lost after delivery"}
		case "agent.get":
			getCalls++
			return nil, &HerdrAPIError{Code: "timeout", Message: "socket still unavailable"}
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
	d.herdrAgents = []HerdrAgent{agent}

	code, retryable, err := d.deliverOnce(context.Background(), d.defaultEnrollmentRuntime(), WireFrame{
		ID: id, Agent: agent.Name, Envelope: `<transit id="` + id + `"/>`,
	})
	if code != "" || retryable || err != nil {
		t.Fatalf("deliverOnce = %q, %t, %v; cached transcript proves delivery", code, retryable, err)
	}
	if getCalls != 0 {
		t.Fatalf("agent.get called %d times despite a conclusive cached transcript", getCalls)
	}
	if !d.store.IncomingRecorded(id) {
		t.Fatal("landed delivery was not archived")
	}
}

func waitForFollowers(t *testing.T, d *Daemon, frame WireFrame, want int) {
	t.Helper()
	key := d.defaultEnrollmentRuntime().id + "\x00" + frame.ID + "\x00" + frame.Agent
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d.mu.Lock()
		flight, ok := d.inflight[key]
		waiters := 0
		if ok {
			waiters = flight.waiters
		}
		d.mu.Unlock()
		if ok && waiters >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("follower never joined the in-flight delivery")
}
