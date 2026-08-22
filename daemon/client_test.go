package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWireClientAgainstHTTPServer(t *testing.T) {
	received := make(chan WireFrame, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer device-token" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "done")
		_, data, err := connection.Read(request.Context())
		if err != nil {
			return
		}
		var frame WireFrame
		if json.Unmarshal(data, &frame) == nil {
			received <- frame
		}
	}))
	defer server.Close()

	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer device-token")
	connection, _, err := websocket.Dial(context.Background(), endpoint, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")
	wire := newWireConnection(connection)
	if err := wire.write(context.Background(), WireFrame{
		T: "hello", Proto: 1, DaemonVer: "test", Host: "alpha",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-received:
		if frame.T != "hello" || frame.Proto != 1 || frame.Host != "alpha" {
			t.Fatalf("frame = %+v", frame)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not receive frame")
	}
}

func TestWireURL(t *testing.T) {
	got, err := wireURL("https://transit.orangecountyai.com/")
	if err != nil || got != "wss://transit.orangecountyai.com/api/daemon/ws" {
		t.Fatalf("wireURL() = %q, %v", got, err)
	}
}

func TestNumericHostSlug(t *testing.T) {
	cfg := &Config{URL: "https://transit.orangecountyai.com", Host: "52labs"}
	if err := validateConfig(cfg); err != nil {
		t.Fatalf("validateConfig() rejected numeric host slug: %v", err)
	}
	name, host, err := parseAgentAddress("fitty@52labs")
	if err != nil || name != "fitty" || host != "52labs" {
		t.Fatalf("parseAgentAddress() = %q, %q, %v", name, host, err)
	}
	name, host, err = parseAgentAddress("partner-org/fitty@52labs")
	if err != nil || name != "fitty" || host != "52labs" {
		t.Fatalf("qualified parseAgentAddress() = %q, %q, %v", name, host, err)
	}
	if _, _, err := parseAgentAddress("Partner/fitty@52labs"); err == nil {
		t.Fatal("invalid organization slug was accepted")
	}
	if _, _, err := parseAgentAddress("52labs@alpha"); err == nil {
		t.Fatal("numeric agent name was accepted")
	}
}

func TestDeliverNakIncludesFalseRetryable(t *testing.T) {
	retryable := false
	data, err := json.Marshal(WireFrame{
		T: "deliver_nak", ID: "tx_001122334455", Code: "herdr_stalled",
		Retryable: &retryable,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"retryable":false`) {
		t.Fatalf("frame omitted false retryable: %s", data)
	}
}
