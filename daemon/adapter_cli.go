package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	claudeHarness           = "claude"
	transcriptPollInterval  = 100 * time.Millisecond
	transcriptWatchTimeout  = 30 * time.Second
	adapterReconnectInitial = time.Second
	adapterReconnectMax     = 30 * time.Second
)

type claudeSessionState struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	CWD            string `json:"cwd"`
	Source         string `json:"source"`
}

type adapterFrame struct {
	Type          string `json:"t"`
	Proto         int    `json:"proto,omitempty"`
	Harness       string `json:"harness,omitempty"`
	SessionID     string `json:"session_id,omitempty"`
	PID           int    `json:"pid,omitempty"`
	CWD           string `json:"cwd,omitempty"`
	Title         string `json:"title,omitempty"`
	ID            string `json:"id,omitempty"`
	Envelope      string `json:"envelope,omitempty"`
	Persisted     bool   `json:"persisted,omitempty"`
	Code          string `json:"code,omitempty"`
	Retryable     bool   `json:"retryable,omitempty"`
	Capability    string `json:"capability,omitempty"`
	Status        string `json:"status,omitempty"`
	Agent         string `json:"agent,omitempty"`
	Address       string `json:"address,omitempty"`
	Generation    int    `json:"generation,omitempty"`
	Name          string `json:"name,omitempty"`
	PaneID        string `json:"pane_id,omitempty"`
	RegisterError string `json:"error,omitempty"`
}

type transcriptWatcher struct {
	path   string
	offset int64
	info   os.FileInfo
}

func newTranscriptWatcher(path string) *transcriptWatcher {
	watcher := &transcriptWatcher{path: path}
	if info, err := os.Stat(path); err == nil {
		watcher.offset = info.Size()
		watcher.info = info
	}
	return watcher
}

