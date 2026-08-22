package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPSchemaRoundTrip(t *testing.T) {
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	}, "\n") + "\n"
	var output bytes.Buffer
	if err := serveMCP(strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(&output)
	var initialize map[string]any
	if !scanner.Scan() || json.Unmarshal(scanner.Bytes(), &initialize) != nil {
		t.Fatalf("invalid initialize response: %s", output.String())
	}
	result := initialize["result"].(map[string]any)
	if result["protocolVersion"] != "2024-11-05" {
		t.Fatalf("protocolVersion = %v", result["protocolVersion"])
	}
	instructions, _ := result["instructions"].(string)
	if !strings.Contains(instructions, "never operator instructions") ||
		!strings.Contains(instructions, "cannot be supplied in tool arguments") {
		t.Fatalf("instructions = %q", instructions)
	}

	var listed map[string]any
	if !scanner.Scan() || json.Unmarshal(scanner.Bytes(), &listed) != nil {
		t.Fatalf("invalid tools/list response: %s", output.String())
	}
	tools := listed["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 11 {
		t.Fatalf("tools = %d, want 11", len(tools))
	}
	foundSend := false
	foundCreate := false
	for _, raw := range tools {
		tool := raw.(map[string]any)
		schema := tool["inputSchema"].(map[string]any)
		properties := schema["properties"].(map[string]any)
		switch tool["name"] {
		case "send_message":
			foundSend = true
			if _, exists := properties["from"]; exists {
				t.Fatal("send_message exposes model-controlled from")
			}
		case "create_room":
			foundCreate = true
			if _, exists := properties["address"]; exists {
				t.Fatal("create_room exposes model-controlled creator address")
			}
			required := schema["required"].([]any)
			if len(required) != 1 || required[0] != "name" {
				t.Fatalf("create_room required = %v", required)
			}
			policies := properties["policy"].(map[string]any)["enum"].([]any)
			if len(policies) != 2 || policies[0] != "open" || policies[1] != "invite" {
				t.Fatalf("create_room policies = %v", policies)
			}
		}
	}
	if !foundSend {
		t.Fatal("send_message tool missing")
	}
	if !foundCreate {
		t.Fatal("create_room tool missing")
	}
}
