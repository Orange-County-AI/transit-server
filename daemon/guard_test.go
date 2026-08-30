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
	daemon          *Daemon
	agent           HerdrAgent
	mu              sync.Mutex
	screen          string
	onStall         string
	stall           bool
	promptError     *HerdrAPIError
	moveSeqOnPrompt bool
	seq             uint64
	prompts         []string
	keys            []string
	notices         int
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
			// Herdr answers for the pane it knows and nothing else. The fake
			// used to answer for any target, which made an adapter pointing at
			// a pane this box has never seen look perfectly readable.
			target, _ := params["target"].(string)
			if target != agent.Name && target != agent.PaneID {
				return nil, &HerdrAPIError{Code: "agent_not_found", Message: target}
			}
			return map[string]any{"type": "agent_info", "agent": agent}, nil
		case "pane.read":
			return map[string]any{"type": "pane_read", "read": map[string]any{"text": rig.screen}}, nil
		case "agent.prompt":
			text, _ := params["text"].(string)
			rig.prompts = append(rig.prompts, text)
			if rig.moveSeqOnPrompt {
				rig.seq++
			}
			if rig.promptError != nil {
				return nil, rig.promptError
			}
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

// withTranscript points the rig's agent at a session file, which is what Herdr
// reports for a real pane and what proves a harness read a delivery.
func (rig *guardRig) withTranscript(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	rig.mu.Lock()
	rig.agent.Session.Kind = "path"
	rig.agent.Session.Value = path
	rig.mu.Unlock()
	rig.daemon.herdrAgents = []HerdrAgent{rig.agent}
	return path
}

// The state-change proof is empty for an agent that was already working when
// the envelope arrived — every busy pane — so a coded timeout on a delivery
// that landed was still reported failed and the Worker sent it again. The
// transcript is what settles it.
func TestDeliverAcksALandedPromptForAnAlreadyWorkingAgent(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	frame := WireFrame{ID: "tx_guard000011", Agent: "alice", Envelope: "<transit id=\"tx_guard000011\"/>"}
	rig.withTranscript(t, "{\"text\":\"<transit id=\\\"tx_guard000011\\\"/>\"}\n")
	rig.promptError = &HerdrAPIError{Code: "timeout", Message: "agent did not settle within 30000ms"}
	// No state change at all: the agent was busy before and stayed busy.
	rig.moveSeqOnPrompt = false

	if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
		t.Fatalf("deliver = %q, %v; want an ack proven by the transcript", code, err)
	}
	if !rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("a landed delivery was not archived, so the Worker would send it again")
	}
}

// A transcript that does not mention the id is not evidence, whatever the
// agent's status did.
func TestDeliverNaksWhenTheTranscriptLacksTheDelivery(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	rig.withTranscript(t, "{\"text\":\"an unrelated turn\"}\n")
	rig.promptError = &HerdrAPIError{Code: "timeout", Message: "agent did not settle within 30000ms"}
	frame := WireFrame{ID: "tx_guard000012", Agent: "alice", Envelope: "<transit id=\"tx_guard000012\"/>"}

	code, retryable, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
	if code != "timeout" || !retryable || err == nil {
		t.Fatalf("deliver = %q retryable=%t err=%v, want a retryable timeout", code, retryable, err)
	}
	if rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("an unproven delivery was archived")
	}
}

// A redelivery of something the pane already read must not be typed again, even
// when this daemon has no archive of it — a lost ack is exactly the case where
// the Worker sends it back.
func TestRedeliveryAlreadyInTheTranscriptIsNotRepasted(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	frame := WireFrame{ID: "tx_guard000013", Agent: "alice", Envelope: "<transit id=\"tx_guard000013\"/>"}
	rig.withTranscript(t, "{\"text\":\"<transit id=\\\"tx_guard000013\\\"/>\"}\n")

	if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
		t.Fatalf("redelivery = %q, %v; want a silent ack", code, err)
	}
	if prompts, keys, _ := rig.snapshot(); len(prompts) != 0 || len(keys) != 0 {
		t.Fatalf("re-injected a message the pane had already read: prompts=%#v keys=%#v", prompts, keys)
	}
	if !rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("the settled redelivery was not archived")
	}
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

			code, retryable, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
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
	if code, _, _ := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "draft_busy" {
		t.Fatalf("first attempt = %q, want draft_busy", code)
	}

	rig.setScreen(readScreenFixture(t, "omp-empty.txt"))
	if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
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
	if code, _, _ := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "draft_busy" {
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
// It is neither held behind itself nor typed a second time: it is submitted,
// because a second copy is how a stalled delivery used to accumulate in
// someone's composer.
func TestStrandedPasteIsSubmittedNotRepasted(t *testing.T) {
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
			if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
				t.Fatalf("deliver against its own unsent paste = %q, %v; want delivery", code, err)
			}
			prompts, keys, _ := rig.snapshot()
			if len(prompts) != 0 {
				t.Fatalf("pasted a second copy on top of its own paste: %#v", prompts)
			}
			if len(keys) != 1 || keys[0] != "Enter" {
				t.Fatalf("keys = %#v, want a single Enter submitting the stranded paste", keys)
			}
			if !rig.daemon.store.IncomingRecorded(frame.ID) {
				t.Fatal("submitted delivery was not archived")
			}
		})
	}
}

