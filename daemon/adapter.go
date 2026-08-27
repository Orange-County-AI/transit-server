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
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// adapterCapable answers whether a name has ever presented a native adapter in
// this organization. It is a fact the daemon recorded itself, unlike the
// harness kind the Herdr roster carries, which the agent asserts about itself
// — `require` mode used to refuse delivery based on that assertion. The
// record is persisted, so the capability survives a daemon restart and an
// adapter that is merely disconnected still holds its claim.
func (d *Daemon) adapterCapable(enrollment, name string) bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, record := range d.nativeNames {
		if record.Name == name && record.enrollmentOrDefault() == enrollment {
			return true
		}
	}
	return false
}

// nativeAdapterLocked and its setters keep the two-level map honest: an empty
// inner map is deleted so a roster walk never sees an organization that has no
// adapters.
func (d *Daemon) bindNativeNameLocked(enrollment, name string, adapter *agentAdapter) {
	byName := d.nativeByName[enrollment]
	if byName == nil {
		byName = make(map[string]*agentAdapter)
		d.nativeByName[enrollment] = byName
	}
	byName[name] = adapter
}

func (d *Daemon) unbindNativeNameLocked(enrollment, name string, adapter *agentAdapter) {
	byName := d.nativeByName[enrollment]
	if byName == nil || byName[name] != adapter {
		return
	}
	delete(byName, name)
	if len(byName) == 0 {
		delete(d.nativeByName, enrollment)
	}
}

func (d *Daemon) nativeAdapterLocked(enrollment, name string) *agentAdapter {
	return d.nativeByName[enrollment][name]
}

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
	PaneID     string `json:"pane_id,omitempty"`
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
	// AgentToken is the opaque credential the daemon issued the last time this
	// identity registered. A client that stores it and presents it again keeps
	// its name across a session id change — which every OMP `--resume` is.
	AgentToken string `json:"agent_token,omitempty"`
	// Enrollment names which organization this client belongs to on a daemon
	// that serves several. Empty means the one the box was enrolled with.
	Enrollment string `json:"enrollment,omitempty"`
}

type nativeName struct {
	Name       string `json:"name"`
	NamedBy    string `json:"named_by"`
	Generation uint64 `json:"generation"`
	Token      string `json:"token,omitempty"`
	Enrollment string `json:"enrollment,omitempty"`
}

// enrollmentOrDefault reads a record written before enrollments existed as
// belonging to the only organization such a daemon had.
func (record nativeName) enrollmentOrDefault() string {
	if record.Enrollment == "" {
		return defaultEnrollment
	}
	return record.Enrollment
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
	paneID     string
	pid        int
	pidStart   uint64
	cwd        string
	title      string
	status     string
	name       string
	namedBy    string
	generation uint64
	capability string
	// anchor records how this registration recovered its identity: a launcher
	// declared `name`, a stored `token` outlived a session id, or nothing but
	// the `session` id was on offer. Only the last is temporary, and an
	// address that will not survive a restart should look temporary.
	anchor string
	// token is the credential handed back so the next registration can present
	// it. Never logged and never put on the roster.
	token      string
	enrollment string
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
		T: "registered", Agent: adapter.name, Address: adapter.name + "@" + d.enrollmentHost(adapter.enrollment),
		Generation: adapter.generation, Capability: adapter.capability, AgentToken: adapter.token,
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
	adapter := d.nativeAdapterForProcess(pid)
	if adapter == nil {
		return "", fmt.Errorf("agent_not_found")
	}
	return d.claimNativeAdapterName(adapter, name)
}

