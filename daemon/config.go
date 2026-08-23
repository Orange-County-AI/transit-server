package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Enrollment binds this daemon to one organization: one Worker URL, one host
// name inside that organization, and one device token. A box that runs agents
// for several organizations holds several, because the organization is a
// property of the credential and never of the machine.
type Enrollment struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Host      string `json:"host"`
	TokenFile string `json:"token_file,omitempty"`
}

type Config struct {
	URL          string       `json:"url"`
	Host         string       `json:"host"`
	HerdrSocket  string       `json:"herdr_socket,omitempty"`
	DeliveryMode string       `json:"delivery_mode,omitempty"`
	Enrollments  []Enrollment `json:"enrollments,omitempty"`
}

const defaultEnrollment = "default"

var enrollmentPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// tokenFile is where this enrollment's device token lives, relative to the
// data directory. The default enrollment keeps the historical `token` path so
// an existing single-organization box needs no migration and loses no spool.
func (e Enrollment) tokenFile() string {
	if e.TokenFile != "" {
		return e.TokenFile
	}
	if e.ID == defaultEnrollment {
		return "token"
	}
	return "token-" + e.ID
}

// storeRoot partitions the outbox so a message queued for one organization can
// never be flushed over another's socket. The default enrollment keeps the
// data directory itself, which is where a running daemon's spool already is.
func (e Enrollment) storeRoot() string {
	if e.ID == defaultEnrollment {
		return dataDir()
	}
	return filepath.Join(dataDir(), "enrollments", e.ID)
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

func tokenPath() string { return filepath.Join(dataDir(), "token") }

// normaliseEnrollments folds a single-organization config into the same shape
// a multi-organization one has, so every later stage reads one list and the
// old path is not a special case anywhere but here.
func normaliseEnrollments(cfg *Config) error {
	if len(cfg.Enrollments) == 0 {
		cfg.Enrollments = []Enrollment{{ID: defaultEnrollment, URL: cfg.URL, Host: cfg.Host}}
		return nil
	}
	seen := make(map[string]bool, len(cfg.Enrollments))
	for index := range cfg.Enrollments {
		entry := &cfg.Enrollments[index]
		if entry.ID == "" {
			entry.ID = defaultEnrollment
		}
		if !enrollmentPattern.MatchString(entry.ID) {
			return fmt.Errorf("invalid enrollment id %q", entry.ID)
		}
		if seen[entry.ID] {
			return fmt.Errorf("duplicate enrollment id %q", entry.ID)
		}
		seen[entry.ID] = true
		if entry.URL == "" {
			entry.URL = cfg.URL
		}
		if entry.Host == "" {
			entry.Host = cfg.Host
		}
		parsed, err := url.Parse(entry.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("invalid Transit URL %q for enrollment %q", entry.URL, entry.ID)
		}
		entry.URL = strings.TrimRight(parsed.String(), "/")
		if !hostPattern.MatchString(entry.Host) || reservedNames[entry.Host] {
			return fmt.Errorf("invalid Transit host %q for enrollment %q", entry.Host, entry.ID)
		}
	}
	return nil
}

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
	// Normalised on read only: writeConfig must not persist a synthesised
	// default enrollment back into a single-organization config file.
	if err := normaliseEnrollments(&cfg); err != nil {
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

// readEnrollmentToken reads one enrollment's device token. A daemon serving
// several organizations holds several, and a missing one takes down only its
// own connection.
func readEnrollmentToken(entry Enrollment) (string, error) {
	path := entry.tokenFile()
	if !filepath.IsAbs(path) {
		path = filepath.Join(dataDir(), path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read device token for enrollment %s: %w", entry.ID, err)
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", fmt.Errorf("device token for enrollment %s is empty", entry.ID)
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
