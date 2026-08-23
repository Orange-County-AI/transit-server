package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func listenIPC(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("refusing to replace non-socket IPC path %q", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func writeJSONLine(writer io.Writer, value any) error {
	return json.NewEncoder(writer).Encode(value)
}

func serveIPC(ctx context.Context, listener net.Listener, daemon *Daemon) error {
	for {
		connection, err := listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return err
			}
		}
		go daemon.serveIPCConnection(ctx, connection)
	}
}

func (d *Daemon) serveIPCConnection(ctx context.Context, connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(35 * time.Second))
	scanner := bufio.NewScanner(connection)
	scanner.Buffer(make([]byte, 4096), maxWireFrameBytes)
	if !scanner.Scan() {
		return
	}
	var request map[string]any
	if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
		_ = writeJSONLine(connection, failure("bad_request", "invalid JSON request"))
		return
	}
	_ = writeJSONLine(connection, d.handleIPC(ctx, request))
}

func daemonCall(request map[string]any) (map[string]any, error) {
	connection, err := net.DialTimeout("unix", socketPath(), 30*time.Second)
	if err != nil {
		return nil, fmt.Errorf("transit daemon is not running (socket %s): %w", socketPath(), err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(35 * time.Second))
	if err := writeJSONLine(connection, request); err != nil {
		return nil, err
	}
	var response map[string]any
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return nil, err
	}
	return response, nil
}

func success(fields map[string]any) map[string]any {
	fields["ok"] = true
	return fields
}

func failure(code, message string) map[string]any {
	return map[string]any{"ok": false, "code": code, "error": message}
}

func stringValue(request map[string]any, key string) string {
	value, _ := request[key].(string)
	return value
}

func intValue(request map[string]any, key string) int {
	switch value := request[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	default:
		return 0
	}
}

// callerAgent resolves the calling agent's name.
//
// Herdr-managed sessions identify themselves by pane id. A harness with a
// native adapter has no pane, and with herdr.service stopped there is no pane
// id to send at all, so the caller's process ancestry is walked instead: the
// Transit MCP server is a child of the harness process that registered.
func (d *Daemon) callerAgent(request map[string]any) (string, bool) {
	if agent, found := d.localAgentByPane(stringValue(request, "pane_id")); found && agent.Name != "" {
		return agent.Name, true
	}
	if pid := intValue(request, "pid"); pid > 0 {
		if name, _, found := d.adapterByProcess(pid); found {
			return name, true
		}
	}
	return "", false
}

// localTargetExists reports whether a same-host address resolves, counting a
// natively registered session as well as a Herdr pane. Without this a native
// agent is unreachable over the local fast path even though deliver() knows
// how to reach it.
func (d *Daemon) localTargetExists(name string) bool {
	if _, found := d.localAgentByName(name); found {
		return true
	}
	return d.nativeAdapterByName(name) != nil
}

func (d *Daemon) handleIPC(ctx context.Context, request map[string]any) map[string]any {
	switch stringValue(request, "op") {
	case "status":
		return d.statusResponse()
	case "kick":
		d.notifyRoster()
		d.notifyOutbox()
		return success(map[string]any{"kicked": true})
	case "pause":
		return d.pauseResponse(request)
	case "inbox":
		return d.inboxResponse()
	case "send":
		return d.sendResponse(ctx, request)
	case "rpc":
		return d.rpcResponse(ctx, request)
	case "room":
		return d.roomResponse(ctx, request)
	case "whoami":
		return d.whoamiResponse(request)
	case "claim_name":
		address, err := d.claimCallerName(ctx, request)
		if err != nil {
			return failure("claim_failed", err.Error())
		}
		return success(map[string]any{"address": address})
	default:
		return failure("bad_request", "unknown IPC operation")
	}
}

