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
// A native adapter is authoritative for its harness process, even when that
// harness also occupies a Herdr pane. The pane may still have its generated
// post-restart name while the adapter has already reclaimed a configured stable
// name; choosing the pane in that interval injects a delivery into the right
// transcript but makes every settlement fail ownership validation.
//
// Pane identity remains the fallback for harnesses without a native adapter.
// The resolved enrollment chooses both the caller address and outbox partition.
func (d *Daemon) callerAgent(request map[string]any) (name, enrollment string, found bool) {
	if pid := intValue(request, "pid"); pid > 0 {
		if adapter := d.nativeAdapterForProcess(pid); adapter != nil {
			return adapter.name, adapter.enrollment, true
		}
	}
	if agent, ok := d.localAgentByPane(stringValue(request, "pane_id")); ok && agent.Name != "" {
		herdr := defaultEnrollment
		if runtime := d.defaultEnrollmentRuntime(); runtime != nil {
			herdr = runtime.id
		}
		return agent.Name, herdr, true
	}
	return "", "", false
}

// localTargetExists reports whether a same-host address resolves, counting a
// natively registered session as well as a Herdr pane. Without this a native
// agent is unreachable over the local fast path even though deliver() knows
// how to reach it.
func (d *Daemon) localTargetExists(enrollment, name string) bool {
	if _, found := d.localAgentByName(name); found {
		return true
	}
	return d.nativeAdapterByName(enrollment, name) != nil
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
	mode, modeErr := deliveryMode(d.cfg)
	if modeErr != nil {
		mode = "invalid"
	}
	// Counts and connection state are summed across enrollments so a
	// single-organization box reads exactly as it always has, with the
	// per-organization breakdown alongside it.
	outbox, dead := 0, 0
	connected := len(d.enrollments) > 0
	lastError := ""
	rows := make([]map[string]any, 0, len(d.enrollments))
	for _, enrollment := range d.enrollments {
		enrollmentConnected, enrollmentError := enrollment.snapshot()
		if !enrollmentConnected {
			connected = false
		}
		if enrollmentError != "" && lastError == "" {
			lastError = enrollmentError
		}
		row := map[string]any{
			"id": enrollment.id, "host": enrollment.host,
			"connected": enrollmentConnected, "last_error": enrollmentError,
		}
		if enrollment.store != nil {
			enrollmentOutbox, enrollmentDead, err := enrollment.store.Counts()
			if err != nil {
				return failure("store_error", err.Error())
			}
			outbox += enrollmentOutbox
			dead += enrollmentDead
			row["outbox"], row["dead"] = enrollmentOutbox, enrollmentDead
		}
		rows = append(rows, row)
	}

	d.mu.RLock()
	// `agents` counts the HERDR roster, which is not the set that receives
	// through a native adapter. Reporting only that number made a split
	// identity - an adapter registered under one name while its agent
	// advertises another - invisible from the CLI: every layer reported
	// success and deliveries silently took the Herdr path, which types into
	// the pane. `adapters` is the set that actually answers, so the two can be
	// compared directly instead of inferred from delivery forensics.
	adapters := make([]map[string]any, 0, len(d.adapters))
	agents := 0
	for _, published := range d.roster {
		agents += len(published)
	}
	for enrollment, byName := range d.nativeByName {
		for name, adapter := range byName {
			adapters = append(adapters, map[string]any{
				"name": name, "harness": adapter.harness, "session_id": adapter.sessionID,
				"pid": adapter.pid, "status": adapter.status, "named_by": adapter.namedBy,
				"generation": adapter.generation, "anchor": adapter.anchor,
				"enrollment": enrollment,
			})
		}
	}
	response := map[string]any{
		"host": d.cfg.Host, "connected": connected, "paused": d.paused,
		"herdr":      d.herdrAvailable,
		"last_error": lastError, "agents": agents,
		"uptime_seconds": int64(time.Since(d.started).Seconds()),
		"outbox":         outbox, "dead": dead,
		"delivery_mode": mode, "adapters": adapters, "enrollments": rows,
	}
	d.mu.RUnlock()
	sort.Slice(adapters, func(i, j int) bool {
		return adapters[i]["name"].(string) < adapters[j]["name"].(string)
	})
	response["draft_holds"] = d.draftHolds()
	return success(response)
}

