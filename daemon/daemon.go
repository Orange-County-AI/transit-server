package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type sendOutcome struct {
	Code string
	Err  error
}

// draftHold is the pane evidence that stopped a delivery: the person had unsent
// input in the composer, so prompting would have submitted their draft with the
// envelope. Held deliveries are retried, never dropped.
type draftHold struct {
	PaneID string    `json:"pane_id"`
	Agent  string    `json:"agent"`
	At     time.Time `json:"at"`
}

type Daemon struct {
	cfg   *Config
	store *Store
	herdr HerdrDriver

	// enrollments are the organizations this daemon serves, one Worker socket
	// each. A single-organization box has exactly one, called `default`, and
	// every path below reads the list rather than special-casing it.
	enrollments     []*enrollmentRuntime
	enrollmentsByID map[string]*enrollmentRuntime

	started time.Time

	mu sync.RWMutex
	// roster is the published agent list per enrollment. An agent belongs to
	// exactly one organization, so these partition rather than overlap.
	roster      map[string][]WireAgent
	herdrAgents []HerdrAgent
	// herdrAvailable records whether the Herdr socket answered on the most
	// recent attempt. Herdr is optional: a box whose harnesses all register
	// native adapters never needs it, so an outage degrades the daemon to
	// adapter-only instead of stopping it from starting.
	herdrAvailable bool
	paused         bool
	holds          map[string]draftHold
	inflight       map[string]*deliveryFlight
	commitWaiters  map[string][]chan sendOutcome
	rpcWaiters     map[string]chan RPCResponse
	adapters       map[string]*agentAdapter
	// nativeByName is keyed by enrollment and then by name: two organizations
	// may each have an agent called `clem`, and one flat map would hand one
	// organization's delivery to the other's agent.
	nativeByName map[string]map[string]*agentAdapter
	nativeNames  map[string]nativeName
	// nativeTokens indexes the identity credentials by token so a client that
	// re-presents one is recognised without scanning every record.
	nativeTokens map[string]string
	nextRPC      uint64
	kickRoster   chan struct{}
}

func newDaemon(cfg *Config, token string, store *Store, herdr HerdrDriver) *Daemon {
	d := &Daemon{
		cfg: cfg, store: store, herdr: herdr, started: time.Now(),
		herdrAvailable: true,
		holds:          make(map[string]draftHold), inflight: make(map[string]*deliveryFlight),
		commitWaiters: make(map[string][]chan sendOutcome),
		rpcWaiters:    make(map[string]chan RPCResponse), adapters: make(map[string]*agentAdapter),
		nativeByName: make(map[string]map[string]*agentAdapter), kickRoster: make(chan struct{}, 1),
		roster:          make(map[string][]WireAgent),
		enrollmentsByID: make(map[string]*enrollmentRuntime),
	}
	d.nativeNames = d.loadNativeNames()
	d.nativeTokens = make(map[string]string, len(d.nativeNames))
	for key, record := range d.nativeNames {
		if record.Token != "" {
			d.nativeTokens[record.Token] = key
		}
	}
	d.openEnrollments(token)
	return d
}

// openEnrollments builds one runtime per configured organization. The default
// enrollment reuses the store and token the daemon was opened with, so a
// single-organization box keeps the spool and credential it already has. An
// enrollment whose token or spool cannot be opened is kept with the failure
// recorded rather than dropped: a missing credential must be visible in
// `status`, not silently reduce the set of organizations this box serves.
func (d *Daemon) openEnrollments(defaultToken string) {
	entries := d.cfg.Enrollments
	if len(entries) == 0 {
		entries = []Enrollment{{ID: defaultEnrollment, URL: d.cfg.URL, Host: d.cfg.Host}}
	}
	for _, entry := range entries {
		token, store := defaultToken, d.store
		var failure error
		if entry.ID != defaultEnrollment {
			token, failure = readEnrollmentToken(entry)
			if failure == nil {
				store, failure = OpenStore(entry.storeRoot())
			}
		}
		runtime := newEnrollmentRuntime(entry, token, store)
		if failure != nil {
			runtime.token = ""
			runtime.store = nil
			runtime.setLastError(failure)
			d.logf("enrollment %s unavailable: %v", entry.ID, failure)
		}
		d.enrollments = append(d.enrollments, runtime)
		d.enrollmentsByID[entry.ID] = runtime
	}
}

