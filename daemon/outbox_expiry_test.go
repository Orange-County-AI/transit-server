package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A message whose recipient is never coming back used to retry at the 30s
// backoff ceiling forever while the sender was told nothing, because the only
// notice Transit ever sent was the one for a PERMANENT nak. Tincan, running on
// the same box, answers the sender with "undeliverable after 24h0m0s: <agent> -
// <reason>". This asserts Transit now does the same, and that the notice
// carries what a reader needs to judge staleness: the target, the age, the
// attempt count and the last transport error.
func TestOutboxExpiryReapsAndTellsTheSender(t *testing.T) {
	d := herdrlessDaemon(t)
	socket := serveHerdrlessAdapters(t, d)
	client := connectAdapter(t, socket, "omp", "session-1", "sender")

	e := d.enrollmentsByID["default"]
	if e == nil || e.store == nil {
		t.Fatal("the default enrollment has no store")
	}
	stale := &OutboxMessage{
		ID: "tx_stale", From: "sender@titan", To: "ghost@titan",
		Body:     "hold - get authorization from her own address",
		TS:       time.Now().UTC().Add(-25 * time.Hour),
		Attempts: 40, LastError: "agent_not_found",
	}
	// The boundary is the point: a queue that reaped everything would also pass
	// an assertion that only looked at the stale entry.
	fresh := &OutboxMessage{
		ID: "tx_fresh", From: "sender@titan", To: "ghost@titan",
		Body: "sent moments ago", TS: time.Now().UTC(),
	}
	for _, message := range []*OutboxMessage{stale, fresh} {
		if err := e.store.Enqueue(message); err != nil {
			t.Fatal(err)
		}
	}

	// reapExpired blocks until the adapter acknowledges the bounce, so the reap
	// runs here and the assertions stay on the test goroutine.
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.reapExpired(context.Background(), e)
	}()

	bounce := client.read(t)
	if bounce.T != "deliver" {
		t.Fatalf("bounce frame = %#v; want a deliver", bounce)
	}
	for _, want := range []string{
		"undeliverable to ghost@titan",
		"expired after 24h0m0s",
		"40 attempts",
		"agent_not_found",
	} {
		if !strings.Contains(bounce.Envelope, want) {
			t.Fatalf("bounce envelope %q lacks %q", bounce.Envelope, want)
		}
	}
	client.send(t, agentFrame{T: "deliver_ack", ID: bounce.ID, Persisted: true})
	<-done

	dead, err := e.store.ListDead()
	if err != nil {
		t.Fatal(err)
	}
	if len(dead) != 1 || dead[0].Message.ID != "tx_stale" {
		t.Fatalf("dead spool = %+v; want only tx_stale", dead)
	}
	if !strings.Contains(dead[0].Reason, "expired after 24h") {
		t.Fatalf("dead reason = %q; the listing must say why", dead[0].Reason)
	}
	outbox, deadCount, err := e.store.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if outbox != 1 || deadCount != 1 {
		t.Fatalf("outbox=%d dead=%d; the fresh message must survive the sweep", outbox, deadCount)
	}
}

// Expiry is time-based, not connection-based. An offline box past the TTL is
// exactly where the old behaviour hurt: outboxLoop only flushes while a
// connection exists, so a message could sit unexamined for days. The bounce is
// injected locally, so the sender still hears about it with the socket down.
func TestOutboxExpiryRunsWhileOffline(t *testing.T) {
	d := herdrlessDaemon(t)
	e := d.enrollmentsByID["default"]
	if e.currentConnection() != nil {
		t.Fatal("this daemon is supposed to have no connection")
	}
	if err := e.store.Enqueue(&OutboxMessage{
		ID: "tx_offline", From: "nobody@titan", To: "ghost@titan",
		Body: "queued while the socket was down",
		TS:   time.Now().UTC().Add(-48 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	// No adapter is registered, so the bounce cannot land and must not block
	// the sweep or resurrect the message.
	d.reapExpired(context.Background(), e)

	outbox, dead, err := e.store.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if outbox != 0 || dead != 1 {
		t.Fatalf("outbox=%d dead=%d; an offline box must still retire an expired message", outbox, dead)
	}
}

// The boundary deserves its own test with no adapter attached. Asserting it
// inside the bounce test above means a sweep that reaps everything blocks on an
// acknowledgement for the second bounce and fails by TIMEOUT rather than by
// saying what went wrong.
func TestOutboxExpirySparesAFreshMessage(t *testing.T) {
	d := herdrlessDaemon(t)
	e := d.enrollmentsByID["default"]
	for _, message := range []*OutboxMessage{
		{ID: "tx_old", From: "a@titan", To: "ghost@titan", Body: "old", TS: time.Now().UTC().Add(-25 * time.Hour)},
		{ID: "tx_new", From: "a@titan", To: "ghost@titan", Body: "new", TS: time.Now().UTC()},
	} {
		if err := e.store.Enqueue(message); err != nil {
			t.Fatal(err)
		}
	}

	d.reapExpired(context.Background(), e)

	remaining, err := e.store.ListOutbox()
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].ID != "tx_new" {
		t.Fatalf("outbox = %+v; the TTL must reap only what outlived it", remaining)
	}
}

// The two tests above call reapExpired directly, so deleting its call site from
// outboxLoop would leave both of them green and the feature dead. This drives
// the loop itself, with no connection, which is also the arrangement that used
// to guarantee the sweep never ran.
func TestOutboxLoopExpiresWithoutAConnection(t *testing.T) {
	d := herdrlessDaemon(t)
	e := d.enrollmentsByID["default"]
	if err := e.store.Enqueue(&OutboxMessage{
		ID: "tx_loop", From: "nobody@titan", To: "ghost@titan",
		Body: "queued long ago", TS: time.Now().UTC().Add(-72 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.outboxLoop(ctx, e)

	deadline := time.Now().Add(5 * time.Second)
	for {
		_, dead, err := e.store.Counts()
		if err != nil {
			t.Fatal(err)
		}
		if dead == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("outboxLoop never expired the message; the sweep is not wired into the loop")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
