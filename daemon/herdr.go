package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const herdrSocketIOTimeout = 30 * time.Second
const promptTimeout = 30 * time.Second

type HerdrAgent struct {
	Name           string `json:"name"`
	Kind           string `json:"agent"`
	Status         string `json:"agent_status"`
	PaneID         string `json:"pane_id"`
	CWD            string `json:"cwd"`
	Title          string `json:"terminal_title_stripped"`
	LaunchPending  bool   `json:"launch_pending"`
	StateChangeSeq uint64 `json:"state_change_seq"`
	Session        struct {
		Kind  string `json:"kind"`
		Value string `json:"value"`
	} `json:"agent_session"`
}

// SessionTranscript is the harness session file Herdr reports for this pane,
// when it reports one as a path. It is the only local artefact that proves a
// harness accepted a delivery.
func (a HerdrAgent) SessionTranscript() string {
	if a.Session.Kind != "path" {
		return ""
	}
	return a.Session.Value
}

type PromptResult struct {
	OK      bool
	Blocked bool
	Code    string
	Error   string
}

type HerdrDriver interface {
	Ping(context.Context) (string, int, error)
	ListAgents(context.Context) ([]HerdrAgent, error)
	GetAgent(context.Context, string) (*HerdrAgent, error)
	PaneScreen(context.Context, string) (string, error)
	PromptAgent(context.Context, string, string, time.Duration) PromptResult
	SubmitPaste(context.Context, string, string, time.Duration) PromptResult
	Rename(context.Context, string, string) (*HerdrAgent, error)
	Notify(context.Context, string, string) error
}

type herdrRequest struct {
	ID     string `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params"`
}

type herdrResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *HerdrAPIError  `json:"error"`
}

type HerdrAPIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *HerdrAPIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	return "unknown herdr API error"
}

type herdrSocket struct {
	path              string
	logf              func(string)
	acceptedProtocols map[int]struct{}
	stallPollAttempts int
	stallPollInterval time.Duration
	mu                sync.Mutex
	nextID            uint64
	loggedProtocol    bool
}

func newHerdrSocket(path string, logf func(string)) *herdrSocket {
	if logf == nil {
		logf = func(message string) { log.Print(message) }
	}
	accepted := map[int]struct{}{19: {}, 20: {}}
	if override := strings.TrimSpace(os.Getenv("TRANSIT_HERDR_PROTOCOL_ALLOW")); override != "" {
		accepted = make(map[int]struct{})
		for _, part := range strings.Split(override, ",") {
			protocol, err := strconv.Atoi(strings.TrimSpace(part))
			if err == nil && protocol >= 0 {
				accepted[protocol] = struct{}{}
			}
		}
	}
	return &herdrSocket{
		path: path, logf: logf, acceptedProtocols: accepted,
		stallPollAttempts: 15, stallPollInterval: time.Second,
	}
}

func (d *herdrSocket) Ping(ctx context.Context) (string, int, error) {
	ctx, cancel := context.WithTimeout(ctx, herdrSocketIOTimeout)
	defer cancel()
	return d.ping(ctx)
}