func (d *Daemon) statusResponse() map[string]any {
	outbox, dead, err := d.store.Counts()
	if err != nil {
		return failure("store_error", err.Error())
	}
	mode, modeErr := deliveryMode(d.cfg)
	if modeErr != nil {
		mode = "invalid"
	}
	d.mu.RLock()
	// `agents` counts the HERDR roster, which is not the set that receives
	// through a native adapter. Reporting only that number made a split
	// identity - an adapter registered under one name while its agent
	// advertises another - invisible from the CLI: every layer reported
	// success and deliveries silently took the Herdr path, which types into
	// the pane. `adapters` is the set that actually answers, so the two can be
	// compared directly instead of inferred from delivery forensics.
	adapters := make([]map[string]any, 0, len(d.nativeByName))
	for name, adapter := range d.nativeByName {
		adapters = append(adapters, map[string]any{
			"name": name, "harness": adapter.harness, "session_id": adapter.sessionID,
			"pid": adapter.pid, "status": adapter.status, "named_by": adapter.namedBy,
			"generation": adapter.generation,
		})
	}
	response := map[string]any{
		"host": d.cfg.Host, "connected": d.connected, "paused": d.paused,
		"last_error": d.lastError, "agents": len(d.roster),
		"uptime_seconds": int64(time.Since(d.started).Seconds()),
		"outbox":         outbox, "dead": dead,
		"delivery_mode": mode, "adapters": adapters,
	}
	d.mu.RUnlock()
	sort.Slice(adapters, func(i, j int) bool {
		return adapters[i]["name"].(string) < adapters[j]["name"].(string)
	})
	response["draft_holds"] = d.draftHolds()
	return success(response)
}

func (d *Daemon) pauseResponse(request map[string]any) map[string]any {
	d.mu.Lock()
	if toggle, _ := request["toggle"].(bool); toggle {
		d.paused = !d.paused
	} else if paused, ok := request["paused"].(bool); ok {
		d.paused = paused
	}
	paused := d.paused
	d.mu.Unlock()
	if !paused {
		d.notifyOutbox()
	}
	return success(map[string]any{"paused": paused})
}

func (d *Daemon) inboxResponse() map[string]any {
	outbox, err := d.store.ListOutbox()
	if err != nil {
		return failure("store_error", err.Error())
	}
	dead, err := d.store.ListDead()
	if err != nil {
		return failure("store_error", err.Error())
	}
	return success(map[string]any{"outbox": outbox, "dead": dead, "draft_holds": d.draftHolds()})
}

func (d *Daemon) sendResponse(ctx context.Context, request map[string]any) map[string]any {
	senderName, found := d.callerAgent(request)
	if !found {
		return failure("agent_not_found", "caller is not a named Transit agent")
	}
	to := stringValue(request, "to")
	body := stringValue(request, "body")
	if body == "" {
		return failure("bad_request", "message is required")
	}
	if len([]byte(body)) > maxMessageBytes {
		return failure("body_too_large", "message exceeds 64 KiB")
	}
	targetName, targetHost, err := parseAgentAddress(to)
	if err != nil {
		return failure("bad_address", err.Error())
	}
	message := &OutboxMessage{
		ID: txID(), From: senderName + "@" + d.cfg.Host, To: to, Body: body,
		ReplyTo: stringValue(request, "reply_to"), TS: time.Now().UTC(),
	}

	if !strings.Contains(to, "/") && targetHost == d.cfg.Host {
		if !d.localTargetExists(targetName) {
			return failure("agent_not_found", "target agent is not on this host")
		}
		if err := d.store.Enqueue(message); err != nil {
			return failure("store_error", err.Error())
		}
		if err := d.deliverLocal(ctx, message, targetName); err != nil {
			d.notifyOutbox()
			return success(map[string]any{
				"id": message.ID, "state": "spooled", "local": false,
				"warning": "local fast path held: " + err.Error(),
			})
		}
		d.notifyOutbox()
		return success(map[string]any{"id": message.ID, "state": "injected", "local": true})
	}

	waiter := d.registerCommit(message.ID)
	defer d.removeCommit(message.ID, waiter)
	if err := d.store.Enqueue(message); err != nil {
		return failure("store_error", err.Error())
	}
	d.notifyOutbox()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case outcome := <-waiter:
		if outcome.Err != nil {
			return success(map[string]any{"id": message.ID, "state": "spooled"})
		}
		if outcome.Code != "" {
			return failure(outcome.Code, "Worker rejected the message")
		}
		return success(map[string]any{"id": message.ID, "state": "committed"})
	case <-timer.C:
		return success(map[string]any{"id": message.ID, "state": "spooled"})
	case <-ctx.Done():
		return success(map[string]any{"id": message.ID, "state": "spooled"})
	}
}

