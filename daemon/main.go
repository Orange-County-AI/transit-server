package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
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
	token, err := readToken()
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

	herdrPath, err := herdrSocketPath(cfg)
	if err != nil {
		return err
	}
	driver := newHerdrSocket(herdrPath, func(message string) { log.Print("transit: ", message) })
	herdrVersion, protocol, err := driver.Ping(context.Background())
	if err != nil {
		return err
	}
	daemon := newDaemon(cfg, token, store, driver)
	if _, err := daemon.refreshRoster(context.Background()); err != nil {
		return err
	}
	log.Printf("transit: herdr %s protocol %d, host %s", herdrVersion, protocol, cfg.Host)

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
	wait.Add(5)
	go func() { defer wait.Done(); _ = serveIPC(ctx, listener, daemon) }()
	go func() { defer wait.Done(); _ = serveAgentSocket(ctx, agentListener, daemon) }()
	go func() { defer wait.Done(); daemon.wireLoop(ctx) }()
	go func() { defer wait.Done(); daemon.rosterLoop(ctx) }()
	go func() { defer wait.Done(); daemon.outboxLoop(ctx) }()
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
	fmt.Printf("host: %v\nconnected: %v\npaused: %v\nagents: %v\noutbox: %v\ndead: %v\nlast error: %v\n",
		response["host"], response["connected"], response["paused"], response["agents"],
		response["outbox"], response["dead"], response["last_error"])
	return nil
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
		if !*watch {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
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
