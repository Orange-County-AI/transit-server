package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
)

// holdPollInterval is how often a held pane is re-read. It is only paid while
// something is actually held, and only against the local Herdr socket.
const holdPollInterval = 2 * time.Second

// deliver coalesces concurrent delivery attempts of the same message to the
// same agent. The Worker retries a queued entry on a backoff that starts
// below a legitimate in-flight attempt (an agent.prompt can wait out a full
// agent turn), and each concurrent retry used to type the envelope into the
// terminal a second time while the first attempt was still waiting. A follower
// now adopts the leader's outcome instead of prompting again; sequential
// redeliveries — the unsettled channel banner — are untouched.
func (d *Daemon) deliver(ctx context.Context, frame WireFrame) (code string, retryable bool, err error) {
	key := frame.ID + "\x00" + frame.Agent
	d.mu.Lock()
	if flight, ok := d.inflight[key]; ok {
		flight.waiters++
		d.mu.Unlock()
		select {
		case <-flight.done:
			return flight.code, flight.retryable, flight.err
		case <-ctx.Done():
			return "delivery_canceled", true, ctx.Err()
		}
	}
	flight := &deliveryFlight{done: make(chan struct{})}
	d.inflight[key] = flight
	d.mu.Unlock()

	code, retryable, err = d.deliverOnce(ctx, frame)

	flight.code, flight.retryable, flight.err = code, retryable, err
	close(flight.done)
	d.mu.Lock()
	if d.inflight[key] == flight {
		delete(d.inflight, key)
	}
	d.mu.Unlock()
	return code, retryable, err
}

type deliveryFlight struct {
	done      chan struct{}
	code      string
	retryable bool
	err       error
	waiters   int
}

func (d *Daemon) deliverOnce(ctx context.Context, frame WireFrame) (code string, retryable bool, err error) {
	if strings.HasPrefix(frame.ID, "tx_") && d.store.IncomingRecorded(frame.ID) {
		return "", false, nil
	}
	d.mu.RLock()
	paused := d.paused
	d.mu.RUnlock()
	if paused {
		return "paused", true, fmt.Errorf("delivery paused")
	}
	mode, modeErr := deliveryMode(d.cfg)
	if modeErr != nil {
		return "invalid_delivery_mode", true, modeErr
	}
	if adapter := d.nativeAdapterByName(frame.Agent); adapter != nil && mode != "shadow" {
		// A native injection is not gentler than typing into the pane, it is
		// only quieter: measured twice on 2026-08-23, `pi.sendUserMessage`
		// landing while a person had unsent input DISCARDED that input - not
		// submitted, not preserved, gone, with the agent then reporting the
		// draft untouched. The Herdr path has always checked the composer
		// first; the native path skipped the check because it never types, and
		// `require` mode makes this the only path a fleet agent has. So the
		// same hold runs here, using the pane the adapter's agent occupies.
		// An adapter with no Herdr pane cannot be checked and delivers as
		// before: fail-open matches the guard's existing one-sided contract.
		if draftGuardEnabled() {
			if agent, found := d.localAgentByName(frame.Agent); found && agent.PaneID != "" {
				if d.composerState(ctx, agent, frame.Envelope) == composerForeignDraft {
					hold := draftHold{PaneID: agent.PaneID, Agent: agent.Kind, At: time.Now().UTC()}
					d.applyDraftHold(ctx, hold)
					return "draft_busy", true, fmt.Errorf("%s has unsent input in pane %s", hold.Agent, hold.PaneID)
				}
				d.releaseDraftHold(agent.PaneID)
			}
		}
		code, retryable, err := d.deliverNative(ctx, adapter, frame.ID, frame.Envelope)
		if err != nil {
			return code, retryable, err
		}
		if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
			return "history_write_failed", true, err
		}
		return "", false, nil
	}

	// Past this point delivery means typing into a Herdr pane. Falling through
	// to an empty roster would report `agent_not_found`, which blames the agent
	// for a transport outage; the distinction matters because one is permanent
	// operator error and the other clears by itself.
	if !d.herdrReachable() {
		return "herdr_unavailable", true, fmt.Errorf("herdr is unavailable for %s", frame.Agent)
	}

	agent, found := d.localAgentByName(frame.Agent)
	if !found || agent.PaneID == "" {
		return "agent_not_found", true, fmt.Errorf("agent %s not found", frame.Agent)
	}
	if mode == "require" && nativeHarness(agent.Kind) {
		return "adapter_unavailable", true, fmt.Errorf("native adapter unavailable for %s", agent.Name)
	}
	if agent.LaunchPending {
		return "agent_launch_pending", true, fmt.Errorf("agent %s is launching", frame.Agent)
	}

	// A redelivery of something this pane already read is not worth typing
	// again. The daemon's own archive is the first check, but it misses an ack
	// the Worker never received — a lost ack was how the same envelope came
	// back two and three times — so the harness transcript is asked too.
	if transcript := agent.SessionTranscript(); transcript != "" {
		if found, err := transcriptContains(transcript, frame.ID); err == nil && found {
			if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
				return "history_write_failed", true, err
			}
			return "", false, nil
		}
	}

	stranded := false
	if draftGuardEnabled() {
		switch state := d.composerState(ctx, agent, frame.Envelope); state {
		case composerForeignDraft:
			hold := draftHold{PaneID: agent.PaneID, Agent: agent.Kind, At: time.Now().UTC()}
			d.applyDraftHold(ctx, hold)
			return "draft_busy", true, fmt.Errorf("%s has unsent input in pane %s", hold.Agent, hold.PaneID)
		case composerOwnPaste:
			stranded = true
		}
	}
	d.releaseDraftHold(agent.PaneID)

	before := agent.StateChangeSeq
	// A previous attempt's envelope still sitting unsent is submitted rather
	// than typed again: pasting a second copy is how a stalled delivery used to
	// accumulate in someone's composer.
	prompt := d.herdr.PromptAgent
	if stranded {
		prompt = d.herdr.SubmitPaste
	}
	result := prompt(ctx, agent.Name, frame.Envelope, promptTimeout)
	if result.OK {
		if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
			return "history_write_failed", true, err
		}
		return "", false, nil
	}
	// Ask the harness whether the prompt landed anyway, whatever the failure was
	// called. Herdr answers a coded `timeout` whenever its wait outlives the
	// agent's turn, and a state change proves nothing for an agent that was
	// already working when the envelope arrived — which is every busy pane. The
	// session transcript is the artefact that settles it, exactly as the native
	// adapters use it.
	if d.deliveryLanded(ctx, agent, frame.ID, before) {
		if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
			return "history_write_failed", true, err
		}
		return "", false, nil
	}
	message := result.Error
	if message == "" {
		message = "agent prompt failed"
	}
	return deliveryFailureCode(result), true, fmt.Errorf("%s", message)
}