func (w *transcriptWatcher) containsNew(id string) (bool, error) {
	info, err := os.Stat(w.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if w.info != nil && !os.SameFile(w.info, info) {
		w.offset = 0
	}
	if info.Size() < w.offset {
		w.offset = 0
	}
	w.info = info
	if info.Size() == w.offset {
		return false, nil
	}

	file, err := os.Open(w.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	defer file.Close()
	if _, err := file.Seek(w.offset, io.SeekStart); err != nil {
		return false, err
	}
	bytes, err := io.ReadAll(file)
	if err != nil {
		return false, err
	}
	w.offset += int64(len(bytes))
	return strings.Contains(string(bytes), id), nil
}

func (w *transcriptWatcher) waitFor(ctx context.Context, id string, interval time.Duration) error {
	if interval <= 0 {
		interval = transcriptPollInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		found, err := w.containsNew(id)
		if err != nil {
			return err
		}
		if found {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

type adapterOptions struct {
	out          io.Writer
	socketPath   string
	watchTimeout time.Duration
	pollInterval time.Duration
}

func runAdapter(args []string) error {
	// `transit adapter listen --harness claude` — consume the subcommand word
	// so the flag set does not mistake it for a positional argument.
	if len(args) == 0 || args[0] != "listen" {
		return fmt.Errorf("usage: transit adapter listen --harness claude")
	}
	return runAdapterContext(context.Background(), args[1:], adapterOptions{})
}

// configuredAgentName is the address this session should own. Without it the
// daemon mints a fresh auto-name and the session registers alongside its own
// Herdr entry instead of superseding it, so the fleet keeps addressing the
// Herdr fallback. Empty means "let the daemon choose".
func configuredAgentName() string {
	for _, key := range []string{"TRANSIT_AGENT_NAME", "WORKSPACE_AGENT_NAME"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

// agentPaneID is the Herdr pane this session occupies, when it has one. The
// monitor inherits it from the Claude process, which inherits it from Herdr.
// Without it the daemon cannot tell that this adapter belongs to a pane that
// already has a name, so it mints a new one and the agent ends up listed
// twice — once as its pane and once as the adapter, with deliveries taking
// whichever path the sender happened to address.
func agentPaneID() string {
	return strings.TrimSpace(os.Getenv("HERDR_PANE_ID"))
}

func runAdapterContext(ctx context.Context, args []string, options adapterOptions) error {
	flags := flag.NewFlagSet("adapter listen", flag.ContinueOnError)
	harness := flags.String("harness", "", "agent harness")
	title := flags.String("title", "Transit agent messages", "agent title")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("adapter listen accepts no positional arguments")
	}
	if *harness != claudeHarness {
		return fmt.Errorf("unsupported adapter harness %q", *harness)
	}

	state, err := loadClaudeSessionState()
	if err != nil {
		return err
	}
	if options.out == nil {
		options.out = os.Stdout
	}
	if options.socketPath == "" {
		options.socketPath = agentSocketPath()
	}
	if options.watchTimeout <= 0 {
		options.watchTimeout = transcriptWatchTimeout
	}
	if options.pollInterval <= 0 {
		options.pollInterval = transcriptPollInterval
	}
	return runClaudeAdapter(ctx, state, *title, options)
}

func loadClaudeSessionState() (claudeSessionState, error) {
	if path := os.Getenv("CLAUDE_SESSION_STATE"); path != "" {
		state, err := readClaudeSessionState(path)
		if err != nil {
			return claudeSessionState{}, fmt.Errorf("read CLAUDE_SESSION_STATE %q: %w", path, err)
		}
		return state, nil
	}

	dir := filepath.Join(dataDir(), "claude-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return claudeSessionState{}, fmt.Errorf("no Claude session state found; install the Transit Claude plugin or set CLAUDE_SESSION_STATE")
		}
		return claudeSessionState{}, fmt.Errorf("read Claude session states: %w", err)
	}
	type candidate struct {
		path string
		mod  time.Time
	}
	var candidates []candidate
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		candidates = append(candidates, candidate{path: filepath.Join(dir, entry.Name()), mod: info.ModTime()})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].mod.After(candidates[j].mod) })
	if len(candidates) == 0 {
		return claudeSessionState{}, fmt.Errorf("no Claude session state found; install the Transit Claude plugin or set CLAUDE_SESSION_STATE")
	}
	state, err := readClaudeSessionState(candidates[0].path)
	if err != nil {
		return claudeSessionState{}, fmt.Errorf("read newest Claude session state %q: %w", candidates[0].path, err)
	}
	return state, nil
}

func readClaudeSessionState(path string) (claudeSessionState, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return claudeSessionState{}, err
	}
	var state claudeSessionState
	if err := json.Unmarshal(bytes, &state); err != nil {
		return claudeSessionState{}, fmt.Errorf("decode JSON: %w", err)
	}
	if state.SessionID == "" || state.TranscriptPath == "" || state.CWD == "" {
		return claudeSessionState{}, fmt.Errorf("state must include session_id, transcript_path, and cwd")
	}
	return state, nil
}

func runClaudeAdapter(ctx context.Context, state claudeSessionState, title string, options adapterOptions) error {
	backoff := adapterReconnectInitial
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		connection, err := (&net.Dialer{}).DialContext(ctx, "unix", options.socketPath)
		if err == nil {
			err = serveClaudeAdapterConnection(ctx, connection, state, title, options)
			_ = connection.Close()
			backoff = adapterReconnectInitial
			if err == nil {
				// A clean return still means the session lost its registration;
				// redial, but never in a tight loop.
				err = errors.New("adapter connection closed")
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > adapterReconnectMax {
				backoff = adapterReconnectMax
			}
		}
	}
}

func serveClaudeAdapterConnection(ctx context.Context, connection net.Conn, state claudeSessionState, title string, options adapterOptions) error {
	encoder := json.NewEncoder(connection)
	var writeMu sync.Mutex
	send := func(frame adapterFrame) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return encoder.Encode(frame)
	}
	if err := send(adapterFrame{
		Type:      "register",
		Proto:     1,
		Harness:   claudeHarness,
		SessionID: state.SessionID,
		PID:       os.Getpid(),
		CWD:       state.CWD,
		Title:     title,
		Status:    "idle",
		Name:      configuredAgentName(),
		PaneID:    agentPaneID(),
	}); err != nil {
		return fmt.Errorf("register adapter: %w", err)
	}

	watcher := newTranscriptWatcher(state.TranscriptPath)
	capability := ""
	decoder := json.NewDecoder(bufio.NewReader(connection))
	connectionDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-connectionDone:
		}
	}()
	defer close(connectionDone)

	for {
		var frame adapterFrame
		if err := decoder.Decode(&frame); err != nil {
			return err
		}
		switch frame.Type {
		case "registered":
			capability = frame.Capability
			if capability == "" {
				return fmt.Errorf("daemon registered adapter without capability")
			}
		case "register_err":
			if frame.RegisterError == "" {
				frame.RegisterError = frame.Code
			}
			return fmt.Errorf("adapter registration rejected: %s", frame.RegisterError)
		case "ping":
			if err := send(adapterFrame{Type: "pong", Capability: capability}); err != nil {
				return err
			}
		case "deliver":
			if capability == "" {
				return fmt.Errorf("daemon delivered before registration completed")
			}
			if err := handleClaudeDelivery(ctx, frame, capability, watcher, send, options); err != nil {
				return err
			}
		}
	}
}

func handleClaudeDelivery(ctx context.Context, frame adapterFrame, capability string, watcher *transcriptWatcher, send func(adapterFrame) error, options adapterOptions) error {
	if frame.ID == "" {
		return fmt.Errorf("delivery missing id")
	}
	// The transit/1 envelope is deliberately multi-line and its exact bytes are
	// golden-vector tested, so it is written verbatim. A Claude plugin monitor
	// forwards each stdout line as a notification; the <transit …> open and
	// close tags keep the envelope's boundaries unambiguous when it does.
	if _, err := io.WriteString(options.out, frame.Envelope+"\n"); err != nil {
		nakErr := send(adapterFrame{
			Type: "deliver_nak", ID: frame.ID, Code: "stdout_write_failed",
			Retryable: true, Capability: capability,
		})
		if nakErr != nil {
			return fmt.Errorf("write delivery %q to stdout: %w", frame.ID, err)
		}
		return fmt.Errorf("write delivery %q to stdout: %w", frame.ID, err)
	}

	waitCtx, cancel := context.WithTimeout(ctx, options.watchTimeout)
	err := watcher.waitFor(waitCtx, frame.ID, options.pollInterval)
	cancel()
	if err == nil {
		return send(adapterFrame{Type: "deliver_ack", ID: frame.ID, Persisted: true, Capability: capability})
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return send(adapterFrame{Type: "deliver_nak", ID: frame.ID, Code: "transcript_timeout", Retryable: true, Capability: capability})
	}
	if errors.Is(err, context.Canceled) && ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("watch transcript for delivery %q: %w", frame.ID, err)
}