// Once Transit's bytes are in the composer the only exits are to submit them or
// to delete text we do not own. Vetoing the Enter was worse than either horn:
// the message never arrived, the person's input stayed corrupted, and each
// retry pasted another copy. So the recovery submits and says so.
func TestStallRecoverySubmitsAndOwnsUpWhenAPersonHadTyped(t *testing.T) {
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

			if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
				t.Fatalf("stall recovery = %q, %v; want the paste submitted rather than abandoned", code, err)
			}
			_, keys, notices := rig.snapshot()
			if len(keys) != 1 || keys[0] != "Enter" {
				t.Fatalf("recovery keys = %#v, want a single Enter", keys)
			}
			if notices != 1 {
				t.Fatalf("notifications = %d, want one telling the person their draft was sent too", notices)
			}
			if !rig.daemon.store.IncomingRecorded(frame.ID) {
				t.Fatal("submitted delivery was not archived")
			}
		})
	}
}

// Herdr reports a coded `timeout` when its wait outlives the agent's turn. The
// envelope did land, so reporting failure made the Worker redeliver it and the
// agent read the same message twice.
func TestDeliverAcksAPromptThatLandedDespiteACodedFailure(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	rig.promptError = &HerdrAPIError{Code: "timeout", Message: "agent did not settle within 30000ms"}
	rig.moveSeqOnPrompt = true
	frame := WireFrame{ID: "tx_guard000009", Agent: "alice", Envelope: "<transit/>"}

	if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
		t.Fatalf("deliver after a coded timeout on a turn that started = %q, %v; want an ack", code, err)
	}
	if !rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("a landed delivery was not archived, so the Worker would redeliver it")
	}
}

// The same coded failure with no evidence the agent moved is a real failure.
func TestDeliverNaksACodedFailureWithNoEvidence(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	rig.promptError = &HerdrAPIError{Code: "timeout", Message: "agent did not settle within 30000ms"}
	frame := WireFrame{ID: "tx_guard000010", Agent: "alice", Envelope: "<transit/>"}

	code, retryable, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
	if code != "timeout" || !retryable || err == nil {
		t.Fatalf("deliver = %q retryable=%t err=%v, want a retryable timeout", code, retryable, err)
	}
	if rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("an unproven delivery was archived")
	}
}

func TestDraftGuardOffDeliversIntoADraft(t *testing.T) {
	t.Setenv("TRANSIT_DRAFT_GUARD", "0")
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	frame := WireFrame{ID: "tx_guard000006", Agent: "alice", Envelope: "<transit/>"}
	if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
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
			if code, _, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame); code != "" || err != nil {
				t.Fatalf("deliver with an unreadable composer = %q, %v; want delivery", code, err)
			}
			if prompts, _, _ := rig.snapshot(); len(prompts) != 1 {
				t.Fatalf("prompts = %#v, want one", prompts)
			}
		})
	}
}

// The native adapter path used to skip the composer check entirely, on the
// assumption that injecting is gentler than typing. Measured on 2026-08-23 it
// is not: an injection landing while a person had unsent input DISCARDED that
// input silently. `require` mode makes this the only path a fleet agent has,
// so the guard has to cover it or it covers almost nothing.
func TestNativeDeliveryHoldsWhileAPersonIsComposing(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	registerAdapterDirect(t, rig.daemon, agentFrame{
		T: "register", Proto: agentProtocol, Harness: "omp",
		SessionID: "01a02b49-b517-7000-a194-7a928f701e18", Name: "alice", Status: "idle",
	})
	if rig.daemon.nativeAdapterByName(defaultEnrollment, "alice") == nil {
		t.Fatal("adapter did not register; the test would pass for the wrong reason")
	}

	frame := WireFrame{ID: "tx_guard000002", Agent: "alice", Envelope: "<transit/>"}
	code, retryable, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
	if code != "draft_busy" || !retryable || err == nil {
		t.Fatalf("native deliver into a draft = %q retryable=%t err=%v, want a retryable draft_busy hold",
			code, retryable, err)
	}
	// The person's pane must be untouched: no prompt, no keys, and crucially
	// no injection, which is the thing that ate the draft.
	prompts, keys, _ := rig.snapshot()
	if len(prompts) != 0 || len(keys) != 0 {
		t.Fatalf("held native delivery touched the pane: prompts=%#v keys=%#v", prompts, keys)
	}
	if rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("held delivery was recorded as received")
	}
}