// pauseResponse toggles host-wide delivery.
//
// IT LOGS, and that is the point of the extra lines. A pause silences every
// adapter on the box at once while leaving each one registered, connected and
// reporting a current `updated_at`, so every liveness instrument reads healthy
// while deliveries pile up plane-side with `via` unset. On 2026-08-27 that
// state held titan for 84 minutes: nothing recorded that the flag had moved,
// and the only witness was a `transit status` nobody had reason to run. A
// state that can stop an entire host belongs in the journal, with the number
// of adapters it affects.
func (d *Daemon) pauseResponse(request map[string]any) map[string]any {
	d.mu.Lock()
	previous := d.paused
	if toggle, _ := request["toggle"].(bool); toggle {
		d.paused = !d.paused
	} else if paused, ok := request["paused"].(bool); ok {
		d.paused = paused
	}
	paused := d.paused
	adapters := len(d.adapters)
	d.mu.Unlock()
	if paused != previous {
		if paused {
			d.logf("delivery PAUSED host-wide; %d registered adapters receive nothing until resumed", adapters)
		} else {
			d.logf("delivery resumed host-wide; %d registered adapters eligible again", adapters)
		}
	}
	if !paused {
		d.notifyOutbox()
	}
	return success(map[string]any{"paused": paused})
}

func (d *Daemon) inboxResponse() map[string]any {
	outbox := []OutboxMessage{}
	dead := []DeadMessage{}
	for _, enrollment := range d.enrollments {
		if enrollment.store == nil {
			continue
		}
		enrollmentOutbox, err := enrollment.store.ListOutbox()
		if err != nil {
			return failure("store_error", err.Error())
		}
		enrollmentDead, err := enrollment.store.ListDead()
		if err != nil {
			return failure("store_error", err.Error())
		}
		outbox = append(outbox, enrollmentOutbox...)
		dead = append(dead, enrollmentDead...)
	}
	// Deliveries this host injected, with the transport each one took. The
	// live adapter list says who WOULD receive natively; only this says who
	// did.
	delivered, err := d.store.ListIncoming(50)
	if err != nil {
		return failure("store_error", err.Error())
	}
	return success(map[string]any{
		"outbox": outbox, "dead": dead, "delivered": delivered,
		"draft_holds": d.draftHolds(),
	})
}

