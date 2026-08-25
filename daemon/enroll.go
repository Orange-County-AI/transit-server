package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type enrollResponse struct {
	DeviceToken string `json:"device_token"`
	HostID      string `json:"host_id"`
	Host        string `json:"host"`
	Org         string `json:"org"`
}

const hostedTransitURL = "https://transit.orangecountyai.com"

func resolveEnrollURL(flagValue string, flagSet bool) (string, error) {
	value := hostedTransitURL
	source := "--url"
	if flagSet {
		value = flagValue
	} else if envValue, ok := os.LookupEnv("TRANSIT_URL"); ok && envValue != "" {
		value = envValue
		source = "TRANSIT_URL"
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("invalid %s %q", source, value)
	}
	return value, nil
}

func runEnroll(args []string) error {
	flags := flag.NewFlagSet("enroll", flag.ContinueOnError)
	baseURL := flags.String("url", "", "Transit server URL to enroll this host against (defaults to TRANSIT_URL or the public Transit server)")
	code := flags.String("code", "", "pre-issued enrollment code (unattended installs; omit to approve in a browser)")
	hostname := flags.String("hostname", defaultHostname(), "name to suggest for this host when approving")
	expectedHost := flags.String("host", "", "expected host slug")
	force := flags.Bool("force", false, "replace an existing enrollment")
	if err := flags.Parse(args); err != nil {
		return err
	}
	urlSet := false
	flags.Visit(func(flag *flag.Flag) {
		urlSet = urlSet || flag.Name == "url"
	})
	resolvedURL, err := resolveEnrollURL(*baseURL, urlSet)
	if err != nil {
		return err
	}
	if _, err := os.Stat(tokenPath()); err == nil && !*force {
		return fmt.Errorf("device token already exists at %s; use --force to replace it", tokenPath())
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	var enrolled *enrollResponse
	if *code == "" {
		// No code given: ask the server to open a flow and wait for a person to
		// approve it. This is the normal path — nothing has to be fetched from
		// the dashboard first.
		enrolled, err = enrollByDevice(client, resolvedURL, *hostname)
	} else {
		enrolled, err = enrollByCode(client, resolvedURL, *code)
	}
	if err != nil {
		return err
	}
	if enrolled.DeviceToken == "" || enrolled.HostID == "" || enrolled.Host == "" || enrolled.Org == "" {
		return fmt.Errorf("enrollment returned incomplete credentials")
	}
	if *expectedHost != "" && *expectedHost != enrolled.Host {
		return fmt.Errorf("enrollment code belongs to host %q, not %q", enrolled.Host, *expectedHost)
	}
	origin, err := url.Parse(resolvedURL)
	if err != nil {
		return err
	}
	origin.RawQuery = ""
	origin.Fragment = ""
	configURL := strings.TrimRight(origin.String(), "/")
	if err := writeConfig(&Config{URL: configURL, Host: enrolled.Host}); err != nil {
		return err
	}
	if err := writeToken(enrolled.DeviceToken); err != nil {
		return err
	}
	fmt.Printf("Enrolled host %s (%s)\n", enrolled.Host, enrolled.HostID)
	return nil
}

func writeToken(token string) error {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	path := tokenPath()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".token-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(token + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// enrollByCode exchanges a pre-issued code. Kept for unattended installs and
// for self-hosted setups that mint codes over the API.
func enrollByCode(client *http.Client, baseURL, code string) (*enrollResponse, error) {
	payload, _ := json.Marshal(map[string]any{
		"code":       strings.ToUpper(strings.TrimSpace(code)),
		"daemon_ver": buildVersion(),
	})
	response, err := client.Post(
		endpoint(baseURL, "/api/daemon/enroll"),
		"application/json",
		bytes.NewReader(payload),
	)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("enrollment rejected (%s)", response.Status)
	}
	var enrolled enrollResponse
	if err := json.NewDecoder(response.Body).Decode(&enrolled); err != nil {
		return nil, err
	}
	return &enrolled, nil
}

// enrollByDevice runs the browser-approval flow and reports progress on the
// terminal while it waits.
func enrollByDevice(client *http.Client, baseURL, hostname string) (*enrollResponse, error) {
	authorization, err := startDeviceFlow(client, baseURL, hostname)
	if err != nil {
		return nil, err
	}

	// The complete URI carries the code already filled in, so most people never
	// type it; the bare URI and code are printed for anyone reading this over a
	// terminal they cannot click in.
	fmt.Printf("\n  Approve this host at:\n\n    %s\n\n", authorization.VerificationURIComplete)
	fmt.Printf("  Or open %s and enter:  %s\n\n", authorization.VerificationURI, authorization.UserCode)
	fmt.Printf("  Waiting for approval (expires in %d minutes)", authorization.ExpiresIn/60)

	ctx, cancel := signalContext()
	defer cancel()

	enrolled, err := pollDeviceFlow(ctx, client, baseURL, authorization, func() {
		fmt.Print(".")
	})
	fmt.Println()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, fmt.Errorf("enrollment cancelled")
		}
		return nil, err
	}
	return enrolled, nil
}

// signalContext cancels when the operator interrupts the wait, so Ctrl-C during
// a poll exits cleanly instead of leaving a half-written config behind.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