func (d *Daemon) validateNativeNameClaim(adapter *agentAdapter, name string) error {
	if !namePattern.MatchString(name) || reservedNames[name] {
		return fmt.Errorf("invalid or reserved agent name %q", name)
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.nativeNameClaimErrorLocked(adapter, name)
}

func (d *Daemon) nativeNameClaimErrorLocked(adapter *agentAdapter, name string) error {
	if d.adapters[adapter.key] != adapter {
		return fmt.Errorf("agent_not_found")
	}
	// A name collides only inside one organization. Two of them may each have
	// a `clem` without either being able to reach the other's.
	for key, record := range d.nativeNames {
		if key != adapter.key && record.Name == name && record.enrollmentOrDefault() == adapter.enrollment {
			return fmt.Errorf("name is already claimed by another native session")
		}
	}
	if existing := d.nativeAdapterLocked(adapter.enrollment, name); existing != nil && existing != adapter {
		return fmt.Errorf("name is already claimed by another native session")
	}
	return nil
}

func (d *Daemon) claimNativeAdapterName(adapter *agentAdapter, name string) (address string, err error) {
	if !namePattern.MatchString(name) || reservedNames[name] {
		return "", fmt.Errorf("invalid or reserved agent name %q", name)
	}
	d.mu.Lock()
	if err := d.nativeNameClaimErrorLocked(adapter, name); err != nil {
		d.mu.Unlock()
		return "", err
	}
	previousName := adapter.name
	previousNamedBy := adapter.namedBy
	previousGeneration := adapter.generation
	previousRecord := d.nativeNames[adapter.key]
	generation := previousRecord.Generation + 1
	adapter.name = name
	adapter.namedBy = "user"
	adapter.generation = generation
	// The token is the identity, not the name: a claim renames the agent and
	// must leave the credential that recovers it alone.
	d.nativeNames[adapter.key] = nativeName{
		Name: name, NamedBy: "user", Generation: generation,
		Token: previousRecord.Token, Enrollment: adapter.enrollment,
	}
	if err := d.saveNativeNamesLocked(); err != nil {
		adapter.name = previousName
		adapter.namedBy = previousNamedBy
		adapter.generation = previousGeneration
		d.nativeNames[adapter.key] = previousRecord
		d.mu.Unlock()
		return "", err
	}
	d.unbindNativeNameLocked(adapter.enrollment, previousName, adapter)
	d.bindNativeNameLocked(adapter.enrollment, name, adapter)
	host := d.enrollmentHostLocked(adapter.enrollment)
	d.mu.Unlock()
	d.notifyRoster()
	return name + "@" + host, nil
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

// A harness names the client that is speaking, and a client asserts it about
// itself. It selects a composer parser and labels a `status` row; it is not an
// authorization input. The closed allowlist that used to live here meant a new
// harness could not register without a daemon release, and a model that
// misreported its own harness changed its delivery policy. Only the shape is
// checked now, so the value stays safe to print and to compare.
var harnessPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// adapterKeyLocked resolves which identity a registration belongs to. A token
// the daemon issued is authoritative even when a workspace-wide launcher also
// declares a default name: every helper process inherits that environment, but
// only the resumed identity owns its token.
//
// Harness is deliberately absent. Session id is the last resort because OMP
// mints a fresh one on every `--resume`. Keys are prefixed with the organization
// so equal names in separate organizations remain separate identities.
func (d *Daemon) adapterKeyLocked(frame agentFrame, enrollment string) (key, anchor string) {
	if frame.AgentToken != "" {
		if stored, found := d.nativeTokens[frame.AgentToken]; found {
			// A token issued to one organization cannot resolve an identity in
			// another, however the client labels itself.
			if d.nativeNames[stored].enrollmentOrDefault() == enrollment {
				return stored, "token"
			}
		}
	}
	if frame.Name != "" {
		return enrollment + "|name:" + frame.Name, "name"
	}
	return enrollment + "|session:" + frame.SessionID, "session"
}

// paneAgentForRegistration resolves the pane a registering client says it
// occupies. The cached roster is a snapshot refreshed every couple of seconds
// and it is EMPTY for the first one after a daemon restart — which is exactly
// when every adapter on the box reconnects at once. Concluding from that miss
// that the pane does not exist minted a fresh auto-name beside a pane that
// already had one, and because a stored name outranks a pane on the next
// registration, the placeholder then stuck. A miss asks Herdr directly.
func (d *Daemon) paneAgentForRegistration(paneID string) (HerdrAgent, bool) {
	if paneID == "" {
		return HerdrAgent{}, false
	}
	if agent, found := d.localAgentByPane(paneID); found {
		return agent, true
	}
	if !d.herdrReachable() {
		return HerdrAgent{}, false
	}
	// Bounded locally rather than threaded from the caller: this is one call
	// on a unix socket, and a registration must not block on it.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	agent, err := d.herdr.GetAgent(ctx, paneID)
	if err != nil || agent == nil {
		return HerdrAgent{}, false
	}
	return *agent, true
}

// absorbNameLocked folds stale records for this identity into its current key.
// A live adapter is only eligible after registration has proved it occupies the
// same pane or presented the same daemon-issued token. That check happens
// before this helper; a workspace-wide declared name alone is not identity.
func (d *Daemon) absorbNameLocked(
	key, name, enrollment string, record nativeName, displaced []*agentAdapter,
) (nativeName, []*agentAdapter) {
	for otherKey, other := range d.nativeNames {
		if otherKey == key || other.Name != name || other.enrollmentOrDefault() != enrollment {
			continue
		}
		if live := d.adapters[otherKey]; live != nil {
			displaced = append(displaced, live)
			delete(d.adapters, otherKey)
		}
		if other.Generation > record.Generation {
			record.Generation = other.Generation
		}
		if record.Token == "" {
			record.Token = other.Token
		}
		delete(d.nativeTokens, other.Token)
		delete(d.nativeNames, otherKey)
	}
	return record, displaced
}

func (d *Daemon) registerAgentAdapter(frame agentFrame, pid int, start uint64, connection net.Conn) (*agentAdapter, string, string) {
	if !harnessPattern.MatchString(frame.Harness) {
		return nil, "unsupported_harness", "harness must match [a-z][a-z0-9-]{0,31}"
	}
	if strings.TrimSpace(frame.SessionID) == "" {
		return nil, "invalid_session", "session_id is required"
	}
	if frame.Name != "" && (!namePattern.MatchString(frame.Name) || reservedNames[frame.Name]) {
		return nil, "invalid_name", "name is invalid or reserved"
	}
	enrollment := defaultEnrollment
	if frame.Enrollment != "" {
		if d.enrollmentsByID[frame.Enrollment] == nil {
			return nil, "unknown_enrollment", "no such enrollment on this daemon"
		}
		enrollment = frame.Enrollment
	} else if runtime := d.defaultEnrollmentRuntime(); runtime != nil {
		enrollment = runtime.id
	}
	paneAgent, hasPaneAgent := d.paneAgentForRegistration(frame.PaneID)

	d.mu.Lock()
	defer d.mu.Unlock()

	key, anchor := d.adapterKeyLocked(frame, enrollment)
	// A configured name is a bootstrap hint, not authority over an identity
	// recovered by token. This is what keeps a resumed helper that inherited
	// TRANSIT_AGENT_NAME=stub attached to its own status-overlay identity.
	if anchor == "token" {
		frame.Name = ""
	}
	// Two live sessions in one workspace inherit the same configured name.
	// Never let the later helper evict the target merely by declaring it. A
	// different named pane supplies the helper's real identity; without that
	// evidence, refuse and retry rather than route customer traffic silently.
	if anchor == "name" {
		if held := d.nativeAdapterLocked(enrollment, frame.Name); held != nil &&
			held.sessionID != frame.SessionID && held.paneID != frame.PaneID {
			if hasPaneAgent && paneAgent.Name != "" && paneAgent.Name != frame.Name {
				frame.Name = ""
				key, anchor = d.adapterKeyLocked(frame, enrollment)
			} else {
				return nil, "name_taken", "declared name is already registered by another pane"
			}
		}
	}
	nameRecord, hasName := d.nativeNames[key]
	nameRecord.Enrollment = enrollment
	// displaced are prior connections for the identity proved above.
	displaced := []*agentAdapter{}
	if old := d.adapters[key]; old != nil {
		displaced = append(displaced, old)
	}
	if frame.Name != "" {
		nameRecord, displaced = d.absorbNameLocked(key, frame.Name, enrollment, nameRecord, displaced)
		nameRecord.Name = frame.Name
		nameRecord.NamedBy = "user"
		hasName = true
	}
	// A stored name the daemon invented is a placeholder, not a decision. When
	// the pane in front of it carries a name — one a person chose, or one
	// Herdr generated and has been showing ever since — the placeholder yields
	// to it. Stored `user` and `herdr` names still win: those were chosen.
	if hasName && nameRecord.NamedBy == "auto" && hasPaneAgent &&
		paneAgent.Name != "" && paneAgent.Name != nameRecord.Name {
		hasName = false
	}
	if !hasName {
		adopted := false
		if hasPaneAgent && paneAgent.Name != "" {
			// The pane says which agent occupies it and this client says it
			// occupies that pane, so any other record holding the pane's name
			// is an earlier incarnation of this same agent — the same
			// reasoning as a declared name. Refusing instead left the agent
			// registered beside its own pane under an invented name.
			nameRecord, displaced = d.absorbNameLocked(key, paneAgent.Name, enrollment, nameRecord, displaced)
			// Only the name changes: the credential and the generation belong
			// to the identity, which is the same one either way.
			nameRecord.Name, nameRecord.NamedBy = paneAgent.Name, "herdr"
			adopted = true
		}
		if !adopted {
			taken := make(map[string]bool, len(d.nativeNames)+len(d.herdrAgents))
			for otherKey, other := range d.nativeNames {
				if otherKey != key && other.Name != "" && other.enrollmentOrDefault() == enrollment {
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
			nameRecord.Name, nameRecord.NamedBy = name, "auto"
		}
	}

	capability, err := randomCapability()
	if err != nil {
		return nil, "capability_failed", err.Error()
	}
	if nameRecord.Token == "" {
		token, err := randomCapability()
		if err != nil {
			return nil, "token_failed", err.Error()
		}
		nameRecord.Token = token
	}
	generation := nameRecord.Generation + 1
	nameRecord.Generation = generation
	adapter := &agentAdapter{
		key: key, harness: frame.Harness, sessionID: frame.SessionID, paneID: frame.PaneID,
		pid: pid, pidStart: start, cwd: frame.CWD, title: frame.Title, status: frame.Status,
		name: nameRecord.Name, namedBy: nameRecord.NamedBy, generation: generation,
		capability: capability, anchor: anchor, token: nameRecord.Token,
		enrollment: enrollment, connection: connection, waiters: make(map[string]chan agentDeliveryOutcome),
	}
	if held := d.nativeAdapterLocked(enrollment, nameRecord.Name); held != nil && !containsAdapter(displaced, held) {
		return nil, "name_taken", "name is already registered by another native session"
	}
	d.nativeNames[key] = nameRecord
	d.nativeTokens[nameRecord.Token] = key
	if err := d.saveNativeNamesLocked(); err != nil {
		return nil, "name_persistence_failed", err.Error()
	}
	d.adapters[key] = adapter
	for _, old := range displaced {
		if old.name != nameRecord.Name {
			d.unbindNativeNameLocked(old.enrollment, old.name, old)
		}
	}
	d.bindNativeNameLocked(enrollment, nameRecord.Name, adapter)
	for _, old := range displaced {
		_ = old.connection.Close()
	}
	return adapter, "", ""
}

func containsAdapter(adapters []*agentAdapter, target *agentAdapter) bool {
	for _, adapter := range adapters {
		if adapter == target {
			return true
		}
	}
	return false
}

func (d *Daemon) deregisterAgentAdapter(adapter *agentAdapter) {
	adapter.failWaiters()
	d.mu.Lock()
	if d.adapters[adapter.key] == adapter {
		delete(d.adapters, adapter.key)
		d.unbindNativeNameLocked(adapter.enrollment, adapter.name, adapter)
	}
	d.mu.Unlock()
	d.notifyRoster()
}

func (d *Daemon) nativeAdapterByName(enrollment, name string) *agentAdapter {
	d.mu.RLock()
	adapter := d.nativeAdapterLocked(enrollment, name)
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
