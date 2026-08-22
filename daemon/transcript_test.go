package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTranscriptContainsFindsADeliveryInTheTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	// A session file outgrows any tail this daemon would read, so the id has to
	// be found near the end or not at all.
	filler := strings.Repeat("{\"role\":\"assistant\",\"text\":\"padding padding padding\"}\n", 20_000)
	body := filler + "{\"role\":\"user\",\"text\":\"<transit id=\\\"tx_landed00001\\\">hello</transit>\"}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if int64(len(body)) <= transcriptTailBytes {
		t.Fatalf("fixture is %d bytes, needs to exceed the %d byte tail", len(body), transcriptTailBytes)
	}

	found, err := transcriptContains(path, "tx_landed00001")
	if err != nil || !found {
		t.Fatalf("transcriptContains(landed) = %t, %v; want true", found, err)
	}
	found, err = transcriptContains(path, "tx_absent000001")
	if err != nil || found {
		t.Fatalf("transcriptContains(absent) = %t, %v; want false", found, err)
	}
}

func TestTranscriptContainsReportsUnreadableFiles(t *testing.T) {
	if _, err := transcriptContains(filepath.Join(t.TempDir(), "missing.jsonl"), "tx_x"); err == nil {
		t.Fatal("a missing transcript reported no error, so an unproven delivery would look settled")
	}
	if _, err := transcriptContains("", "tx_x"); err == nil {
		t.Fatal("an empty path reported no error")
	}
}
