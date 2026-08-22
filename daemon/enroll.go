package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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
	code := flags.String("code", "", "one-time enrollment code")
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
	if *code == "" {
		return fmt.Errorf("--code is required")
	}
	if _, err := os.Stat(tokenPath()); err == nil && !*force {
		return fmt.Errorf("device token already exists at %s; use --force to replace it", tokenPath())
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}

	parsed, err := url.Parse(resolvedURL)
	if err != nil {
		return err
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/daemon/enroll"
	payload, _ := json.Marshal(map[string]any{
		"code": strings.ToUpper(strings.TrimSpace(*code)), "daemon_ver": buildVersion(),
	})
	request, err := http.NewRequest(http.MethodPost, parsed.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("enrollment rejected (%s)", response.Status)
	}
	var enrolled enrollResponse
	if err := json.NewDecoder(response.Body).Decode(&enrolled); err != nil {
		return err
	}
	if enrolled.DeviceToken == "" || enrolled.HostID == "" || enrolled.Host == "" || enrolled.Org == "" {
		return fmt.Errorf("enrollment returned incomplete credentials")
	}
	if *expectedHost != "" && *expectedHost != enrolled.Host {
		return fmt.Errorf("enrollment code belongs to host %q, not %q", enrolled.Host, *expectedHost)
	}
	configURL := resolvedURL
	parsed.Path = strings.TrimSuffix(parsed.Path, "/api/daemon/enroll")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	configURL = strings.TrimRight(parsed.String(), "/")
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
