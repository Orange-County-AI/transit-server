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
	foundListRooms := false
	foundJoinRoom := false
	foundLeaveRoom := false
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
			if description := properties["to"].(map[string]any)["description"]; description != "Target name@host, organization/name@host, #room, or organization/#room." {
				t.Fatalf("send_message to description = %q", description)
			}
		case "list_rooms":
			foundListRooms = true
			if description := properties["organization"].(map[string]any)["description"]; description != "Optional connected organization slug." {
				t.Fatalf("list_rooms organization description = %q", description)
			}
		case "create_room":
			foundCreate = true
			if _, exists := properties["address"]; exists {
				t.Fatal("create_room exposes model-controlled creator address")
			}
			if description := properties["name"].(map[string]any)["description"]; description != "Plain room name; a room is always created in your own organization." {
				t.Fatalf("create_room name description = %q", description)
			}
			required := schema["required"].([]any)
			if len(required) != 1 || required[0] != "name" {
				t.Fatalf("create_room required = %v", required)
			}
			policies := properties["policy"].(map[string]any)["enum"].([]any)
			if len(policies) != 2 || policies[0] != "open" || policies[1] != "invite" {
				t.Fatalf("create_room policies = %v", policies)
			}
		case "join_room":
			foundJoinRoom = true
			if description := properties["room"].(map[string]any)["description"]; description != "Room name, #room, or organization/#room for a connected organization's room." {
				t.Fatalf("join_room room description = %q", description)
			}
		case "leave_room":
			foundLeaveRoom = true
			if description := properties["room"].(map[string]any)["description"]; description != "Room name, #room, or organization/#room for a connected organization's room." {
				t.Fatalf("leave_room room description = %q", description)
			}
		}
	}
	if !foundSend {
		t.Fatal("send_message tool missing")
	}
	if !foundCreate {
		t.Fatal("create_room tool missing")
	}
	if !foundListRooms {
		t.Fatal("list_rooms tool missing")
	}
	if !foundJoinRoom {
		t.Fatal("join_room tool missing")
	}
	if !foundLeaveRoom {
		t.Fatal("leave_room tool missing")
	}
}

func TestMCPListRoomsForwardsOrganization(t *testing.T) {
	t.Setenv("TRANSIT_DATA_DIR", t.TempDir())
	listener, err := listenIPC(socketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	requests := make(chan map[string]any, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()

		var request map[string]any
		if json.NewDecoder(connection).Decode(&request) != nil {
			return
		}
		requests <- request
		_ = writeJSONLine(connection, success(map[string]any{"result": []any{}}))
	}()

	if _, err := dispatchMCPTool("list_rooms", json.RawMessage(`{"organization":"peer-org"}`)); err != nil {
		t.Fatal(err)
	}
	request := <-requests
	if request["op"] != "rpc" || request["method"] != "list_rooms" {
		t.Fatalf("request = %#v", request)
	}
	params := request["params"].(map[string]any)
	if params["organization"] != "peer-org" {
		t.Fatalf("organization = %q", params["organization"])
	}
}
