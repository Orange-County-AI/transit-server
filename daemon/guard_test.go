package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// guardRig drives deliverOnce against a fake Herdr whose pane screen is a live
// capture. onStall swaps the screen for the one the paste produced, which is
// the only moment the recovery path can observe.
type guardRig struct {
	daemon  *Daemon
	agent   HerdrAgent
	mu      sync.Mutex
	screen  string
	onStall string
	stall   bool
	seq     uint64
	prompts []string
	keys    []string
	notices int
}

func newGuardRig(t *testing.T, kind, screen string) *guardRig {
	t.Helper()
	rig := &guardRig{
		agent:  HerdrAgent{Name: "alice", Kind: kind, PaneID: "titan:p1", Status: "idle", StateChangeSeq: 7},
		screen: screen,
		seq:    7,
	}
	herdrPath := fakeHerdr(t, func(request herdrRequest) (any, *HerdrAPIError) {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		params, _ := request.Params.(map[string]any)
		agent := rig.agent
		agent.StateChangeSeq = rig.seq
		switch request.Method {
		case "ping":
			return pong(), nil
		case "agent.list":
			return map[string]any{"type": "agent_list", "agents": []HerdrAgent{agent}}, nil
		case "agent.get":
			return map[string]any{"type": "agent_info", "agent": agent}, nil
		case "pane.read":
			return map[string]any{"type": "pane_read", "read": map[string]any{"text": rig.screen}}, nil
		case "agent.prompt":
			text, _ := params["text"].(string)
			rig.prompts = append(rig.prompts, text)
			if rig.stall {
				if rig.onStall != "" {
					rig.screen = rig.onStall
				}
				return nil, &HerdrAPIError{Code: "agent_prompt_stalled", Message: "paste was not submitted"}
			}
			return map[string]any{"type": "agent_prompted", "agent": agent}, nil
		case "pane.send_keys":
			keys, _ := params["keys"].([]any)
			for _, key := range keys {
				rig.keys = append(rig.keys, key.(string))
			}
			rig.seq++
			return map[string]any{"type": "ok"}, nil
		case "agent.wait":
			return map[string]any{"type": "agent_info", "agent": agent}, nil
		case "notification.show":
			rig.notices++
			return map[string]any{"type": "ok"}, nil
		default:
			return nil, &HerdrAPIError{Code: "unexpected", Message: request.Method}
		}
	})
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	driver := newHerdrSocket(herdrPath, nil)
	driver.stallPollInterval = time.Millisecond
	rig.daemon = newDaemon(
		&Config{URL: "https://transit.example", Host: "titan", DeliveryMode: "prefer"},
		"token", store, driver,
	)
	rig.daemon.herdrAgents = []HerdrAgent{rig.agent}
	return rig
}

func (rig *guardRig) setScreen(screen string) {
	rig.mu.Lock()
	rig.screen = screen
	rig.mu.Unlock()
}

func (rig *guardRig) snapshot() (prompts, keys []string, notices int) {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	return append([]string(nil), rig.prompts...), append([]string(nil), rig.keys...), rig.notices
}

// Both envelope fixtures are the exact text pasted into the live pane that
// produced the paste screens, so the attribution check is exercised against
// real renders rather than a reconstruction.
func readEnvelopeFixture(t *testing.T, name string) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", "envelopes", name))
	if err != nil {
		t.Fatalf("read envelope fixture %s: %v", name, err)
	}
	return string(body)
}

