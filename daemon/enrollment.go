package main

import (
	"sync"
)

// enrollmentRuntime is one live binding to one organization: its own Worker
// socket, its own device token, its own outbox partition, and its own view of
// which agents belong to it. The organization is a property of the credential
// the socket authenticates with, so nothing below the connection has to know
// or assert which organization a message is for.
type enrollmentRuntime struct {
	id    string
	url   string
	host  string
	token string
	store *Store

	mu         sync.RWMutex
	connection *wireConnection
	connected  bool
	lastError  string
	rosterHash string

	kickOutbox chan struct{}
}

func newEnrollmentRuntime(entry Enrollment, token string, store *Store) *enrollmentRuntime {
	return &enrollmentRuntime{
		id: entry.ID, url: entry.URL, host: entry.Host, token: token, store: store,
		kickOutbox: make(chan struct{}, 1),
	}
}

func (e *enrollmentRuntime) setConnection(connection *wireConnection) {
	e.mu.Lock()
	e.connection = connection
	e.connected = connection != nil
	e.mu.Unlock()
}

func (e *enrollmentRuntime) currentConnection() *wireConnection {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.connection
}

func (e *enrollmentRuntime) setLastError(err error) {
	e.mu.Lock()
	if err == nil {
		e.lastError = ""
	} else {
		e.lastError = err.Error()
	}
	e.mu.Unlock()
}

func (e *enrollmentRuntime) snapshot() (connected bool, lastError string) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.connected, e.lastError
}

func (e *enrollmentRuntime) notifyOutbox() {
	select {
	case e.kickOutbox <- struct{}{}:
	default:
	}
}

// enrollment resolves an id to its runtime, falling back to the default. An
// agent that names no enrollment belongs to the one the box was enrolled with,
// which is the only enrollment a single-organization daemon has.
func (d *Daemon) enrollment(id string) *enrollmentRuntime {
	if id != "" {
		if found := d.enrollmentsByID[id]; found != nil {
			return found
		}
	}
	return d.enrollmentsByID[defaultEnrollment]
}

// defaultEnrollmentRuntime is where Herdr-sourced agents live. A pane carries
// no organization of its own, so it belongs to the one the box enrolled with.
func (d *Daemon) defaultEnrollmentRuntime() *enrollmentRuntime {
	if found := d.enrollmentsByID[defaultEnrollment]; found != nil {
		return found
	}
	if len(d.enrollments) > 0 {
		return d.enrollments[0]
	}
	return nil
}

// enrollmentHost is the host name an agent's address carries. It belongs to
// the enrollment, not the box: one machine can be `titan` in one organization
// and something else entirely in another.
func (d *Daemon) enrollmentHost(id string) string {
	if runtime := d.enrollment(id); runtime != nil {
		return runtime.host
	}
	return d.cfg.Host
}

// enrollmentHostLocked is the same lookup for callers already holding d.mu.
// The enrollment list is built once at startup and never mutated, so it needs
// no lock of its own.
func (d *Daemon) enrollmentHostLocked(id string) string {
	return d.enrollmentHost(id)
}
