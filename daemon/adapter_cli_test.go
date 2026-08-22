package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The SessionStart hook writes the file the monitor reads to learn which
// Claude session it belongs to. A single stray escape once made it emit a
// literal backslash-n after the JSON, which decodes as garbage and silently
// unregisters the harness, so the hook's exact bytes are worth a test.
func TestClaudeSessionStartHookWritesDecodableState(t *testing.T) {
	for _, tool := range []string{"bash", "node"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	hook := filepath.Join("plugin", "claude", "hooks", "session-start.sh")
	if _, err := os.Stat(hook); err != nil {
		t.Fatalf("hook missing: %v", err)
	}

	dataDir := t.TempDir()
	transcript := filepath.Join(dataDir, "transcript.jsonl")
	command := exec.Command("bash", hook)
	command.Env = append(os.Environ(), "TRANSIT_DATA_DIR="+dataDir)
	command.Stdin = strings.NewReader(`{"session_id":"hook-test-1","transcript_path":"` +
		transcript + `","cwd":"` + dataDir + `","source":"startup"}`)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("hook failed: %v: %s", err, output)
	}

	raw, err := os.ReadFile(filepath.Join(dataDir, "claude-sessions", "hook-test-1.json"))
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if bytes.Contains(raw, []byte(`\n`)) {
		t.Fatalf("state file contains a literal backslash-n: %q", raw)
	}
	var state claudeSessionState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatalf("state does not decode: %v: %q", err, raw)
	}
	if state.SessionID != "hook-test-1" || state.TranscriptPath != transcript {
		t.Fatalf("unexpected state: %+v", state)
	}
}

func TestAdapterTranscriptWatcherFindsAppendedDelivery(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(transcript, []byte("existing entry\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	watcher := newTranscriptWatcher(transcript)
	if err := os.WriteFile(transcript, []byte("existing entry\nreceipt tx-appended\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	found, err := watcher.containsNew("tx-appended")
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("watcher did not find an appended delivery id")
	}
}

func TestAdapterTranscriptWatcherIgnoresOtherFiles(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "transcript.jsonl")
	if err := os.WriteFile(transcript, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	watcher := newTranscriptWatcher(transcript)
	if err := os.WriteFile(filepath.Join(dir, "unrelated.jsonl"), []byte("tx-only-elsewhere"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := watcher.waitFor(ctx, "tx-only-elsewhere", time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waitFor error = %v, want deadline exceeded", err)
	}
}

func TestAdapterTranscriptWatcherHandlesTruncation(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(transcript, []byte("long original transcript content"), 0o600); err != nil {
		t.Fatal(err)
	}
	watcher := newTranscriptWatcher(transcript)
	if err := os.WriteFile(transcript, []byte("tx-after-truncate"), 0o600); err != nil {
		t.Fatal(err)
	}
	found, err := watcher.containsNew("tx-after-truncate")
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("watcher did not reset its offset after truncation")
	}
}

func TestAdapterRoundTripWaitsForTranscriptReceipt(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "agent.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	transcript := filepath.Join(dir, "transcript.jsonl")
	if err := os.WriteFile(transcript, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var stdout bytes.Buffer
	adapterDone := make(chan error, 1)
	go func() {
		adapterDone <- runClaudeAdapter(ctx, claudeSessionState{
			SessionID:      "session-1",
			TranscriptPath: transcript,
			CWD:            dir,
		}, "Transit agent messages", adapterOptions{
			out:          &stdout,
			socketPath:   socket,
			watchTimeout: time.Second,
			pollInterval: time.Millisecond,
		})
	}()

	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	decoder := json.NewDecoder(connection)
	encoder := json.NewEncoder(connection)
	var register adapterFrame
	if err := decoder.Decode(&register); err != nil {
		t.Fatal(err)
	}
	if register.Type != "register" || register.Proto != 1 || register.Harness != claudeHarness || register.SessionID != "session-1" || register.PID == 0 || register.CWD != dir || register.Title != "Transit agent messages" || register.Status != "idle" {
		t.Fatalf("register = %#v", register)
	}
	if err := encoder.Encode(adapterFrame{Type: "registered", Capability: "capability"}); err != nil {
		t.Fatal(err)
	}
	if err := encoder.Encode(adapterFrame{Type: "deliver", ID: "tx-receipt", Envelope: "<transit id=\"tx-receipt\"/>"}); err != nil {
		t.Fatal(err)
	}

	acknowledgement := make(chan adapterFrame, 1)
	readError := make(chan error, 1)
	go func() {
		var frame adapterFrame
		if err := decoder.Decode(&frame); err != nil {
			readError <- err
			return
		}
		acknowledgement <- frame
	}()
	select {
	case frame := <-acknowledgement:
		t.Fatalf("received %q before transcript receipt: %#v", frame.Type, frame)
	case err := <-readError:
		t.Fatalf("read acknowledgement: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	if stdout.String() != "<transit id=\"tx-receipt\"/>\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if err := os.WriteFile(transcript, []byte("receipt tx-receipt\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case frame := <-acknowledgement:
		if frame.Type != "deliver_ack" || frame.ID != "tx-receipt" || !frame.Persisted || frame.Capability != "capability" {
			t.Fatalf("acknowledgement = %#v", frame)
		}
	case err := <-readError:
		t.Fatalf("read acknowledgement: %v", err)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for transcript acknowledgement")
	}
	cancel()
	select {
	case err := <-adapterDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("adapter returned %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("adapter did not stop after cancellation")
	}
}