// deliveryLanded reports whether the harness took this delivery. The delivery
// id travels inside the rendered envelope, so finding it in the pane's session
// transcript is proof the harness read it; a moved state_change_seq is the
// weaker fallback for a harness Herdr reports without a transcript path.
func (d *Daemon) deliveryLanded(ctx context.Context, agent HerdrAgent, id string, before uint64) bool {
	current, err := d.herdr.GetAgent(ctx, agent.Name)
	if err != nil || current == nil {
		return false
	}
	if transcript := current.SessionTranscript(); transcript != "" {
		found, readErr := transcriptContains(transcript, id)
		if readErr == nil {
			return found
		}
	}
	return current.StateChangeSeq != before
}

type composerVerdict int

const (
	// composerClear means nothing this build can read is holding input.
	composerClear composerVerdict = iota
	// composerForeignDraft means text that is not ours is in the composer.
	composerForeignDraft
	// composerOwnPaste means only this delivery's own unsent paste is there.
	composerOwnPaste
)

// composerState judges the target pane. The envelope is part of the question: a
// delivery whose own paste is still sitting unsent must be submitted, not held
// behind itself and not pasted again.
func (d *Daemon) composerState(ctx context.Context, agent HerdrAgent, envelope string) composerVerdict {
	screen, err := d.herdr.PaneScreen(ctx, agent.PaneID)
	if err != nil {
		return composerClear
	}
	content, located := composerContent(agent.Kind, screen)
	if !located || strings.TrimSpace(content) == "" {
		return composerClear
	}
	if composerHoldsOnlyPaste(content, envelope) {
		return composerOwnPaste
	}
	return composerForeignDraft
}

