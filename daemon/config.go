package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	URL          string `json:"url"`
	Host         string `json:"host"`
	HerdrSocket  string `json:"herdr_socket,omitempty"`
	DeliveryMode string `json:"delivery_mode,omitempty"`
}

func dataDir() string {
	if root := os.Getenv("TRANSIT_DATA_DIR"); root != "" {
		return root
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".transit")
	}
	return filepath.Join(home, ".local", "share", "transit")
}

func configPath() (string, error) {
	if path := os.Getenv("TRANSIT_CONFIG"); path != "" {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate config home: %w", err)
	}
	return filepath.Join(home, ".config", "transit", "config.json"), nil
}

func tokenPath() string       { return filepath.Join(dataDir(), "token") }
func socketPath() string      { return filepath.Join(dataDir(), "transit.sock") }
func agentSocketPath() string { return filepath.Join(dataDir(), "agent.sock") }

func herdrSocketPath(cfg *Config) (string, error) {
	if cfg != nil && cfg.HerdrSocket != "" {
		return cfg.HerdrSocket, nil
	}
	if path := os.Getenv("TRANSIT_HERDR_SOCKET"); path != "" {
		return path, nil
	}
	if path := os.Getenv("HERDR_SOCKET_PATH"); path != "" {
		return path, nil
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("locate herdr config home: %w", err)
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "herdr", "herdr.sock"), nil
}

func loadConfig() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read transit config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse transit config: %w", err)
	}
	if err := validateConfig(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func validateConfig(cfg *Config) error {
	parsed, err := url.Parse(cfg.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("invalid Transit URL %q", cfg.URL)
	}
	cfg.URL = strings.TrimRight(parsed.String(), "/")
	if !hostPattern.MatchString(cfg.Host) || reservedNames[cfg.Host] {
		return fmt.Errorf("invalid Transit host %q", cfg.Host)
	}
	if _, err := deliveryMode(cfg); err != nil {
		return err
	}
	return nil
}

func deliveryMode(cfg *Config) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("TRANSIT_DELIVERY_MODE")))
	if mode == "" && cfg != nil {
		mode = strings.ToLower(strings.TrimSpace(cfg.DeliveryMode))
	}
	if mode == "" {
		return "prefer", nil
	}
	switch mode {
	case "shadow", "prefer", "require":
		return mode, nil
	default:
		return "", fmt.Errorf("invalid Transit delivery mode %q (want shadow, prefer, or require)", mode)
	}
}

func writeConfig(cfg *Config) error {
	if err := validateConfig(cfg); err != nil {
		return err
	}
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writeJSONAtomic(path, cfg, 0o600)
}

func readToken() (string, error) {
	data, err := os.ReadFile(tokenPath())
	if err != nil {
		return "", fmt.Errorf("read device token: %w", err)
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", fmt.Errorf("device token is empty")
	}
	return token, nil
}

func pollInterval() time.Duration {
	seconds, err := strconv.Atoi(os.Getenv("TRANSIT_POLL_SECONDS"))
	if err != nil || seconds <= 0 {
		return 2 * time.Second
	}
	return time.Duration(seconds) * time.Second
}