func (d *Daemon) sendResponse(ctx context.Context, request map[string]any) map[string]any {
	senderName, senderEnrollment, found := d.callerAgent(request)
	if !found {
		return failure("agent_not_found", "caller is not a named Transit agent")
	}
	enrollment := d.enrollment(senderEnrollment)
	if enrollment == nil || enrollment.store == nil {
		return failure("enrollment_unavailable", "the caller's enrollment has no usable spool")
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
		ID: txID(), From: senderName + "@" + enrollment.host, To: to, Body: body,
		ReplyTo: stringValue(request, "reply_to"), TS: time.Now().UTC(),
	}

	if !strings.Contains(to, "/") && targetHost == enrollment.host {
		if !d.localTargetExists(enrollment.id, targetName) {
			return failure("agent_not_found", "target agent is not on this host")
		}
		if err := enrollment.store.Enqueue(message); err != nil {
			return failure("store_error", err.Error())
		}
		if err := d.deliverLocal(ctx, enrollment, message, targetName); err != nil {
			enrollment.notifyOutbox()
			return success(map[string]any{
				"id": message.ID, "state": "spooled", "local": false,
				"warning": "local fast path held: " + err.Error(),
			})
		}
		enrollment.notifyOutbox()
		return success(map[string]any{"id": message.ID, "state": "injected", "local": true})
	}

	waiter := d.registerCommit(message.ID)
	defer d.removeCommit(message.ID, waiter)
	if err := enrollment.store.Enqueue(message); err != nil {
		return failure("store_error", err.Error())
	}
	enrollment.notifyOutbox()
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

// rpcResponse forwards to the Worker over the caller's own connection: an RPC
// answered by the wrong organization would be answered correctly and be about
// the wrong fleet.
func (d *Daemon) rpcResponse(ctx context.Context, request map[string]any) map[string]any {
	method := stringValue(request, "method")
	params, _ := request["params"].(map[string]any)
	if params == nil {
		params = make(map[string]any)
	}
	callerName, callerEnrollment, hasCaller := d.callerAgent(request)
	// `as_agent` is the OPERATOR's caller, set by the `transit` CLI and by
	// nothing else. It exists because a person at a terminal is not a session:
	// they have no adapter and no pane, so `callerAgent` cannot resolve them,
	// and without this there is no way to read an agent's waiting queue from
	// the box the agent runs on. The authority is already held — the daemon
	// socket is 0600 and the device token behind it can inject to any agent on
	// this host — so naming one adds nothing a local caller did not have.
	//
	// It is deliberately NOT reachable from a tool argument: `mcp.go` builds
	// its own request maps and never copies a model's arguments into this key.
	// Wiring one through would let an agent read another's inbox.
	if !hasCaller {
		if as := stringValue(request, "as_agent"); as != "" {
			callerName, hasCaller = as, true
			if runtime := d.defaultEnrollmentRuntime(); runtime != nil {
				callerEnrollment = runtime.id
			} else {
				callerEnrollment = defaultEnrollment
			}
		}
	}
	if hasCaller {
		params["caller"] = callerName + "@" + d.enrollmentHost(callerEnrollment)
	} else if stringValue(request, "pane_id") != "" {
		return failure("agent_not_found", "calling pane is not a named herdr agent")
	}
	enrollment := d.enrollment(callerEnrollment)
	if !hasCaller {
		enrollment = d.defaultEnrollmentRuntime()
	}
	if enrollment == nil {
		return failure("rpc_failed", "Transit is offline")
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, err := d.rpc(callCtx, enrollment, method, params)
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
	name, callerEnrollment, found := d.callerAgent(request)
	if !found {
		return failure("agent_not_found", "caller is not a named Transit agent")
	}
	action := stringValue(request, "action")
	if action != "create" && action != "join" && action != "leave" {
		return failure("bad_request", "room action must be create, join, or leave")
	}
	params := map[string]any{
		"room":    stringValue(request, "room"),
		"address": name + "@" + d.enrollmentHost(callerEnrollment),
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
		"pid":    request["pid"], "pane_id": request["pane_id"],
	})
}

func (d *Daemon) whoamiResponse(request map[string]any) map[string]any {
	name, callerEnrollment, found := d.callerAgent(request)
	if !found {
		return failure("agent_not_found", "caller is not a named Transit agent")
	}
	enrollment := d.enrollment(callerEnrollment)
	connected, _ := enrollment.snapshot()
	return success(map[string]any{
		"address": name + "@" + enrollment.host,
		"host":    enrollment.host, "connected": connected,
	})
}

// claimCallerName rebinds the native adapter for a native caller. When that
// caller also has a Herdr pane, it renames the pane too so both registries keep
// the same address. Pane-only callers use the Herdr rename path, which is the
// only registry they have.
//
// For a native caller the pane rename is BEST-EFFORT. It used to be fatal, so
// a Herdr that died between the last roster refresh and this call — the cached
// pane is still there, the socket is not — failed a claim that needs nothing
// from Herdr to succeed. The native registry is the one that answers
// `whoami`, addresses deliveries and validates settlement; a stale pane label
// beside it is cosmetic and the next refresh reconciles it.
func (d *Daemon) claimCallerName(ctx context.Context, request map[string]any) (string, error) {
	paneID := stringValue(request, "pane_id")
	name := stringValue(request, "name")
	paneAgent, hasPane := d.localAgentByPane(paneID)

	var adapter *agentAdapter
	if pid := intValue(request, "pid"); pid > 0 {
		adapter = d.nativeAdapterForProcess(pid)
	}
	if adapter == nil && hasPane {
		var ambiguous bool
		adapter, ambiguous = d.uniqueNativeAdapterByPane(paneAgent.PaneID)
		if ambiguous {
			return "", fmt.Errorf("multiple native adapters occupy pane %s", paneAgent.PaneID)
		}
	}
	if adapter != nil {
		if err := d.validateNativeNameClaim(adapter, name); err != nil {
			return "", err
		}
		if hasPane && paneAgent.PaneID != "" {
			if _, err := d.claimName(ctx, paneID, name); err != nil {
				d.logf("claim_name: pane %s kept its old label (%v)", paneID, err)
			}
		}
		return d.claimNativeAdapterName(adapter, name)
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