// applyDraftHold records the hold and says so once per pane: a held delivery is
// invisible otherwise, and the person whose draft caused it is the only one who
// can release it.
func (d *Daemon) applyDraftHold(ctx context.Context, hold draftHold) {
	d.mu.Lock()
	_, alreadyHeld := d.holds[hold.PaneID]
	d.holds[hold.PaneID] = hold
	d.mu.Unlock()
	if alreadyHeld {
		return
	}
	d.logf("delivery held — %s has unsent input in pane %s; retrying until the composer is clear",
		hold.Agent, hold.PaneID)
	_ = d.herdr.Notify(ctx, "transit: message waiting", "delivery held until your composer is clear")
}

func (d *Daemon) releaseDraftHold(paneID string) {
	d.mu.Lock()
	delete(d.holds, paneID)
	d.mu.Unlock()
}

// holdLoop ends a hold from the side that can see it. A held delivery stays
// queued in its HostHub, and every Worker-side retry costs one of that host's
// 120 alarms per hour, so polling the composer from the Worker is either slow
// or ruinous — a host whose budget is spent stops retrying every delivery
// until the hour turns over. Reading the pane locally is free, and a roster
// snapshot makes the HostHub dispatch immediately, so the message lands within
// seconds of the composer clearing and the Worker's own retry alarm stays a
// backstop.
func (d *Daemon) holdLoop(ctx context.Context) {
	ticker := time.NewTicker(holdPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if !d.releaseClearedHolds(ctx) {
			continue
		}
		if err := d.sendRoster(ctx); err != nil {
			d.logf("nudge after a released hold: %v", err)
		}
	}
}

// releaseClearedHolds reports whether any pane stopped holding, which is the
// only reason to nudge the Worker.
func (d *Daemon) releaseClearedHolds(ctx context.Context) bool {
	released := false
	for _, hold := range d.draftHolds() {
		if d.holdStillStands(ctx, hold) {
			continue
		}
		d.releaseDraftHold(hold.PaneID)
		released = true
	}
	return released
}

// holdStillStands re-reads a held pane. A cleared or unreadable composer
// releases the hold: the delivery attempt that follows judges the pane again,
// with the envelope in hand, and it is the authority.
func (d *Daemon) holdStillStands(ctx context.Context, hold draftHold) bool {
	screen, err := d.herdr.PaneScreen(ctx, hold.PaneID)
	if err != nil {
		return false
	}
	content, located := composerContent(hold.Agent, screen)
	return located && strings.TrimSpace(content) != ""
}

func (d *Daemon) draftHolds() []draftHold {
	d.mu.RLock()
	defer d.mu.RUnlock()
	holds := make([]draftHold, 0, len(d.holds))
	for _, hold := range d.holds {
		holds = append(holds, hold)
	}
	slices.SortFunc(holds, func(a, b draftHold) int { return strings.Compare(a.PaneID, b.PaneID) })
	return holds
}

func deliveryFailureCode(result PromptResult) string {
	if result.Code != "" {
		return result.Code
	}
	return "agent_prompt_failed"
}

func (d *Daemon) deliverLocal(ctx context.Context, message *OutboxMessage, targetName string) error {
	envelope := RenderEnvelope(EnvelopeInput{
		From: message.From, ID: message.ID, TS: message.TS.UTC().Format(time.RFC3339Nano),
		Kind: "dm", Body: message.Body, ReplyTo: message.ReplyTo,
	})
	code, _, err := d.deliver(ctx, WireFrame{
		T: "deliver", ID: message.ID, Agent: targetName, Envelope: envelope,
	})
	if err != nil {
		return fmt.Errorf("%s: %w", code, err)
	}
	return nil
}

func (d *Daemon) bounce(ctx context.Context, original *OutboxMessage, reason string) {
	name, host, err := parseAgentAddress(original.From)
	if err != nil || host != d.cfg.Host {
		return
	}
	bounce := &OutboxMessage{
		ID: txID(), From: "transit", To: original.From,
		Body: fmt.Sprintf("undeliverable to %s: %s", original.To, reason), TS: time.Now().UTC(),
	}
	envelope := RenderEnvelope(EnvelopeInput{
		From: bounce.From, ID: bounce.ID, TS: bounce.TS.Format(time.RFC3339Nano),
		Kind: "dm", Body: bounce.Body,
	})
	_, _, _ = d.deliver(ctx, WireFrame{T: "deliver", ID: bounce.ID, Agent: name, Envelope: envelope})
}