// The regression: a delivery typed into a pane whose composer holds a person's
// unsent keystrokes submits their draft along with the envelope.
func TestDeliverHoldsWhileAPersonIsComposing(t *testing.T) {
	for _, test := range []struct {
		kind    string
		fixture string
	}{
		{"omp", "omp-draft.txt"},
		{"omp", "omp-draft-wrapped.txt"},
		{"omp", "omp-draft-working.txt"},
		{"claude", "claude-draft.txt"},
		{"claude", "claude-draft-working.txt"},
		// A labeled fence is where the guard used to fall open, so a Claude
		// session with a label was delivered into unguarded.
		{"claude", "claude-labeled-draft.txt"},
	} {
		t.Run(test.kind+"/"+test.fixture, func(t *testing.T) {
			rig := newGuardRig(t, test.kind, readScreenFixture(t, test.fixture))
			frame := WireFrame{ID: "tx_guard000001", Agent: "alice", Envelope: "<transit/>"}

			code, retryable, err := rig.daemon.deliver(context.Background(), frame)
			if code != "draft_busy" || !retryable || err == nil {
				t.Fatalf("deliver into a draft = %q retryable=%t err=%v, want a retryable draft_busy hold",
					code, retryable, err)
			}
			prompts, keys, notices := rig.snapshot()
			if len(prompts) != 0 || len(keys) != 0 {
				t.Fatalf("held delivery still touched the pane: prompts=%#v keys=%#v", prompts, keys)
			}
			if notices != 1 {
				t.Fatalf("hold notifications = %d, want exactly one", notices)
			}
			holds := rig.daemon.draftHolds()
			if len(holds) != 1 || holds[0].PaneID != "titan:p1" || holds[0].Agent != test.kind {
				t.Fatalf("draft holds = %#v", holds)
			}
			if rig.daemon.store.IncomingRecorded(frame.ID) {
				t.Fatal("a held delivery was archived as delivered")
			}
		})
	}
}

func TestDeliverResumesAndReleasesTheHoldWhenTheComposerClears(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	frame := WireFrame{ID: "tx_guard000002", Agent: "alice", Envelope: "<transit/>"}
	if code, _, _ := rig.daemon.deliver(context.Background(), frame); code != "draft_busy" {
		t.Fatalf("first attempt = %q, want draft_busy", code)
	}

	rig.setScreen(readScreenFixture(t, "omp-empty.txt"))
	if code, _, err := rig.daemon.deliver(context.Background(), frame); code != "" || err != nil {
		t.Fatalf("second attempt = %q, %v; want delivery once the composer cleared", code, err)
	}
	prompts, _, notices := rig.snapshot()
	if len(prompts) != 1 || prompts[0] != "<transit/>" {
		t.Fatalf("prompts after the composer cleared = %#v", prompts)
	}
	if notices != 1 {
		t.Fatalf("notifications = %d, want one for the whole hold", notices)
	}
	if holds := rig.daemon.draftHolds(); len(holds) != 0 {
		t.Fatalf("draft holds survived delivery: %#v", holds)
	}
	if !rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("resumed delivery was not archived")
	}
}

// A held delivery costs the Worker an alarm per retry out of a 120-per-hour
// host budget, so the composer is watched here and the release is what nudges
// the Worker.
func TestHeldPaneIsWatchedUntilTheComposerClears(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	frame := WireFrame{ID: "tx_guard000008", Agent: "alice", Envelope: "<transit/>"}
	if code, _, _ := rig.daemon.deliver(context.Background(), frame); code != "draft_busy" {
		t.Fatalf("first attempt = %q, want draft_busy", code)
	}

	if rig.daemon.releaseClearedHolds(context.Background()) {
		t.Fatal("hold released while the draft was still on screen")
	}
	if holds := rig.daemon.draftHolds(); len(holds) != 1 {
		t.Fatalf("draft holds = %#v, want the hold kept", holds)
	}

	rig.setScreen(readScreenFixture(t, "omp-empty.txt"))
	if !rig.daemon.releaseClearedHolds(context.Background()) {
		t.Fatal("cleared composer did not release the hold")
	}
	if holds := rig.daemon.draftHolds(); len(holds) != 0 {
		t.Fatalf("draft holds after release = %#v", holds)
	}
}

// A stalled paste sits unsent in the composer and reads exactly like a draft.
// Holding a delivery behind its own paste would wedge it forever, so the guard
// asks whose text it is, not merely whether text is there.
func TestDeliverIsNotHeldBehindItsOwnPaste(t *testing.T) {
	for _, test := range []struct {
		screen   string
		envelope string
	}{
		{"omp-paste-chip.txt", "chip.txt"},
		{"omp-paste-rendered.txt", "rendered.txt"},
	} {
		t.Run(test.screen, func(t *testing.T) {
			rig := newGuardRig(t, "omp", readScreenFixture(t, test.screen))
			frame := WireFrame{
				ID: "tx_guard000003", Agent: "alice",
				Envelope: readEnvelopeFixture(t, test.envelope),
			}
			if code, _, err := rig.daemon.deliver(context.Background(), frame); code != "" || err != nil {
				t.Fatalf("deliver against its own unsent paste = %q, %v; want delivery", code, err)
			}
			if prompts, _, _ := rig.snapshot(); len(prompts) != 1 {
				t.Fatalf("prompts = %#v, want one", prompts)
			}
		})
	}
}