// An adapter with no Herdr pane cannot be checked, and must still deliver:
// the guard is one-sided and fail-open, and a headless adapter starving its
// queue would be a worse bug than the one being fixed.
func TestNativeDeliveryProceedsWithoutAPane(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	adapter := registerAdapterDirect(t, rig.daemon, agentFrame{
		T: "register", Proto: agentProtocol, Harness: "omp",
		SessionID: "01a02b49-b517-7000-a194-7a928f701e18", Name: "headless", Status: "idle",
	})
	// Close the socket so the injection fails immediately instead of waiting
	// out the ack timeout: what matters here is which branch was taken, not
	// that an absent adapter eventually times out.
	_ = adapter.connection.Close()
	frame := WireFrame{ID: "tx_guard000003", Agent: "headless", Envelope: "<transit/>"}
	code, _, _ := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
	if code == "draft_busy" {
		t.Fatal("an adapter with no pane was held on another agent's draft")
	}
}

// The hole the native guard actually had. The guard looked its pane up by the
// transit agent name, but a transit name is claimed independently of the pane's
// Herdr name, so a session addressed as anything other than its pane's name
// missed, fell through to "no pane", and was injected into on top of a person's
// keystrokes. The adapter declares its real pane at registration; that is what
// the guard reads now.
func TestNativeDeliveryHoldsOnItsRegisteredPaneUnderADifferentName(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-draft.txt"))
	adapter := registerAdapterDirect(t, rig.daemon, agentFrame{
		T: "register", Proto: agentProtocol, Harness: "omp",
		SessionID: "01a02b49-b517-7000-a194-7a928f701e18", Name: "courier",
		PaneID: "titan:p1", Status: "idle",
	})
	// Without this the test could pass because the adapter adopted the pane's
	// name, which is the case that already worked.
	if adapter.name != "courier" || adapter.paneID != "titan:p1" {
		t.Fatalf("adapter registered as %q in pane %q, want courier in titan:p1", adapter.name, adapter.paneID)
	}
	if _, found := rig.daemon.localAgentByName("courier"); found {
		t.Fatal("a Herdr agent answers to courier; the old name lookup would have worked and the test proves nothing")
	}

	frame := WireFrame{ID: "tx_guard000014", Agent: "courier", Envelope: "<transit/>"}
	code, retryable, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
	if code != "draft_busy" || !retryable || err == nil {
		t.Fatalf("native deliver into a draft = %q retryable=%t err=%v, want a retryable draft_busy hold",
			code, retryable, err)
	}
	if prompts, keys, _ := rig.snapshot(); len(prompts) != 0 || len(keys) != 0 {
		t.Fatalf("held native delivery touched the pane: prompts=%#v keys=%#v", prompts, keys)
	}
	holds := rig.daemon.draftHolds()
	if len(holds) != 1 || holds[0].PaneID != "titan:p1" {
		t.Fatalf("draft holds = %#v, want one on the adapter's declared pane", holds)
	}
	if rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("held delivery was recorded as received")
	}
}

// An adapter that declares a pane this daemon cannot read is not the same fact
// as an adapter with no pane, and the guard used to spell them the same way.
// A declared pane means a person may be typing into it right now, so the
// delivery waits — as a hold, which keeps the entry's attempt count — rather
// than being injected on a guess. The screen here is empty on purpose: a
// readable pane would deliver, so only the unreadable pane can produce the hold.
func TestNativeDeliveryWaitsWhenItsDeclaredPaneCannotBeRead(t *testing.T) {
	rig := newGuardRig(t, "omp", readScreenFixture(t, "omp-empty.txt"))
	adapter := registerAdapterDirect(t, rig.daemon, agentFrame{
		T: "register", Proto: agentProtocol, Harness: "omp",
		SessionID: "01a02b49-b517-7000-a194-7a928f701e18", Name: "stranger",
		PaneID: "titan:gone", Status: "idle",
	})
	// Closed so a fall-through to injection fails fast and loudly instead of
	// blocking on the ack: what matters is which branch was taken.
	_ = adapter.connection.Close()

	frame := WireFrame{ID: "tx_guard000015", Agent: "stranger", Envelope: "<transit/>"}
	code, retryable, err := rig.daemon.deliver(context.Background(), rig.daemon.defaultEnrollmentRuntime(), frame)
	if code != "draft_busy" || !retryable || err == nil {
		t.Fatalf("native deliver to an unreadable pane = %q retryable=%t err=%v, want a retryable draft_busy hold",
			code, retryable, err)
	}
	// No pane to watch means no hold to record: releasing it is the Worker's
	// backstop alarm and the next roster snapshot, not the hold poller.
	if holds := rig.daemon.draftHolds(); len(holds) != 0 {
		t.Fatalf("recorded a hold on a pane nothing can poll: %#v", holds)
	}
	if rig.daemon.store.IncomingRecorded(frame.ID) {
		t.Fatal("held delivery was recorded as received")
	}
}
