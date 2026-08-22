package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
)

type request struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

type fakeAgent struct {
	Name           string `json:"name"`
	Kind           string `json:"agent"`
	Status         string `json:"agent_status"`
	PaneID         string `json:"pane_id"`
	CWD            string `json:"cwd"`
	Title          string `json:"terminal_title_stripped"`
	StateChangeSeq uint64 `json:"state_change_seq"`
}

func main() {
	socket := flag.String("socket", "", "Unix socket path")
	name := flag.String("name", "agent", "agent name")
	pane := flag.String("pane", "w1:p1", "pane id")
	prompts := flag.String("prompts", "", "prompt log path")
	flag.Parse()
	if *socket == "" {
		fmt.Fprintln(os.Stderr, "--socket is required")
		os.Exit(2)
	}
	if err := os.MkdirAll(filepath.Dir(*socket), 0o700); err != nil {
		panic(err)
	}
	_ = os.Remove(*socket)
	listener, err := net.Listen("unix", *socket)
	if err != nil {
		panic(err)
	}
	defer listener.Close()
	_ = os.Chmod(*socket, 0o600)

	agent := &fakeAgent{
		Name: *name, Kind: "omp", Status: "idle", PaneID: *pane,
		CWD: "/tmp/" + *name, Title: *name,
	}
	var mu sync.Mutex
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go serve(connection, agent, &mu, *prompts)
	}
}

func serve(connection net.Conn, agent *fakeAgent, mu *sync.Mutex, prompts string) {
	defer connection.Close()
	var req request
	if json.NewDecoder(connection).Decode(&req) != nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	result, apiError := handle(req, agent, prompts)
	response := map[string]any{"id": req.ID}
	if apiError != nil {
		response["error"] = apiError
	} else {
		response["result"] = result
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func handle(req request, agent *fakeAgent, prompts string) (any, map[string]any) {
	switch req.Method {
	case "ping":
		return map[string]any{"type": "pong", "version": "fake", "protocol": 20}, nil
	case "agent.list":
		return map[string]any{"type": "agent_list", "agents": []any{agent}}, nil
	case "agent.get":
		if target, _ := req.Params["target"].(string); target != agent.Name && target != agent.PaneID {
			return nil, map[string]any{"code": "agent_not_found", "message": "agent not found"}
		}
		return map[string]any{"type": "agent_info", "agent": agent}, nil
	case "pane.read":
		return map[string]any{"type": "pane_read", "read": map[string]any{"text": "╰─ ─╯"}}, nil
	case "agent.prompt":
		text, _ := req.Params["text"].(string)
		if prompts != "" {
			file, err := os.OpenFile(prompts, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if err == nil {
				writer := bufio.NewWriter(file)
				_, _ = fmt.Fprintln(writer, text)
				_ = writer.Flush()
				_ = file.Close()
			}
		}
		agent.StateChangeSeq++
		return map[string]any{"type": "agent_prompted", "agent": agent}, nil
	case "agent.wait":
		return map[string]any{"type": "agent_info", "agent": agent}, nil
	case "pane.send_keys", "notification.show":
		return map[string]any{"type": "ok"}, nil
	case "agent.rename":
		name, _ := req.Params["name"].(string)
		agent.Name = name
		agent.StateChangeSeq++
		return map[string]any{"type": "agent_info", "agent": agent}, nil
	default:
		return nil, map[string]any{"code": "unknown_method", "message": req.Method}
	}
}