// Someone who starts typing while Transit's paste is landing must not have
// their draft submitted by the recovery Enter.
func TestStallRecoveryRefusesEnterOnceAPersonHasTyped(t *testing.T) {
	for _, test := range []struct {
		screen   string
		envelope string
	}{
		{"omp-paste-chip-draft.txt", "chip.txt"},
		{"omp-paste-rendered-draft.txt", "rendered.txt"},
	} {
		t.Run(test.screen, func(t *testing.T) {
			rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
			rig.stall = true
			rig.onStall = readScreenFixture(t, test.screen)
			frame := WireFrame{
				ID: "tx_guard000004", Agent: "alice",
				Envelope: readEnvelopeFixture(t, test.envelope),
			}

			code, retryable, err := rig.daemon.deliver(context.Background(), frame)
			if code != "draft_busy" || !retryable || err == nil {
				t.Fatalf("stall recovery over a person's draft = %q retryable=%t err=%v, want a draft_busy hold",
					code, retryable, err)
			}
			if _, keys, _ := rig.snapshot(); len(keys) != 0 {
				t.Fatalf("recovery pressed keys into a draft: %#v", keys)
			}
			if rig.daemon.store.IncomingRecorded(frame.ID) {
				t.Fatal("a refused recovery was archived as delivered")
			}
		})
	}
}

func TestStallRecoverySubmitsItsOwnPaste(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	rig.stall = true
	rig.onStall = readScreenFixture(t, "omp-paste-chip.txt")
	frame := WireFrame{
		ID: "tx_guard000005", Agent: "alice",
		Envelope: readEnvelopeFixture(t, "chip.txt"),
	}

	if code, _, err := rig.daemon.deliver(context.Background(), frame); code != "" || err != nil {
		t.Fatalf("stall recovery for its own paste = %q, %v; want delivery", code, err)
	}
	_, keys, _ := rig.snapshot()
	if len(keys) != 1 || keys[0] != "Enter" {
		t.Fatalf("recovery keys = %#v, want a single Enter", keys)
	}
	if !rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("recovered delivery was not archived")
	}
}

func TestDraftGuardOffDeliversIntoADraft(t *testing.T) {
	t.Setenv("TRANSIT_DRAFT_GUARD", "0")
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	frame := WireFrame{ID: "tx_guard000006", Agent: "alice", Envelope: "<transit/>"}
	if code, _, err := rig.daemon.deliver(context.Background(), frame); code != "" || err != nil {
		t.Fatalf("deliver with the guard off = %q, %v; want delivery", code, err)
	}
	if prompts, _, _ := rig.snapshot(); len(prompts) != 1 {
		t.Fatalf("prompts with the guard off = %#v", prompts)
	}
	if holds := rig.daemon.draftHolds(); len(holds) != 0 {
		t.Fatalf("guard off still recorded holds: %#v", holds)
	}
}

// An unfamiliar harness, or a screen with no composer this build can read,
// delivers exactly as it did before the guard: starving a durable queue is
// worse than the clobber the guard prevents.
func TestDeliverFailsOpenWithoutAReadableComposer(t *testing.T) {
	for _, test := range []struct {
		kind    string
		fixture string
	}{
		{"codex", "omp-draft.txt"},
		{"claude", "shell.txt"},
	} {
		t.Run(test.kind+"/"+test.fixture, func(t *testing.T) {
			rig := newGuardRig(t, test.kind, readScreenFixture(t, test.fixture))
			frame := WireFrame{ID: "tx_guard000007", Agent: "alice", Envelope: "<transit/>"}
			if code, _, err := rig.daemon.deliver(context.Background(), frame); code != "" || err != nil {
				t.Fatalf("deliver with an unreadable composer = %q, %v; want delivery", code, err)
			}
			if prompts, _, _ := rig.snapshot(); len(prompts) != 1 {
				t.Fatalf("prompts = %#v, want one", prompts)
			}
		})
	}
}