func (d *herdrSocket) ListAgents(ctx context.Context) ([]HerdrAgent, error) {
	raw, err := d.call(ctx, "agent.list", struct{}{})
	if err != nil {
		return nil, err
	}
	var result struct {
		Type   string       `json:"type"`
		Agents []HerdrAgent `json:"agents"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode herdr agent.list: %w", err)
	}
	if result.Type != "agent_list" || result.Agents == nil {
		return nil, fmt.Errorf("unexpected herdr agent.list response")
	}
	return result.Agents, nil
}

func (d *herdrSocket) GetAgent(ctx context.Context, target string) (*HerdrAgent, error) {
	raw, err := d.call(ctx, "agent.get", map[string]any{"target": target})
	if err != nil {
		var apiError *HerdrAPIError
		if errors.As(err, &apiError) && apiError.Code == "agent_not_found" {
			return nil, nil
		}
		return nil, err
	}
	return decodeHerdrAgent(raw, "agent_info")
}

func (d *herdrSocket) PaneScreen(ctx context.Context, paneID string) (string, error) {
	raw, err := d.call(ctx, "pane.read", map[string]any{
		"pane_id": paneID, "source": "visible", "format": "text", "strip_ansi": true,
	})
	if err != nil {
		return "", err
	}
	var result struct {
		Type string `json:"type"`
		Read *struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if result.Type != "pane_read" || result.Read == nil {
		return "", fmt.Errorf("unexpected pane.read response")
	}
	return result.Read.Text, nil
}

func (d *herdrSocket) PromptAgent(ctx context.Context, target, text string, timeout time.Duration) PromptResult {
	if timeout <= 0 {
		timeout = promptTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	params := map[string]any{
		"target": target,
		"text":   text,
		"wait": map[string]any{
			"until":      []string{"idle", "done", "blocked"},
			"timeout_ms": timeout.Milliseconds(),
		},
	}
	raw, err := d.call(callCtx, "agent.prompt", params)
	if err != nil {
		var apiError *HerdrAPIError
		if errors.As(err, &apiError) && apiError.Code == "agent_prompt_stalled" {
			if result, definitive := d.flushPastedPrompt(callCtx, target, text, timeout); definitive {
				return result
			}
		}
		return promptFailure(err)
	}
	agent, err := decodeHerdrAgent(raw, "agent_prompted")
	if err != nil {
		return PromptResult{Error: err.Error()}
	}
	return PromptResult{OK: true, Blocked: agent.Status == "blocked"}
}

// SubmitPaste submits a paste this daemon already left in the composer instead
// of typing the envelope a second time. Without it, a delivery that stalled and
// stayed unsent accumulated a fresh copy on every retry.
func (d *herdrSocket) SubmitPaste(ctx context.Context, target, text string, timeout time.Duration) PromptResult {
	if timeout <= 0 {
		timeout = promptTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	result, definitive := d.flushPastedPrompt(callCtx, target, text, timeout)
	if !definitive {
		return PromptResult{Code: "paste_submit_unproven", Error: "the pasted envelope was not submitted"}
	}
	return result
}

func promptFailure(err error) PromptResult {
	var apiError *HerdrAPIError
	if errors.As(err, &apiError) {
		return PromptResult{Code: apiError.Code, Error: apiError.Error()}
	}
	return PromptResult{Error: err.Error()}
}

// flushPastedPrompt recovers a paste that Herdr's submit key did not send: a
// large envelope collapses into an OMP attachment chip, and the collapse
// absorbs the key, so the envelope sits unsent in the composer.
//
// The Enter always goes. Vetoing it when a person had typed alongside the
// paste was worse than either alternative it was choosing between: the message
// never arrived, the person's input stayed corrupted by our bytes, and every
// retry pasted another copy on top. Our bytes are already in their composer by
// this point, and the only ways out are to submit them or to delete text we do
// not own. So we submit, and we say so when their own unsent text went along
// with it. Holding before the paste (deliver.go) remains the real protection.
//
// Accepting the key proves nothing though: only a moved state_change_seq
// proves the agent took the prompt, so every failed precondition reports false
// and leaves the original stall standing.
func (d *herdrSocket) flushPastedPrompt(ctx context.Context, target, text string, timeout time.Duration) (PromptResult, bool) {
	agent, err := d.GetAgent(ctx, target)
	if err != nil || agent == nil || agent.PaneID == "" {
		return PromptResult{}, false
	}
	if screen, screenErr := d.PaneScreen(ctx, agent.PaneID); screenErr == nil {
		content, located := composerContent(agent.Kind, screen)
		if located && !composerHoldsOnlyPaste(content, text) {
			_ = d.Notify(ctx, "transit: your draft was sent with a message",
				"a delivery landed in the composer while you were typing, and both were submitted")
		}
	}
	before := agent.StateChangeSeq
	if _, err := d.call(ctx, "pane.send_keys", map[string]any{"pane_id": agent.PaneID, "keys": []string{"Enter"}}); err != nil {
		return PromptResult{}, false
	}
	moved := false
	for range d.stallPollAttempts {
		timer := time.NewTimer(d.stallPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return PromptResult{}, false
		case <-timer.C:
		}
		current, err := d.GetAgent(ctx, target)
		if err != nil || current == nil {
			return PromptResult{}, false
		}
		if current.StateChangeSeq != before {
			moved = true
			break
		}
	}
	if !moved {
		return PromptResult{}, false
	}
	raw, err := d.call(ctx, "agent.wait", map[string]any{
		"target": target, "until": []string{"idle", "done", "blocked"}, "timeout_ms": timeout.Milliseconds(),
	})
	if err != nil {
		return promptFailure(err), true
	}
	settled, err := decodeHerdrAgent(raw, "agent_info")
	if err != nil {
		return PromptResult{Error: err.Error()}, true
	}
	return PromptResult{OK: true, Blocked: settled.Status == "blocked"}, true
}

func (d *herdrSocket) Rename(ctx context.Context, target, name string) (*HerdrAgent, error) {
	raw, err := d.call(ctx, "agent.rename", map[string]any{"target": target, "name": name})
	if err != nil {
		return nil, err
	}
	return decodeHerdrAgent(raw, "agent_info")
}

func (d *herdrSocket) Notify(ctx context.Context, title, body string) error {
	_, err := d.call(ctx, "notification.show", map[string]any{
		"title": title, "body": body, "sound": "none",
	})
	return err
}

func (d *herdrSocket) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, herdrSocketIOTimeout)
	defer cancel()
	if _, _, err := d.ping(ctx); err != nil {
		return nil, err
	}
	response, err := d.exchange(ctx, method, params)
	if err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, response.Error
	}
	return response.Result, nil
}

func (d *herdrSocket) ping(ctx context.Context) (string, int, error) {
	response, err := d.exchange(ctx, "ping", struct{}{})
	if err != nil {
		return "", 0, err
	}
	if response.Error != nil {
		return "", 0, response.Error
	}
	var pong struct {
		Type     string `json:"type"`
		Version  string `json:"version"`
		Protocol int    `json:"protocol"`
	}
	if err := json.Unmarshal(response.Result, &pong); err != nil {
		return "", 0, err
	}
	if pong.Type != "pong" {
		return "", 0, fmt.Errorf("unexpected herdr ping response")
	}
	if _, accepted := d.acceptedProtocols[pong.Protocol]; !accepted {
		return "", 0, fmt.Errorf("herdr protocol %d not accepted (accepted: %s)", pong.Protocol, d.acceptedProtocolString())
	}
	d.mu.Lock()
	logProtocol := !d.loggedProtocol
	d.loggedProtocol = true
	d.mu.Unlock()
	if logProtocol {
		d.logf(fmt.Sprintf("herdr protocol %d accepted", pong.Protocol))
	}
	return pong.Version, pong.Protocol, nil
}

func (d *herdrSocket) exchange(ctx context.Context, method string, params any) (herdrResponse, error) {
	var dialer net.Dialer
	connection, err := dialer.DialContext(ctx, "unix", d.path)
	if err != nil {
		return herdrResponse{}, err
	}
	defer connection.Close()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(herdrSocketIOTimeout)
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return herdrResponse{}, err
	}
	d.mu.Lock()
	d.nextID++
	id := fmt.Sprintf("req_%d", d.nextID)
	d.mu.Unlock()
	if err := json.NewEncoder(connection).Encode(herdrRequest{ID: id, Method: method, Params: params}); err != nil {
		return herdrResponse{}, err
	}
	var response herdrResponse
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return herdrResponse{}, err
	}
	if response.ID != id {
		return herdrResponse{}, fmt.Errorf("herdr response id mismatch")
	}
	if response.Error == nil && len(response.Result) == 0 {
		return herdrResponse{}, fmt.Errorf("herdr response has no result or error")
	}
	return response, nil
}

func (d *herdrSocket) acceptedProtocolString() string {
	protocols := make([]int, 0, len(d.acceptedProtocols))
	for protocol := range d.acceptedProtocols {
		protocols = append(protocols, protocol)
	}
	sort.Ints(protocols)
	parts := make([]string, len(protocols))
	for index, protocol := range protocols {
		parts[index] = strconv.Itoa(protocol)
	}
	return strings.Join(parts, ", ")
}

func decodeHerdrAgent(raw json.RawMessage, allowedType string) (*HerdrAgent, error) {
	var result struct {
		Type  string      `json:"type"`
		Agent *HerdrAgent `json:"agent"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	if result.Type != allowedType || result.Agent == nil {
		return nil, fmt.Errorf("unexpected herdr agent response %q", result.Type)
	}
	return result.Agent, nil
}