func acquireDaemonLock(root string) (func(), error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(root, "daemon.lock")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		data, _ := os.ReadFile(path)
		file.Close()
		return nil, fmt.Errorf("transit daemon is already running (pid %s)", strings.TrimSpace(string(data)))
	}
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, err
	}
	if _, err := file.Seek(0, 0); err != nil {
		file.Close()
		return nil, err
	}
	if _, err := fmt.Fprintf(file, "%d\n", os.Getpid()); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

func (d *Daemon) logf(format string, args ...any) {
	log.Printf("transit: "+format, args...)
}

// setHerdrAvailable records the reachability of Herdr and logs only the
// transitions. A herdr-less box polls its roster every few seconds, so logging
// each failure would bury everything else in the daemon log.
func (d *Daemon) setHerdrAvailable(available bool, cause error) {
	d.mu.Lock()
	changed := d.herdrAvailable != available
	d.herdrAvailable = available
	d.mu.Unlock()
	if !changed {
		return
	}
	if available {
		d.logf("herdr available")
		return
	}
	d.logf("herdr unavailable (%v); running adapter-only", cause)
}

func (d *Daemon) herdrReachable() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.herdrAvailable
}

func (d *Daemon) notifyRoster() {
	select {
	case d.kickRoster <- struct{}{}:
	default:
	}
}

// notifyOutbox wakes every enrollment's flush loop. The IPC callers that use
// it have just enqueued into one spool, but which one is the caller's business
// and a spurious wake costs a tick.
func (d *Daemon) notifyOutbox() {
	for _, enrollment := range d.enrollments {
		enrollment.notifyOutbox()
	}
}

func (d *Daemon) registerCommit(id string) chan sendOutcome {
	waiter := make(chan sendOutcome, 1)
	d.mu.Lock()
	d.commitWaiters[id] = append(d.commitWaiters[id], waiter)
	d.mu.Unlock()
	return waiter
}

func (d *Daemon) removeCommit(id string, waiter chan sendOutcome) {
	d.mu.Lock()
	waiters := d.commitWaiters[id]
	for index, candidate := range waiters {
		if candidate == waiter {
			waiters = append(waiters[:index], waiters[index+1:]...)
			break
		}
	}
	if len(waiters) == 0 {
		delete(d.commitWaiters, id)
	} else {
		d.commitWaiters[id] = waiters
	}
	d.mu.Unlock()
}

func (d *Daemon) resolveCommit(id, code string, err error) {
	d.mu.Lock()
	waiters := d.commitWaiters[id]
	delete(d.commitWaiters, id)
	d.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- sendOutcome{Code: code, Err: err}
	}
}

func (d *Daemon) rpc(ctx context.Context, e *enrollmentRuntime, method string, params any) (RPCResponse, error) {
	connection := e.currentConnection()
	if connection == nil {
		return RPCResponse{}, fmt.Errorf("Transit is offline")
	}
	d.mu.Lock()
	d.nextRPC++
	rid := fmt.Sprintf("rpc_%d", d.nextRPC)
	waiter := make(chan RPCResponse, 1)
	d.rpcWaiters[rid] = waiter
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.rpcWaiters, rid)
		d.mu.Unlock()
	}()
	encoded, err := json.Marshal(params)
	if err != nil {
		return RPCResponse{}, err
	}
	if err := connection.write(ctx, WireFrame{T: "rpc", RID: rid, Method: method, Params: encoded}); err != nil {
		return RPCResponse{}, err
	}
	select {
	case response := <-waiter:
		return response, nil
	case <-ctx.Done():
		return RPCResponse{}, ctx.Err()
	}
}

func (d *Daemon) resolveRPC(rid string, response RPCResponse) {
	d.mu.RLock()
	waiter := d.rpcWaiters[rid]
	d.mu.RUnlock()
	if waiter != nil {
		select {
		case waiter <- response:
		default:
		}
	}
}
