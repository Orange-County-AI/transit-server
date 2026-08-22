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

type Daemon struct {
	cfg   *Config
	token string
	store *Store
	herdr HerdrDriver

	started time.Time

	mu            sync.RWMutex
	roster        []WireAgent
	herdrAgents   []HerdrAgent
	rosterHash    string
	connection    *wireConnection
	connected     bool
	lastError     string
	paused        bool
	holds         map[string]bool
	inflight      map[string]*deliveryFlight
	commitWaiters map[string][]chan sendOutcome
	rpcWaiters    map[string]chan RPCResponse
	adapters      map[string]*agentAdapter
	nativeByName  map[string]*agentAdapter
	nativeNames   map[string]nativeName
	nextRPC       uint64
	kickRoster    chan struct{}
	kickOutbox    chan struct{}
}

func newDaemon(cfg *Config, token string, store *Store, herdr HerdrDriver) *Daemon {
	d := &Daemon{
		cfg: cfg, token: token, store: store, herdr: herdr, started: time.Now(),
		holds: make(map[string]bool), inflight: make(map[string]*deliveryFlight),
		commitWaiters: make(map[string][]chan sendOutcome),
		rpcWaiters:    make(map[string]chan RPCResponse), adapters: make(map[string]*agentAdapter),
		nativeByName: make(map[string]*agentAdapter), kickRoster: make(chan struct{}, 1),
		kickOutbox: make(chan struct{}, 1),
	}
	d.nativeNames = d.loadNativeNames()
	return d
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

func (d *Daemon) setLastError(err error) {
	d.mu.Lock()
	if err == nil {
		d.lastError = ""
	} else {
		d.lastError = err.Error()
	}
	d.mu.Unlock()
}

func (d *Daemon) setConnection(connection *wireConnection) {
	d.mu.Lock()
	d.connection = connection
	d.connected = connection != nil
	d.mu.Unlock()
}

func (d *Daemon) currentConnection() *wireConnection {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.connection
}

func (d *Daemon) notifyRoster() {
	select {
	case d.kickRoster <- struct{}{}:
	default:
	}
}

func (d *Daemon) notifyOutbox() {
	select {
	case d.kickOutbox <- struct{}{}:
	default:
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

func (d *Daemon) rpc(ctx context.Context, method string, params any) (RPCResponse, error) {
	connection := d.currentConnection()
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
