package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var nonNameGlyph = regexp.MustCompile(`[^a-z0-9-]+`)

const autoNameAlphabet = "abcdefghjkmnpqrstvwxyz23456789"

type nativeAdapterRoster struct {
	name      string
	harness   string
	sessionID string
	status    string
	cwd       string
	title     string
	namedBy   string
}

func (d *Daemon) rosterLoop(ctx context.Context) {
	ticker := time.NewTicker(pollInterval())
	defer ticker.Stop()
	lastSnapshot := time.Time{}
	for {
		changed, err := d.refreshRoster(ctx)
		if err != nil {
			d.logf("roster refresh: %v", err)
		} else if changed || time.Since(lastSnapshot) >= 60*time.Second {
			if err := d.sendRoster(ctx); err == nil {
				lastSnapshot = time.Now()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-d.kickRoster:
		}
	}
}

func (d *Daemon) refreshRoster(ctx context.Context) (bool, error) {
	// A Herdr outage must not stop roster publication: the native adapters are
	// still there and still deliverable, and a roster that never goes out would
	// take them off the Worker's map along with the panes.
	agents, err := d.herdr.ListAgents(ctx)
	if err != nil {
		d.setHerdrAvailable(false, err)
		agents = nil
	} else {
		d.setHerdrAvailable(true, nil)
	}
	d.mu.RLock()
	nativeAdapters := make([]nativeAdapterRoster, 0, len(d.adapters))
	for _, adapter := range d.adapters {
		nativeAdapters = append(nativeAdapters, nativeAdapterRoster{
			name: adapter.name, harness: adapter.harness, sessionID: adapter.sessionID,
			status: adapter.status, cwd: adapter.cwd, title: adapter.title, namedBy: adapter.namedBy,
		})
	}
	d.mu.RUnlock()

	autoNames := d.loadAutoNames()
	taken := make(map[string]bool, len(agents)+len(nativeAdapters))
	for _, adapter := range nativeAdapters {
		taken[adapter.name] = true
	}
	for _, agent := range agents {
		if agent.Name != "" {
			taken[agent.Name] = true
		}
	}
	for index := range agents {
		if agents[index].Name != "" || agents[index].PaneID == "" {
			continue
		}
		name, err := generateAutoName(agents[index].Kind, taken)
		if err != nil {
			return false, err
		}
		renamed, err := d.herdr.Rename(ctx, agents[index].PaneID, name)
		if err != nil {
			return false, fmt.Errorf("auto-name %s: %w", agents[index].PaneID, err)
		}
		agents[index] = *renamed
		autoNames[renamed.PaneID] = renamed.Name
		taken[renamed.Name] = true
	}
	for paneID, name := range autoNames {
		found := false
		for _, agent := range agents {
			if agent.PaneID == paneID && agent.Name == name {
				found = true
				break
			}
		}
		if !found {
			delete(autoNames, paneID)
		}
	}
	_ = d.saveAutoNames(autoNames)

	nativeByName := make(map[string]bool, len(nativeAdapters))
	for _, adapter := range nativeAdapters {
		nativeByName[adapter.name] = true
	}
	wireAgents := make([]WireAgent, 0, len(agents)+len(nativeAdapters))
	for _, agent := range agents {
		if agent.Name == "" || !namePattern.MatchString(agent.Name) || reservedNames[agent.Name] || nativeByName[agent.Name] {
			continue
		}
		namedBy := "user"
		if autoNames[agent.PaneID] == agent.Name {
			namedBy = "auto"
		}
		wireAgents = append(wireAgents, WireAgent{
			Name: agent.Name, Kind: agent.Kind, PaneID: agent.PaneID, Status: agent.Status,
			CWD: agent.CWD, Title: agent.Title, NamedBy: namedBy,
		})
	}
	for _, adapter := range nativeAdapters {
		wireAgents = append(wireAgents, WireAgent{
			Name: adapter.name, Kind: adapter.harness,
			PaneID: "native:" + adapter.harness + ":" + firstSessionID(adapter.sessionID),
			Status: adapter.status, CWD: adapter.cwd, Title: adapter.title,
			NamedBy: wireNamedBy(adapter.namedBy),
		})
	}
	sort.Slice(wireAgents, func(i, j int) bool { return wireAgents[i].Name < wireAgents[j].Name })
	encoded, _ := json.Marshal(wireAgents)
	hash := string(encoded)

	d.mu.Lock()
	changed := hash != d.rosterHash
	d.roster = wireAgents
	d.herdrAgents = append([]HerdrAgent(nil), agents...)
	d.rosterHash = hash
	d.mu.Unlock()
	return changed, nil
}

// wireNamedBy keeps an internal provenance out of the roster frame.
// `transit-wire/1` admits `user` and `auto` and the Worker closes 4002 on
// anything else, so the `herdr` value a native adapter records when it adopts
// its pane name — a name a person chose in Herdr — travels as `user`. Adopting
// a pane name must not cost a host its entire wire connection.
func wireNamedBy(namedBy string) string {
	if namedBy == "auto" {
		return "auto"
	}
	return "user"
}

func firstSessionID(sessionID string) string {
	if len(sessionID) > 8 {
		return sessionID[:8]
	}
	return sessionID
}

func generateAutoName(kind string, taken map[string]bool) (string, error) {
	prefix := strings.ToLower(strings.TrimSpace(kind))
	prefix = strings.Trim(nonNameGlyph.ReplaceAllString(prefix, "-"), "-")
	if prefix == "" || !regexp.MustCompile(`^[a-z]`).MatchString(prefix) {
		prefix = "agent"
	}
	if len(prefix) > 26 {
		prefix = strings.TrimRight(prefix[:26], "-")
	}
	for range 100 {
		var bytes [4]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			return "", err
		}
		suffix := make([]byte, len(bytes))
		for index, value := range bytes {
			suffix[index] = autoNameAlphabet[int(value)%len(autoNameAlphabet)]
		}
		candidate := prefix + "-" + string(suffix)
		if namePattern.MatchString(candidate) && !taken[candidate] && !reservedNames[candidate] {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not allocate an agent name")
}

func (d *Daemon) sendRoster(ctx context.Context) error {
	connection := d.currentConnection()
	if connection == nil {
		return fmt.Errorf("offline")
	}
	d.mu.RLock()
	agents := append([]WireAgent(nil), d.roster...)
	d.mu.RUnlock()
	return connection.write(ctx, WireFrame{T: "roster", Agents: &agents})
}

func (d *Daemon) localAgentByPane(paneID string) (HerdrAgent, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, agent := range d.herdrAgents {
		if agent.PaneID == paneID {
			return agent, true
		}
	}
	return HerdrAgent{}, false
}

func (d *Daemon) localAgentByName(name string) (HerdrAgent, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, agent := range d.herdrAgents {
		if agent.Name == name {
			return agent, true
		}
	}
	return HerdrAgent{}, false
}

func (d *Daemon) claimName(ctx context.Context, paneID, name string) (string, error) {
	if !namePattern.MatchString(name) || reservedNames[name] {
		return "", fmt.Errorf("invalid or reserved agent name %q", name)
	}
	agent, found := d.localAgentByPane(paneID)
	if !found {
		return "", fmt.Errorf("agent_not_found")
	}
	renamed, err := d.herdr.Rename(ctx, agent.PaneID, name)
	if err != nil {
		return "", err
	}
	autoNames := d.loadAutoNames()
	delete(autoNames, renamed.PaneID)
	_ = d.saveAutoNames(autoNames)
	d.notifyRoster()
	return renamed.Name + "@" + d.cfg.Host, nil
}

func (d *Daemon) autoNamesPath() string { return filepath.Join(d.store.root, "auto_names.json") }

func (d *Daemon) loadAutoNames() map[string]string {
	data, err := os.ReadFile(d.autoNamesPath())
	if err != nil {
		return make(map[string]string)
	}
	var names map[string]string
	if json.Unmarshal(data, &names) != nil || names == nil {
		return make(map[string]string)
	}
	return names
}

func (d *Daemon) saveAutoNames(names map[string]string) error {
	return writeJSONAtomic(d.autoNamesPath(), names, 0o600)
}
