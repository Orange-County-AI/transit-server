package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var version = "dev"
var commit = "unknown"

func buildVersion() string {
	if commit == "" || commit == "unknown" {
		return version
	}
	return version + "+" + commit
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "transit:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: transit <daemon|adapter|enroll|config|status|inbox|pause|mcp|version>")
	}
	switch args[0] {
	case "daemon":
		return runDaemon(args[1:])
	case "adapter":
		return runAdapter(args[1:])
	case "enroll":
		return runEnroll(args[1:])
	case "config":
		return runConfig(args[1:])
	case "status":
		return runStatus(args[1:])
	case "inbox":
		return runInbox(args[1:])
	case "pause":
		return runPause(args[1:])
	case "mcp":
		return runMCP(args[1:])
	case "version":
		fmt.Println(buildVersion())
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runDaemon(args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: transit daemon")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	token, err := readEnrollmentToken(Enrollment{ID: defaultEnrollment})
	if err != nil {
		return err
	}
	store, err := OpenStore(dataDir())
	if err != nil {
		return err
	}
	release, err := acquireDaemonLock(store.root)
	if err != nil {
		return err
	}
	defer release()
	if err := store.ReclaimOrphans(); err != nil {
		return err
	}

	// Herdr is a delivery transport, not a prerequisite. A box whose harnesses
	// all register native adapters — Claude Code's monitor, the OMP extension —
	// has no use for it, and refusing to start there left those boxes with no
	// Transit at all. An unreachable Herdr degrades delivery for the agents
	// that need typing; it does not stop the daemon.
	herdrPath, pathErr := herdrSocketPath(cfg)
	if pathErr != nil {
		herdrPath = ""
	}
	driver := newHerdrSocket(herdrPath, func(message string) { log.Print("transit: ", message) })
	daemon := newDaemon(cfg, token, store, driver)
	herdrVersion, protocol, pingErr := driver.Ping(context.Background())
	if pingErr != nil {
		cause := pingErr
		if pathErr != nil {
			cause = pathErr
		}
		daemon.setHerdrAvailable(false, cause)
	} else {
		log.Printf("transit: herdr %s protocol %d, host %s", herdrVersion, protocol, cfg.Host)
	}
	if _, err := daemon.refreshRoster(context.Background()); err != nil {
		log.Printf("transit: initial roster refresh: %v", err)
	}

	listener, err := listenIPC(socketPath())
	if err != nil {
		return err
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(socketPath())
	}()
	agentListener, err := listenAgentSocket(agentSocketPath())
	if err != nil {
		return err
	}
	defer func() {
		_ = agentListener.Close()
		_ = os.Remove(agentSocketPath())
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var wait sync.WaitGroup
	wait.Add(4)
	go func() { defer wait.Done(); _ = serveIPC(ctx, listener, daemon) }()
	go func() { defer wait.Done(); _ = serveAgentSocket(ctx, agentListener, daemon) }()
	go func() { defer wait.Done(); daemon.rosterLoop(ctx) }()
	go func() { defer wait.Done(); daemon.holdLoop(ctx) }()
	// One socket and one flush loop per organization. They share the identity
	// store and the Herdr driver; they share nothing that carries a message.
	for _, enrollment := range daemon.enrollments {
		wait.Add(2)
		go func() { defer wait.Done(); daemon.wireLoop(ctx, enrollment) }()
		go func() { defer wait.Done(); daemon.outboxLoop(ctx, enrollment) }()
	}
	<-ctx.Done()
	listener.Close()
	agentListener.Close()
	wait.Wait()
	return nil
}

func runConfig(args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: transit config")
	}
	path, err := configPath()
	if err != nil {
		return err
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	endpoint, err := wireURL(cfg.URL)
	if err != nil {
		return err
	}
	fmt.Printf("config: %s\nserver: %s\nwebsocket: %s\n", path, cfg.URL, endpoint)
	return nil
}

func runStatus(args []string) error {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	ensure := flags.Bool("ensure-daemon", false, "start the daemon when absent")
	kick := flags.Bool("kick", false, "refresh roster and outbox")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	request := map[string]any{"op": "status"}
	if *kick {
		request = map[string]any{"op": "kick"}
	}
	response, err := daemonCall(request)
	if err != nil && *ensure {
		if startErr := startDetachedDaemon(); startErr != nil {
			return startErr
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			response, err = daemonCall(request)
			if err == nil {
				break
			}
		}
	}
	if err != nil {
		return err
	}
	if responseErr := responseError(response); responseErr != nil {
		return responseErr
	}
	if *jsonOutput {
		return writeJSONLine(os.Stdout, response)
	}
	if *kick {
		fmt.Println("Transit daemon kicked")
		return nil
	}
	fmt.Printf("host: %v\nconnected: %v\npaused: %v\nmode: %v\nagents: %v\noutbox: %v\ndead: %v\nlast error: %v\n",
		response["host"], response["connected"], response["paused"], response["delivery_mode"],
		response["agents"], response["outbox"], response["dead"], response["last_error"])
	// Only the unhappy case prints: an available Herdr is the unremarkable
	// default and does not deserve a line in every status read.
	if available, ok := response["herdr"].(bool); ok && !available {
		fmt.Println("herdr: unavailable")
	}
	// The adapter rows answer "who actually receives natively", which the agent
	// count cannot: an agent present in the Herdr roster and absent here is one
	// whose delivery falls back to typing into its pane.
	for _, adapter := range adapterRows(response) {
		fmt.Printf("adapter %s (%s, %s, %s, pid %d)\n", adapter.Name, adapter.Harness, adapter.NamedBy, adapter.Anchor, adapter.PID)
	}
	for _, hold := range draftHoldRows(response) {
		fmt.Printf("holding %s since %s\n", hold.PaneID, hold.At.Format(time.RFC3339))
	}
	return nil
}

// draftHoldRows decodes the holds an IPC response carries. A malformed or
// absent list prints nothing rather than failing a status read.
func draftHoldRows(response map[string]any) []draftHold {
	raw, err := json.Marshal(response["draft_holds"])
	if err != nil {
		return nil
	}
	var holds []draftHold
	if err := json.Unmarshal(raw, &holds); err != nil {
		return nil
	}
	return holds
}

// adapterRow is the CLI's view of one live native adapter. It mirrors
// draftHoldRows: a malformed or absent list prints nothing rather than
// failing a status read, because status is what an operator reaches for when
// something is already wrong.
type adapterRow struct {
	Name    string `json:"name"`
	Harness string `json:"harness"`
	NamedBy string `json:"named_by"`
	// Anchor says how the address is held: `name` and `token` survive a
	// restart, `session` does not. An address that is about to change should
	// not read the same as one that will not.
	Anchor string `json:"anchor"`
	PID    int    `json:"pid"`
}

func adapterRows(response map[string]any) []adapterRow {
	raw, err := json.Marshal(response["adapters"])
	if err != nil {
		return nil
	}
	var adapters []adapterRow
	if err := json.Unmarshal(raw, &adapters); err != nil {
		return nil
	}
	return adapters
}

func startDetachedDaemon() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(dataDir(), "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	command := exec.Command(executable, "daemon")
	command.Stdin = nil
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func runInbox(args []string) error {
	flags := flag.NewFlagSet("inbox", flag.ContinueOnError)
	watch := flags.Bool("watch", false, "refresh until interrupted")
	delivered := flags.Bool("delivered", false, "list recent deliveries and the transport each took")
	limit := flags.Int("limit", 20, "how many deliveries to list")
	if err := flags.Parse(args); err != nil {
		return err
	}
	for {
		response, err := daemonCall(map[string]any{"op": "inbox"})
		if err != nil {
			return err
		}
		if err := responseError(response); err != nil {
			return err
		}
		if *watch {
			fmt.Print("\033[H\033[2J")
		}
		outbox, _ := response["outbox"].([]any)
		dead, _ := response["dead"].([]any)
		fmt.Printf("TRANSIT INBOX\n\nOUTBOX  %d\nDEAD    %d\n", len(outbox), len(dead))
		// A count on its own cannot be acted on, and a dead letter is the one
		// spool entry nobody is ever told about: the send failed, the sender
		// moved on, and the intended recipient never knew it was tried. So the
		// entries are printed, not just tallied.
		for _, row := range spoolRows(response, "outbox") {
			fmt.Printf("\nOUTBOX  %s -> %s  %s\n  %s\n",
				row.ID, row.To, row.TS.Format(time.RFC3339), previewLine(row.Body))
		}
		for _, row := range deadRows(response) {
			reason := row.Reason
			if reason == "" {
				reason = "unrecorded"
			}
			to, id, body, ts := "unknown", "", "", row.At
			if row.Message != nil {
				to, id, body, ts = row.Message.To, row.Message.ID, row.Message.Body, row.Message.TS
			}
			fmt.Printf("\nDEAD    %s -> %s  %s  (%s)\n  %s\n",
				id, to, ts.Format(time.RFC3339), reason, previewLine(body))
		}
		if holds := draftHoldRows(response); len(holds) > 0 {
			fmt.Print("\nHELD\n")
			for _, hold := range holds {
				fmt.Printf("  %s (%s) since %s — clear your composer and it delivers on its own\n",
					hold.PaneID, hold.Agent, hold.At.Format(time.RFC3339))
			}
		}
		// The transport a delivery took is only answerable from the record.
		// A live adapter list says who would receive natively right now, not
		// how any particular message got there.
		if *delivered {
			rows := deliveredRows(response)
			if *limit > 0 && len(rows) > *limit {
				rows = rows[:*limit]
			}
			fmt.Print("\nDELIVERED\n")
			for _, row := range rows {
				via := row.Via
				if via == "" {
					via = "unrecorded"
				}
				fmt.Printf("  %s  %-16s via %-10s %s\n",
					row.At.Format(time.RFC3339), row.Agent, via, row.ID)
			}
			if len(rows) == 0 {
				fmt.Println("  (none)")
			}
		}
		if !*watch {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
}

// deliveredRows decodes the delivery history an IPC response carries, matching
// draftHoldRows: a malformed or absent list prints nothing rather than failing.
func deliveredRows(response map[string]any) []HistoryRecord {
	raw, err := json.Marshal(response["delivered"])
	if err != nil {
		return nil
	}
	var records []HistoryRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil
	}
	return records
}

// spoolRows and deadRows decode the outbox and dead-letter lists an IPC
// response carries, matching deliveredRows: a malformed or absent list prints
// nothing rather than failing the read.
func spoolRows(response map[string]any, key string) []OutboxMessage {
	raw, err := json.Marshal(response[key])
	if err != nil {
		return nil
	}
	var records []OutboxMessage
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil
	}
	return records
}

func deadRows(response map[string]any) []DeadMessage {
	raw, err := json.Marshal(response["dead"])
	if err != nil {
		return nil
	}
	var records []DeadMessage
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil
	}
	return records
}

// previewLine keeps a spool listing to one line per message: a dead letter can
// carry a full 64 KiB body, and the point of the listing is to decide which
// ones to open.
func previewLine(body string) string {
	flat := strings.Join(strings.Fields(body), " ")
	if flat == "" {
		return "(empty body)"
	}
	if clipped, ok := clipRunes(flat, 120); ok {
		return clipped + "…"
	}
	return flat
}

func runPause(args []string) error {
	flags := flag.NewFlagSet("pause", flag.ContinueOnError)
	toggle := flags.Bool("toggle", false, "toggle delivery pause")
	if err := flags.Parse(args); err != nil {
		return err
	}
	response, err := daemonCall(map[string]any{"op": "pause", "toggle": *toggle})
	if err != nil {
		return err
	}
	if err := responseError(response); err != nil {
		return err
	}
	fmt.Printf("paused: %v\n", response["paused"])
	return nil
}
