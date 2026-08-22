package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	agentProtocol     = 1
	agentRegisterWait = 10 * time.Second
	agentPingInterval = 15 * time.Second
)

type agentFrame struct {
	T          string `json:"t"`
	Proto      int    `json:"proto,omitempty"`
	Harness    string `json:"harness,omitempty"`
	SessionID  string `json:"session_id,omitempty"`
	PID        int    `json:"pid,omitempty"`
	CWD        string `json:"cwd,omitempty"`
	Title      string `json:"title,omitempty"`
	Status     string `json:"status,omitempty"`
	Name       string `json:"name,omitempty"`
	Capability string `json:"capability,omitempty"`
	ID         string `json:"id,omitempty"`
	Envelope   string `json:"envelope,omitempty"`
	Persisted  bool   `json:"persisted,omitempty"`
	Code       string `json:"code,omitempty"`
	Retryable  bool   `json:"retryable,omitempty"`
	Agent      string `json:"agent,omitempty"`
	Address    string `json:"address,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
	Error      string `json:"error,omitempty"`
}

type nativeName struct {
	Name       string `json:"name"`
	NamedBy    string `json:"named_by"`
	Generation uint64 `json:"generation"`
}

type agentDeliveryOutcome struct {
	code      string
	retryable bool
	err       error
}

type agentAdapter struct {
	key        string
	harness    string
	sessionID  string
	pid        int
	pidStart   uint64
	cwd        string
	title      string
	status     string
	name       string
	namedBy    string
	generation uint64
	capability string
	connection net.Conn

	writeMu sync.Mutex
	waitMu  sync.Mutex
	waiters map[string]chan agentDeliveryOutcome
}

func listenAgentSocket(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("refusing to replace non-socket agent path %q", path)
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
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func serveAgentSocket(ctx context.Context, listener net.Listener, daemon *Daemon) error {
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
		go daemon.serveAgentConnection(ctx, connection)
	}
}

func (d *Daemon) serveAgentConnection(ctx context.Context, connection net.Conn) {
	defer connection.Close()
	pid, uid, err := agentPeerCredentials(connection)
	if err != nil || uid != os.Getuid() {
		return
	}
	start, err := processStartTime(pid)
	if err != nil {
		return
	}

	_ = connection.SetReadDeadline(time.Now().Add(agentRegisterWait))
	scanner := bufio.NewScanner(connection)
	scanner.Buffer(make([]byte, 4096), maxWireFrameBytes)
	if !scanner.Scan() {
		return
	}
	var frame agentFrame
	if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
		_ = writeJSONLine(connection, agentFrame{T: "register_err", Code: "bad_request", Error: "invalid JSON register frame"})
		return
	}
	if frame.T != "register" {
		_ = writeJSONLine(connection, agentFrame{T: "register_err", Code: "register_required", Error: "first frame must be register"})
		return
	}
	if frame.Proto != agentProtocol {
		_ = writeJSONLine(connection, agentFrame{T: "register_err", Code: "unsupported_proto", Error: "unsupported transit-agent protocol"})
		return
	}
	if frame.PID != pid {
		_ = writeJSONLine(connection, agentFrame{T: "register_err", Code: "pid_mismatch", Error: "register pid does not match socket peer"})
		return
	}
	adapter, code, message := d.registerAgentAdapter(frame, pid, start, connection)
	if adapter == nil {
		_ = writeJSONLine(connection, agentFrame{T: "register_err", Code: code, Error: message})
		return
	}
	if err := adapter.write(agentFrame{
		T: "registered", Agent: adapter.name, Address: adapter.name + "@" + d.cfg.Host,
		Generation: adapter.generation, Capability: adapter.capability,
	}); err != nil {
		d.deregisterAgentAdapter(adapter)
		return
	}
	_ = connection.SetReadDeadline(time.Time{})
	d.notifyRoster()

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for scanner.Scan() {
			var control agentFrame
			if json.Unmarshal(scanner.Bytes(), &control) != nil {
				continue
			}
			d.handleAgentControl(adapter, control)
		}
	}()
	ping := time.NewTicker(agentPingInterval)
	defer ping.Stop()
	defer d.deregisterAgentAdapter(adapter)
	for {
		select {
		case <-ctx.Done():
			return
		case <-readDone:
			return
		case <-ping.C:
			if err := adapter.write(agentFrame{T: "ping"}); err != nil {
				return
			}
		}
	}
}

func (d *Daemon) handleAgentControl(adapter *agentAdapter, frame agentFrame) {
	if frame.Capability != adapter.capability {
		return
	}
	switch frame.T {
	case "deliver_ack":
		if frame.ID == "" {
			return
		}
		if !frame.Persisted {
			adapter.resolve(frame.ID, agentDeliveryOutcome{code: "adapter_ack_invalid", retryable: true, err: fmt.Errorf("adapter acknowledged delivery without persistence")})
			return
		}
		adapter.resolve(frame.ID, agentDeliveryOutcome{})
	case "deliver_nak":
		if frame.ID == "" {
			return
		}
		code := frame.Code
		if code == "" {
			code = "adapter_rejected"
		}
		adapter.resolve(frame.ID, agentDeliveryOutcome{code: code, retryable: frame.Retryable, err: fmt.Errorf("adapter rejected delivery: %s", code)})
	case "status":
		d.mu.Lock()
		if d.adapters[adapter.key] == adapter {
			adapter.status = frame.Status
		}
		d.mu.Unlock()
		d.notifyRoster()
	case "pong":
		// A successful read proves the registered connection is still alive.
	default:
		// Forward compatibility: unknown control frames are ignored.
	}
}

func agentPeerCredentials(connection net.Conn) (int, int, error) {
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return 0, 0, fmt.Errorf("agent socket is not a Unix connection")
	}
	raw, err := unixConnection.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var credentials *syscall.Ucred
	var controlErr error
	err = raw.Control(func(fd uintptr) {
		credentials, controlErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return 0, 0, err
	}
	if controlErr != nil || credentials == nil {
		return 0, 0, controlErr
	}
	return int(credentials.Pid), int(credentials.Uid), nil
}
func processStartTime(pid int) (uint64, error) {
	fields, err := processStatFields(pid)
	if err != nil {
		return 0, err
	}
	if len(fields) < 20 {
		return 0, fmt.Errorf("short /proc/%d/stat", pid)
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse /proc/%d start time: %w", pid, err)
	}
	return start, nil
}

func processParentPID(pid int) (int, error) {
	fields, err := processStatFields(pid)
	if err != nil {
		return 0, err
	}
	if len(fields) < 2 {
		return 0, fmt.Errorf("short /proc/%d/stat", pid)
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, fmt.Errorf("parse /proc/%d parent pid: %w", pid, err)
	}
	return parent, nil
}

func processStatFields(pid int) ([]string, error) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return nil, err
	}
	rest := string(data)
	index := strings.LastIndex(rest, ")")
	if index < 0 {
		return nil, fmt.Errorf("invalid /proc/%d/stat", pid)
	}
	return strings.Fields(rest[index+1:]), nil
}

// adapterByProcess walks pid's PPID chain (bounded, max 16 hops, stop at
// pid 1) and returns the registered agent name of the first ancestor that
// is a registered native adapter.
func (d *Daemon) adapterByProcess(pid int) (name string, paneID string, found bool) {
	adapter := d.nativeAdapterForProcess(pid)
	if adapter == nil {
		return "", "", false
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.adapters[adapter.key] != adapter {
		return "", "", false
	}
	return adapter.name, "native:" + adapter.harness + ":" + firstSessionID(adapter.sessionID), true
}

func (d *Daemon) nativeAdapterForProcess(pid int) *agentAdapter {
	for hops := 0; hops < 16 && pid > 1; hops++ {
		start, err := processStartTime(pid)
		if err != nil {
			return nil
		}
		d.mu.RLock()
		for _, adapter := range d.adapters {
			if adapter.pid == pid && adapter.pidStart == start {
				d.mu.RUnlock()
				return adapter
			}
		}
		d.mu.RUnlock()
		parent, err := processParentPID(pid)
		if err != nil {
			return nil
		}
		pid = parent
	}
	return nil
}

// claimNativeName renames the native adapter that owns pid's process
// ancestry, persisting to native_names.json. Returns the full address.
func (d *Daemon) claimNativeName(pid int, name string) (address string, err error) {
	if !namePattern.MatchString(name) || reservedNames[name] {
		return "", fmt.Errorf("invalid or reserved agent name %q", name)
	}
	adapter := d.nativeAdapterForProcess(pid)
	if adapter == nil {
		return "", fmt.Errorf("agent_not_found")
	}
	d.mu.Lock()
	if d.adapters[adapter.key] != adapter {
		d.mu.Unlock()
		return "", fmt.Errorf("agent_not_found")
	}
	for key, record := range d.nativeNames {
		if key != adapter.key && record.Name == name {
			d.mu.Unlock()
			return "", fmt.Errorf("name is already claimed by another native session")
		}
	}
	if existing := d.nativeByName[name]; existing != nil && existing != adapter {
		d.mu.Unlock()
		return "", fmt.Errorf("name is already claimed by another native session")
	}
	previousName := adapter.name
	previousRecord := d.nativeNames[adapter.key]
	adapter.name = name
	adapter.namedBy = "user"
	d.nativeNames[adapter.key] = nativeName{Name: name, NamedBy: "user", Generation: previousRecord.Generation}
	if err := d.saveNativeNamesLocked(); err != nil {
		adapter.name = previousName
		adapter.namedBy = previousRecord.NamedBy
		d.nativeNames[adapter.key] = previousRecord
		d.mu.Unlock()
		return "", err
	}
	if d.nativeByName[previousName] == adapter {
		delete(d.nativeByName, previousName)
	}
	d.nativeByName[name] = adapter
	d.mu.Unlock()
	d.notifyRoster()
	return name + "@" + d.cfg.Host, nil
}

func (adapter *agentAdapter) write(frame agentFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	adapter.writeMu.Lock()
	defer adapter.writeMu.Unlock()
	_ = adapter.connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer adapter.connection.SetWriteDeadline(time.Time{})
	for len(data) > 0 {
		count, err := adapter.connection.Write(data)
		if err != nil {
			return err
		}
		data = data[count:]
	}
	return nil
}

func (adapter *agentAdapter) registerWaiter(id string) chan agentDeliveryOutcome {
	waiter := make(chan agentDeliveryOutcome, 1)
	adapter.waitMu.Lock()
	adapter.waiters[id] = waiter
	adapter.waitMu.Unlock()
	return waiter
}

func (adapter *agentAdapter) removeWaiter(id string, waiter chan agentDeliveryOutcome) {
	adapter.waitMu.Lock()
	if adapter.waiters[id] == waiter {
		delete(adapter.waiters, id)
	}
	adapter.waitMu.Unlock()
}

func (adapter *agentAdapter) resolve(id string, outcome agentDeliveryOutcome) {
	adapter.waitMu.Lock()
	waiter := adapter.waiters[id]
	delete(adapter.waiters, id)
	adapter.waitMu.Unlock()
	if waiter != nil {
		waiter <- outcome
	}
}

func (adapter *agentAdapter) failWaiters() {
	adapter.waitMu.Lock()
	waiters := adapter.waiters
	adapter.waiters = make(map[string]chan agentDeliveryOutcome)
	adapter.waitMu.Unlock()
	for _, waiter := range waiters {
		waiter <- agentDeliveryOutcome{code: "adapter_unavailable", retryable: true, err: fmt.Errorf("adapter connection closed")}
	}
}

func nativeHarness(harness string) bool {
	switch harness {
	case "claude", "omp", "pi", "opencode":
		return true
	default:
		return false
	}
}

func (d *Daemon) registerAgentAdapter(frame agentFrame, pid int, start uint64, connection net.Conn) (*agentAdapter, string, string) {
	if !nativeHarness(frame.Harness) {
		return nil, "unsupported_harness", "harness must be claude, omp, pi, or opencode"
	}
	if strings.TrimSpace(frame.SessionID) == "" {
		return nil, "invalid_session", "session_id is required"
	}
	key := frame.Harness + ":" + frame.SessionID

	d.mu.Lock()
	defer d.mu.Unlock()

	nameRecord, hasName := d.nativeNames[key]
	if frame.Name != "" {
		if !namePattern.MatchString(frame.Name) || reservedNames[frame.Name] {
			return nil, "invalid_name", "name is invalid or reserved"
		}
		for otherKey, other := range d.nativeNames {
			if otherKey != key && other.Name == frame.Name {
				return nil, "name_taken", "name is already claimed by another native session"
			}
		}
		nameRecord.Name = frame.Name
		nameRecord.NamedBy = "user"
		hasName = true
	}
	if !hasName {
		taken := make(map[string]bool, len(d.nativeNames)+len(d.herdrAgents))
		for otherKey, other := range d.nativeNames {
			if otherKey != key && other.Name != "" {
				taken[other.Name] = true
			}
		}
		for _, agent := range d.herdrAgents {
			if agent.Name != "" {
				taken[agent.Name] = true
			}
		}
		name, err := generateAutoName(frame.Harness, taken)
		if err != nil {
			return nil, "name_allocation_failed", err.Error()
		}
		nameRecord = nativeName{Name: name, NamedBy: "auto"}
	}

	capability, err := randomCapability()
	if err != nil {
		return nil, "capability_failed", err.Error()
	}
	generation := nameRecord.Generation + 1
	nameRecord.Generation = generation
	old := d.adapters[key]
	adapter := &agentAdapter{
		key: key, harness: frame.Harness, sessionID: frame.SessionID, pid: pid, pidStart: start,
		cwd: frame.CWD, title: frame.Title, status: frame.Status, name: nameRecord.Name, namedBy: nameRecord.NamedBy,
		generation: generation, capability: capability, connection: connection, waiters: make(map[string]chan agentDeliveryOutcome),
	}
	if d.nativeByName[nameRecord.Name] != nil && d.nativeByName[nameRecord.Name] != old {
		return nil, "name_taken", "name is already registered by another native session"
	}
	d.nativeNames[key] = nameRecord
	if err := d.saveNativeNamesLocked(); err != nil {
		return nil, "name_persistence_failed", err.Error()
	}
	d.adapters[key] = adapter
	d.nativeByName[nameRecord.Name] = adapter
	if old != nil && old.name != nameRecord.Name && d.nativeByName[old.name] == old {
		delete(d.nativeByName, old.name)
	}
	if old != nil {
		_ = old.connection.Close()
	}
	return adapter, "", ""
}

func (d *Daemon) deregisterAgentAdapter(adapter *agentAdapter) {
	adapter.failWaiters()
	d.mu.Lock()
	if d.adapters[adapter.key] == adapter {
		delete(d.adapters, adapter.key)
		if d.nativeByName[adapter.name] == adapter {
			delete(d.nativeByName, adapter.name)
		}
	}
	d.mu.Unlock()
	d.notifyRoster()
}

func (d *Daemon) nativeAdapterByName(name string) *agentAdapter {
	d.mu.RLock()
	adapter := d.nativeByName[name]
	d.mu.RUnlock()
	return adapter
}

func (d *Daemon) nativeNamesPath() string { return filepath.Join(d.store.root, "native_names.json") }

func (d *Daemon) loadNativeNames() map[string]nativeName {
	data, err := os.ReadFile(d.nativeNamesPath())
	if err != nil {
		return make(map[string]nativeName)
	}
	var names map[string]nativeName
	if json.Unmarshal(data, &names) != nil || names == nil {
		return make(map[string]nativeName)
	}
	return names
}

func (d *Daemon) saveNativeNamesLocked() error {
	return writeJSONAtomic(d.nativeNamesPath(), d.nativeNames, 0o600)
}

func randomCapability() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func (d *Daemon) deliverNative(ctx context.Context, adapter *agentAdapter, id, envelope string) (code string, retryable bool, err error) {
	waiter := adapter.registerWaiter(id)
	if err := adapter.write(agentFrame{T: "deliver", ID: id, Envelope: envelope}); err != nil {
		adapter.removeWaiter(id, waiter)
		d.deregisterAgentAdapter(adapter)
		return "adapter_unavailable", true, err
	}
	timer := time.NewTimer(promptTimeout)
	defer timer.Stop()
	select {
	case outcome := <-waiter:
		return outcome.code, outcome.retryable, outcome.err
	case <-ctx.Done():
		adapter.removeWaiter(id, waiter)
		return "delivery_cancelled", true, ctx.Err()
	case <-timer.C:
		adapter.removeWaiter(id, waiter)
		return "adapter_timeout", true, fmt.Errorf("adapter delivery acknowledgement timed out")
	}
}