func (d *Daemon) rpcResponse(ctx context.Context, request map[string]any) map[string]any {
	method := stringValue(request, "method")
	params, _ := request["params"].(map[string]any)
	if params == nil {
		params = make(map[string]any)
	}
	if paneID := stringValue(request, "pane_id"); paneID != "" {
		agent, found := d.localAgentByPane(paneID)
		if !found || agent.Name == "" {
			return failure("agent_not_found", "calling pane is not a named herdr agent")
		}
		params["caller"] = agent.Name + "@" + d.cfg.Host
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, err := d.rpc(callCtx, method, params)
	if err != nil {
		return failure("rpc_failed", err.Error())
	}
	if len(response.Error) != 0 && string(response.Error) != "null" {
		return failure("rpc_error", string(response.Error))
	}
	var result any
	if len(response.Result) != 0 {
		if err := json.Unmarshal(response.Result, &result); err != nil {
			return failure("rpc_error", err.Error())
		}
	}
	return success(map[string]any{"result": result})
}

func (d *Daemon) roomResponse(ctx context.Context, request map[string]any) map[string]any {
	name, found := d.callerAgent(request)
	if !found {
		return failure("agent_not_found", "caller is not a named Transit agent")
	}
	action := stringValue(request, "action")
	if action != "create" && action != "join" && action != "leave" {
		return failure("bad_request", "room action must be create, join, or leave")
	}
	params := map[string]any{
		"room":    stringValue(request, "room"),
		"address": name + "@" + d.cfg.Host,
	}
	if action == "create" {
		policy := stringValue(request, "policy")
		if policy == "" {
			policy = "open"
		}
		if policy != "open" && policy != "invite" {
			return failure("bad_request", "room policy must be open or invite")
		}
		params["policy"] = policy
	}
	return d.rpcResponse(ctx, map[string]any{
		"method": action + "_room",
		"params": params,
	})
}

func (d *Daemon) whoamiResponse(request map[string]any) map[string]any {
	name, found := d.callerAgent(request)
	if !found {
		return failure("agent_not_found", "caller is not a named Transit agent")
	}
	d.mu.RLock()
	connected := d.connected
	d.mu.RUnlock()
	return success(map[string]any{
		"address": name + "@" + d.cfg.Host,
		"host":    d.cfg.Host, "connected": connected,
	})
}

// claimCallerName rebinds the native adapter for a native caller. When that
// caller also has a Herdr pane, it renames the pane too so both registries keep
// the same address. Pane-only callers retain the Herdr rename path.
func (d *Daemon) claimCallerName(ctx context.Context, request map[string]any) (string, error) {
	paneID := stringValue(request, "pane_id")
	name := stringValue(request, "name")
	paneAgent, hasPane := d.localAgentByPane(paneID)

	var adapter *agentAdapter
	if pid := intValue(request, "pid"); pid > 0 {
		adapter = d.nativeAdapterForProcess(pid)
	}
	if adapter != nil {
		if err := d.validateNativeNameClaim(adapter, name); err != nil {
			return "", err
		}
		if hasPane && paneAgent.PaneID != "" {
			if _, err := d.claimName(ctx, paneID, name); err != nil {
				return "", err
			}
		}
		return d.claimNativeAdapterName(adapter, name)
	}
	if hasPane && paneAgent.PaneID != "" {
		return d.claimName(ctx, paneID, name)
	}
	return d.claimName(ctx, paneID, name)
}

func responseError(response map[string]any) error {
	ok, _ := response["ok"].(bool)
	if ok {
		return nil
	}
	message, _ := response["error"].(string)
	if message == "" {
		message = "daemon request failed"
	}
	return errors.New(message)
}
