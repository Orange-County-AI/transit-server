package main

import (
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
	if !store.HistoryExists(message.ID) {
		t.Fatal("acked id missing from history")
	}
	outbox, dead, err := store.Counts()
	if err != nil || outbox != 0 || dead != 0 {
		t.Fatalf("Counts() = %d, %d, %v", outbox, dead, err)
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
