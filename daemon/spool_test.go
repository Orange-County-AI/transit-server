package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSpoolClaimReleaseAckAndReclaim(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	message := &OutboxMessage{
		From: "alice@alpha", To: "bob@beta", Body: "hello", TS: time.Now().UTC(),
	}
	if err := store.Enqueue(message); err != nil {
		t.Fatal(err)
	}
	if message.ID == "" {
		t.Fatal("enqueue did not assign an id")
	}
	claim, err := store.Claim(time.Now())
	if err != nil || claim == nil {
		t.Fatalf("Claim() = %#v, %v", claim, err)
	}
	if err := store.Release(claim, "offline"); err != nil {
		t.Fatal(err)
	}
	if immediate, err := store.Claim(time.Now()); err != nil || immediate != nil {
		t.Fatalf("immediate Claim() = %#v, %v; want backoff", immediate, err)
	}
	claim, err = store.Claim(time.Now().Add(31 * time.Second))
	if err != nil || claim == nil {
		t.Fatalf("retry Claim() = %#v, %v", claim, err)
	}
	if err := store.ReclaimOrphans(); err != nil {
		t.Fatal(err)
	}
	claim, err = store.Claim(time.Now().Add(31 * time.Second))
	if err != nil || claim == nil {
		t.Fatalf("reclaimed Claim() = %#v, %v", claim, err)
	}
	if err := store.Ack(claim); err != nil {
		t.Fatal(err)
	}
	if !store.SentRecorded(message.ID) {
		t.Fatal("acked id missing from history")
	}
	outbox, dead, err := store.Counts()
	if err != nil || outbox != 0 || dead != 0 {
		t.Fatalf("Counts() = %d, %d, %v", outbox, dead, err)
	}
}

// Both ends of a same-host message share one daemon, so the sender's outbox
// archive and the recipient's delivery archive collide on the id. When they
// shared a namespace the daemon acknowledged same-host deliveries it had never
// injected: the outbox record answered the delivery dedupe check.
func TestSentRecordDoesNotDedupeADelivery(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	message := &OutboxMessage{From: "alice@titan", To: "bob@titan", Body: "hello", TS: time.Now().UTC()}
	if err := store.Enqueue(message); err != nil {
		t.Fatal(err)
	}
	claim, err := store.Claim(time.Now())
	if err != nil || claim == nil {
		t.Fatalf("Claim() = %#v, %v", claim, err)
	}
	if err := store.Ack(claim); err != nil {
		t.Fatal(err)
	}
	if !store.SentRecorded(message.ID) {
		t.Fatal("acked id missing from the outbox archive")
	}
	if store.IncomingRecorded(message.ID) {
		t.Fatal("the sender's own record answered the delivery dedupe check")
	}

	if err := store.RecordIncoming(message.ID, "<transit/>"); err != nil {
		t.Fatal(err)
	}
	if !store.IncomingRecorded(message.ID) {
		t.Fatal("injected delivery was not archived")
	}
}

// A record written before the archives were split is flat, and only an
// injected delivery carried an envelope.
func TestLegacyFlatHistoryStillDedupesDeliveries(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(root, "history", "tx_legacy000001.json")
	if err := writeJSONAtomic(legacy, HistoryRecord{
		ID: "tx_legacy000001", Envelope: "<transit/>", At: time.Now().UTC(),
	}, 0o600); err != nil {
		t.Fatal(err)
	}
	if !store.IncomingRecorded("tx_legacy000001") {
		t.Fatal("a legacy delivery record no longer dedupes")
	}
}

func TestSpoolDeduplicatesAndDeadLetters(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	message := &OutboxMessage{
		ID: "tx_001122334455", From: "alice@alpha", To: "bob@beta", Body: "hello",
		TS: time.Now().UTC(),
	}
	if err := store.Enqueue(message); err != nil {
		t.Fatal(err)
	}
	if err := store.Enqueue(message); err != nil {
		t.Fatal(err)
	}
	outbox, _, _ := store.Counts()
	if outbox != 1 {
		t.Fatalf("outbox = %d, want 1", outbox)
	}
	claim, err := store.Claim(time.Now())
	if err != nil || claim == nil {
		t.Fatalf("Claim() = %#v, %v", claim, err)
	}
	if err := store.Kill(claim, "no_route"); err != nil {
		t.Fatal(err)
	}
	_, dead, _ := store.Counts()
	if dead != 1 {
		t.Fatalf("dead = %d, want 1", dead)
	}
}
