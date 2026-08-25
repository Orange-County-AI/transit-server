package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStartDeviceFlowReturnsAuthorization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/device/authorize" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["hostname"] != "titan" {
			t.Errorf("hostname = %v, want titan", body["hostname"])
		}
		if body["daemon_ver"] == "" {
			t.Error("daemon_ver must be sent")
		}
		json.NewEncoder(w).Encode(map[string]any{
			"device_code":               "secret-device-code",
			"user_code":                 "WXYZ-1234",
			"verification_uri":          "https://example.test/activate",
			"verification_uri_complete": "https://example.test/activate?code=WXYZ-1234",
			"expires_in":                900,
			"interval":                  1,
		})
	}))
	defer server.Close()

	got, err := startDeviceFlow(server.Client(), server.URL, "titan")
	if err != nil {
		t.Fatalf("startDeviceFlow: %v", err)
	}
	if got.UserCode != "WXYZ-1234" || got.DeviceCode != "secret-device-code" {
		t.Errorf("unexpected authorization %+v", got)
	}
	if got.Interval != 1 {
		t.Errorf("Interval = %d, want 1", got.Interval)
	}
}

func TestStartDeviceFlowDefaultsInterval(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"device_code": "d", "user_code": "U", "expires_in": 900, "interval": 0,
		})
	}))
	defer server.Close()

	got, err := startDeviceFlow(server.Client(), server.URL, "titan")
	if err != nil {
		t.Fatalf("startDeviceFlow: %v", err)
	}
	// A zero interval would busy-loop the server; the daemon has to pick a floor.
	if got.Interval != 5 {
		t.Errorf("Interval = %d, want the 5s default", got.Interval)
	}
}

func TestStartDeviceFlowRejectsIncompleteAuthorization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"user_code": "WXYZ-1234"})
	}))
	defer server.Close()

	if _, err := startDeviceFlow(server.Client(), server.URL, "titan"); err == nil {
		t.Fatal("expected an error when device_code is missing")
	}
}

func TestPollDeviceFlowWaitsThenSucceeds(t *testing.T) {
	var polls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&polls, 1) < 3 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"error": "authorization_pending"})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"device_token": "tok", "host_id": "hst_1", "host": "titan", "org": "org_1",
		})
	}))
	defer server.Close()

	waits := 0
	enrolled, err := pollDeviceFlow(
		context.Background(),
		server.Client(),
		server.URL,
		&deviceAuthorization{DeviceCode: "d", ExpiresIn: 900, Interval: 0},
		func() { waits++ },
	)
	if err != nil {
		t.Fatalf("pollDeviceFlow: %v", err)
	}
	if enrolled.Host != "titan" || enrolled.DeviceToken != "tok" {
		t.Errorf("unexpected enrollment %+v", enrolled)
	}
	if waits != 2 {
		t.Errorf("waits = %d, want 2 pending ticks", waits)
	}
}

func TestPollDeviceFlowBacksOffOnSlowDown(t *testing.T) {
	var polls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&polls, 1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]any{"error": "slow_down"})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"device_token": "tok", "host_id": "hst_1", "host": "titan", "org": "org_1",
		})
	}))
	defer server.Close()

	start := time.Now()
	if _, err := pollDeviceFlow(
		context.Background(),
		server.Client(),
		server.URL,
		&deviceAuthorization{DeviceCode: "d", ExpiresIn: 900, Interval: 0},
		nil,
	); err != nil {
		t.Fatalf("pollDeviceFlow: %v", err)
	}
	// slow_down must actually slow the next poll, not just be swallowed.
	if elapsed := time.Since(start); elapsed < 5*time.Second {
		t.Errorf("elapsed = %v, want the 5s backoff to be applied", elapsed)
	}
}

func TestPollDeviceFlowStopsOnTerminalErrors(t *testing.T) {
	for _, testCase := range []struct{ payload, want string }{
		{"expired_token", "expired"},
		{"invalid_grant", "already completed"},
	} {
		t.Run(testCase.payload, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]any{"error": testCase.payload})
			}))
			defer server.Close()

			_, err := pollDeviceFlow(
				context.Background(),
				server.Client(),
				server.URL,
				&deviceAuthorization{DeviceCode: "d", ExpiresIn: 900, Interval: 0},
				nil,
			)
			if err == nil {
				t.Fatal("expected a terminal error")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("error = %q, want it to mention %q", err, testCase.want)
			}
		})
	}
}

func TestPollDeviceFlowHonoursCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": "authorization_pending"})
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	_, err := pollDeviceFlow(
		ctx,
		server.Client(),
		server.URL,
		&deviceAuthorization{DeviceCode: "d", ExpiresIn: 900, Interval: 0},
		nil,
	)
	if !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("error = %v, want cancellation", err)
	}
}

func TestPollDeviceFlowGivesUpAfterExpiry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": "authorization_pending"})
	}))
	defer server.Close()

	// ExpiresIn 0 means the deadline is already behind us on the first tick.
	_, err := pollDeviceFlow(
		context.Background(),
		server.Client(),
		server.URL,
		&deviceAuthorization{DeviceCode: "d", ExpiresIn: 0, Interval: 0},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("error = %v, want expiry", err)
	}
}

func TestPollDeviceFlowSurvivesATransientNetworkFailure(t *testing.T) {
	var polls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hang up mid-request the first time, the way a flaky link would.
		if atomic.AddInt32(&polls, 1) == 1 {
			hijacked, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				hijacked.Close()
			}
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"device_token": "tok", "host_id": "hst_1", "host": "titan", "org": "org_1",
		})
	}))
	defer server.Close()

	enrolled, err := pollDeviceFlow(
		context.Background(),
		server.Client(),
		server.URL,
		&deviceAuthorization{DeviceCode: "d", ExpiresIn: 900, Interval: 0},
		nil,
	)
	if err != nil {
		t.Fatalf("a dropped connection must not abandon the flow: %v", err)
	}
	if enrolled.Host != "titan" {
		t.Errorf("host = %q, want titan", enrolled.Host)
	}
}

func TestEndpointJoinsWithoutDoublingSlashes(t *testing.T) {
	for _, testCase := range []struct{ base, want string }{
		{"https://transit.example", "https://transit.example/api/device/token"},
		{"https://transit.example/", "https://transit.example/api/device/token"},
		{"https://transit.example///", "https://transit.example/api/device/token"},
	} {
		if got := endpoint(testCase.base, "/api/device/token"); got != testCase.want {
			t.Errorf("endpoint(%q) = %q, want %q", testCase.base, got, testCase.want)
		}
	}
}

func TestDefaultHostnameIsAShortLowercaseName(t *testing.T) {
	got := defaultHostname()
	if got == "" {
		t.Fatal("defaultHostname must never be empty")
	}
	if strings.Contains(got, ".") {
		t.Errorf("defaultHostname = %q, want the domain stripped", got)
	}
	if got != strings.ToLower(got) {
		t.Errorf("defaultHostname = %q, want lowercase", got)
	}
}
