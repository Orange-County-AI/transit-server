package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Device authorization, RFC 8628 shaped.
//
// This is the default enrollment path because Transit's hosts are usually
// remote headless machines. A loopback OAuth callback cannot be reached from
// the browser the person is actually sitting in front of, so instead the daemon
// shows a short code and the person confirms it wherever they already are.
//
// The pre-issued `--code` path stays for automation and self-hosted setups that
// mint codes over the API.

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type deviceError struct {
	Error string `json:"error"`
}

// startDeviceFlow asks the server to open a flow for this machine.
func startDeviceFlow(client *http.Client, baseURL, hostname string) (*deviceAuthorization, error) {
	payload, _ := json.Marshal(map[string]any{
		"hostname":   hostname,
		"daemon_ver": buildVersion(),
	})
	response, err := client.Post(
		endpoint(baseURL, "/api/device/authorize"),
		"application/json",
		bytes.NewReader(payload),
	)
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", baseURL, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("could not start enrollment (%s)", response.Status)
	}
	var authorization deviceAuthorization
	if err := json.NewDecoder(response.Body).Decode(&authorization); err != nil {
		return nil, err
	}
	if authorization.DeviceCode == "" || authorization.UserCode == "" {
		return nil, fmt.Errorf("server returned an incomplete authorization")
	}
	if authorization.Interval <= 0 {
		authorization.Interval = 5
	}
	return &authorization, nil
}

// pollDeviceFlow waits for a person to approve, then returns the credentials.
//
// It honours the server's `interval` and backs off further whenever told to
// `slow_down`, so an impatient daemon cannot be the reason enrollment fails.
func pollDeviceFlow(
	ctx context.Context,
	client *http.Client,
	baseURL string,
	authorization *deviceAuthorization,
	onWait func(),
) (*enrollResponse, error) {
	interval := time.Duration(authorization.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(authorization.ExpiresIn) * time.Second)
	payload, _ := json.Marshal(map[string]any{"device_code": authorization.DeviceCode})

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("enrollment code expired before it was approved")
		}

		response, err := client.Post(
			endpoint(baseURL, "/api/device/token"),
			"application/json",
			bytes.NewReader(payload),
		)
		if err != nil {
			// A blip in the network is not a reason to abandon a flow the
			// person may already be approving; keep waiting until the deadline.
			if onWait != nil {
				onWait()
			}
			continue
		}

		body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}

		if response.StatusCode == http.StatusOK {
			var enrolled enrollResponse
			if err := json.Unmarshal(body, &enrolled); err != nil {
				return nil, err
			}
			return &enrolled, nil
		}

		var failure deviceError
		_ = json.Unmarshal(body, &failure)
		switch failure.Error {
		case "authorization_pending":
			if onWait != nil {
				onWait()
			}
		case "slow_down":
			interval += 5 * time.Second
			if onWait != nil {
				onWait()
			}
		case "expired_token":
			return nil, fmt.Errorf("enrollment code expired before it was approved")
		case "invalid_grant":
			return nil, fmt.Errorf("this enrollment was already completed or cancelled")
		default:
			return nil, fmt.Errorf("enrollment failed (%s)", response.Status)
		}
	}
}

// endpoint joins a base origin and a path without doubling the separator.
func endpoint(baseURL, path string) string {
	return strings.TrimRight(baseURL, "/") + path
}

// defaultHostname is the slug offered to the person approving the flow. It is
// only a suggestion; the browser can rename the host before approving.
func defaultHostname() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "host"
	}
	// A machine reporting "titan.local" or an FQDN should still suggest "titan".
	if index := strings.Index(name, "."); index > 0 {
		name = name[:index]
	}
	return strings.ToLower(name)
}
