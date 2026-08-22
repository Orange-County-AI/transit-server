package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

type ComposerState int

const (
	ComposerUnknown ComposerState = iota
	ComposerEmpty
	ComposerDraft
)

func DetectComposer(agentKind, screen string) ComposerState {
	if strings.TrimSpace(screen) == "" {
		return ComposerUnknown
	}
	switch strings.ToLower(strings.TrimSpace(agentKind)) {
	case "omp", "pi":
		return detectOMPComposer(screen)
	case "claude":
		return detectClaudeComposer(screen)
	default:
		return ComposerUnknown
	}
}

func detectOMPComposer(screen string) ComposerState {
	lines := strings.Split(screen, "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		trimmed := strings.TrimRight(lines[index], " \t\r")
		interior, ok := strings.CutPrefix(trimmed, "╰─")
		if !ok {
			continue
		}
		interior, ok = strings.CutSuffix(interior, "─╯")
		if !ok || !strings.HasPrefix(interior, " ") {
			continue
		}
		if strings.TrimSpace(interior) != "" {
			return ComposerDraft
		}
		for above := index - 1; above >= 0; above-- {
			body := strings.TrimRight(lines[above], " \t\r")
			body, ok = strings.CutPrefix(body, "│")
			if !ok {
				break
			}
			body, ok = strings.CutSuffix(body, "│")
			if !ok {
				break
			}
			if strings.TrimSpace(body) != "" {
				return ComposerDraft
			}
		}
		return ComposerEmpty
	}
	return ComposerUnknown
}

func detectClaudeComposer(screen string) ComposerState {
	lines := strings.Split(screen, "\n")
	for index := len(lines) - 1; index >= 1; index-- {
		text, ok := strings.CutPrefix(strings.TrimSpace(lines[index]), "❯")
		if !ok || !claudeComposerRule(lines[index-1]) {
			continue
		}
		if strings.TrimSpace(text) != "" {
			return ComposerDraft
		}
		for below := index + 1; below < len(lines); below++ {
			row := strings.TrimSpace(lines[below])
			if claudeComposerRule(row) {
				break
			}
			if row != "" {
				return ComposerDraft
			}
		}
		return ComposerEmpty
	}
	return ComposerUnknown
}

func claudeComposerRule(line string) bool {
	trimmed := strings.TrimSpace(line)
	if len([]rune(trimmed)) < 8 {
		return false
	}
	for _, glyph := range trimmed {
		if glyph != '─' {
			return false
		}
	}
	return true
}

func draftGuardEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("TRANSIT_DRAFT_GUARD")))
	return value != "0" && value != "false"
}

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
	if strings.HasPrefix(frame.ID, "tx_") && d.store.HistoryExists(frame.ID) {
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
		code, retryable, err := d.deliverNative(ctx, adapter, frame.ID, frame.Envelope)
		if err != nil {
			return code, retryable, err
		}
		if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
			return "history_write_failed", true, err
		}
		return "", false, nil
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

	if draftGuardEnabled() {
		screen, screenErr := d.herdr.PaneScreen(ctx, agent.PaneID)
		if screenErr == nil && DetectComposer(agent.Kind, screen) == ComposerDraft {
			d.mu.Lock()
			firstHold := !d.holds[agent.PaneID]
			d.holds[agent.PaneID] = true
			d.mu.Unlock()
			if firstHold {
				_ = d.herdr.Notify(ctx, "transit: message waiting", "delivery held until your composer is clear")
			}
			return "draft_busy", true, fmt.Errorf("agent composer is not empty")
		}
	}
	d.mu.Lock()
	delete(d.holds, agent.PaneID)
	d.mu.Unlock()

	before := agent.StateChangeSeq
	result := d.herdr.PromptAgent(ctx, agent.Name, frame.Envelope, promptTimeout)
	if result.OK {
		if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
			return "history_write_failed", true, err
		}
		return "", false, nil
	}
	if result.Code == "" {
		current, getErr := d.herdr.GetAgent(ctx, agent.Name)
		if getErr == nil && current != nil && current.StateChangeSeq != before {
			if err := d.store.RecordIncoming(frame.ID, frame.Envelope); err != nil {
				return "history_write_failed", true, err
			}
			return "", false, nil
		}
	}
	message := result.Error
	if message == "" {
		message = "agent prompt failed"
	}
	return deliveryFailureCode(result), true, fmt.Errorf("%s", message)
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
