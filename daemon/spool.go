package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

type OutboxMessage struct {
	ID          string    `json:"id"`
	From        string    `json:"from"`
	To          string    `json:"to"`
	Body        string    `json:"body"`
	ReplyTo     string    `json:"reply_to,omitempty"`
	TS          time.Time `json:"ts"`
	Attempts    int       `json:"attempts,omitempty"`
	LastAttempt time.Time `json:"last_attempt,omitzero"`
	LastError   string    `json:"last_error,omitempty"`
}

type ClaimedMessage struct {
	Message *OutboxMessage
	Path    string
}

type DeadMessage struct {
	Message *OutboxMessage `json:"message"`
	Reason  string         `json:"reason"`
	At      time.Time      `json:"at"`
}

type HistoryRecord struct {
	ID       string `json:"id"`
	Envelope string `json:"envelope,omitempty"`
	Message  string `json:"message,omitempty"`
	// Agent and Via record who received a delivery and how it got there:
	// `adapter` means the harness took it over `transit-agent/1`, `herdr`
	// means it was typed into a pane. Both paths used to write an identical
	// record, so after the fact nothing could say which transport ran — the
	// question could only be answered by watching a live `status` at the
	// moment of delivery, which is not an answer.
	Agent string    `json:"agent,omitempty"`
	Via   string    `json:"via,omitempty"`
	At    time.Time `json:"at"`
}

type Store struct{ root string }

func OpenStore(root string) (*Store, error) {
	if root == "" {
		return nil, fmt.Errorf("store root is required")
	}
	for _, name := range []string{"outbox", "history", filepath.Join("history", "in"), "dead"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			return nil, fmt.Errorf("create %s: %w", name, err)
		}
	}
	return &Store{root: root}, nil
}

func txID() string {
	var bytes [6]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return "tx_" + hex.EncodeToString(bytes[:])
}

func writeJSONAtomic(path string, value any, mode os.FileMode) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
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
	return os.Rename(tmpName, path)
}

func (s *Store) withLock(fn func() error) error {
	lock, err := os.OpenFile(filepath.Join(s.root, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return fn()
}

func spoolFilename(message *OutboxMessage) string {
	return "msg-" + message.TS.UTC().Format("20060102T150405.000000000") + "-" + message.ID + ".json"
}

func spoolNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if (strings.HasPrefix(name, "msg-") || strings.HasPrefix(name, "claimed-")) && strings.HasSuffix(name, ".json") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func readOutbox(path string) (*OutboxMessage, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var message OutboxMessage
	if err := json.Unmarshal(data, &message); err != nil {
		return nil, err
	}
	return &message, nil
}

func (s *Store) Enqueue(message *OutboxMessage) error {
	if message == nil || message.From == "" || message.To == "" || message.Body == "" {
		return fmt.Errorf("complete outbox message is required")
	}
	if message.ID == "" {
		message.ID = txID()
	}
	if message.TS.IsZero() {
		message.TS = time.Now().UTC()
	}
	return s.withLock(func() error {
		names, err := spoolNames(filepath.Join(s.root, "outbox"))
		if err != nil {
			return err
		}
		for _, name := range names {
			if strings.HasSuffix(name, "-"+message.ID+".json") {
				return nil
			}
		}
		if len(names) >= 10_000 {
			return fmt.Errorf("outbox is full")
		}
		return writeJSONAtomic(filepath.Join(s.root, "outbox", spoolFilename(message)), message, 0o600)
	})
}

func (s *Store) Claim(now time.Time) (*ClaimedMessage, error) {
	var claimed *ClaimedMessage
	err := s.withLock(func() error {
		dir := filepath.Join(s.root, "outbox")
		names, err := spoolNames(dir)
		if err != nil {
			return err
		}
		for _, name := range names {
			if !strings.HasPrefix(name, "msg-") {
				continue
			}
			path := filepath.Join(dir, name)
			message, err := readOutbox(path)
			if err != nil {
				return err
			}
			if !outboxEligible(message, now) {
				continue
			}
			claimPath := filepath.Join(dir, "claimed-"+strings.TrimPrefix(name, "msg-"))
			if err := os.Rename(path, claimPath); err != nil {
				return err
			}
			claimed = &ClaimedMessage{Message: message, Path: claimPath}
			return nil
		}
		return nil
	})
	return claimed, err
}

func outboxEligible(message *OutboxMessage, now time.Time) bool {
	if message == nil || message.LastAttempt.IsZero() {
		return message != nil
	}
	wait := time.Second << min(max(message.Attempts-1, 0), 5)
	if wait > 30*time.Second {
		wait = 30 * time.Second
	}
	return !now.Before(message.LastAttempt.Add(wait))
}

// Expire moves every unclaimed outbox entry older than cutoff into the
// dead-letter spool and returns what it reaped, so the caller can tell each
// sender.
//
// Retry alone is not a policy. Without a bound, a message to a recipient that
// is never coming back is retried at a 30s ceiling forever, and the sender is
// told nothing, because the only notice Transit sends is the one for a
// PERMANENT nak. A bound plus a bounce is what turns silent accumulation into
// news the sender receives without having to remember to look.
//
// Claimed entries are skipped rather than yanked: a claim lasts one ack
// timeout, so an in-flight message becomes eligible on the next sweep instead
// of being reaped out from under a live send.
func (s *Store) Expire(cutoff time.Time, reason string) ([]*OutboxMessage, error) {
	var reaped []*OutboxMessage
	err := s.withLock(func() error {
		dir := filepath.Join(s.root, "outbox")
		names, err := spoolNames(dir)
		if err != nil {
			return err
		}
		for _, name := range names {
			if !strings.HasPrefix(name, "msg-") {
				continue
			}
			path := filepath.Join(dir, name)
			message, err := readOutbox(path)
			if err != nil {
				// An unreadable entry cannot be dated, so it cannot be judged
				// stale. ListDead already reports it where a person will see it.
				continue
			}
			if !message.TS.Before(cutoff) {
				continue
			}
			if err := writeJSONAtomic(
				filepath.Join(s.root, "dead", message.ID+".json"),
				DeadMessage{Message: message, Reason: reason, At: time.Now().UTC()},
				0o600,
			); err != nil {
				return err
			}
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			reaped = append(reaped, message)
		}
		return nil
	})
	return reaped, err
}

func (s *Store) Ack(claim *ClaimedMessage) error {
	if claim == nil || claim.Message == nil || claim.Path == "" {
		return fmt.Errorf("invalid outbox claim")
	}
	return s.withLock(func() error {
		if err := os.Remove(claim.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return writeJSONAtomic(
			filepath.Join(s.root, "history", claim.Message.ID+".json"),
			HistoryRecord{ID: claim.Message.ID, Message: claim.Message.Body, At: time.Now().UTC()},
			0o600,
		)
	})
}

func (s *Store) Release(claim *ClaimedMessage, lastError string) error {
	if claim == nil || claim.Message == nil || claim.Path == "" {
		return fmt.Errorf("invalid outbox claim")
	}
	return s.withLock(func() error {
		claim.Message.Attempts++
		claim.Message.LastAttempt = time.Now().UTC()
		claim.Message.LastError = lastError
		if err := writeJSONAtomic(claim.Path, claim.Message, 0o600); err != nil {
			return err
		}
		newPath := filepath.Join(filepath.Dir(claim.Path), spoolFilename(claim.Message))
		if err := os.Rename(claim.Path, newPath); err != nil {
			return err
		}
		claim.Path = newPath
		return nil
	})
}

func (s *Store) Kill(claim *ClaimedMessage, reason string) error {
	if claim == nil || claim.Message == nil || claim.Path == "" {
		return fmt.Errorf("invalid outbox claim")
	}
	return s.withLock(func() error {
		if err := os.Remove(claim.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return writeJSONAtomic(
			filepath.Join(s.root, "dead", claim.Message.ID+".json"),
			DeadMessage{Message: claim.Message, Reason: reason, At: time.Now().UTC()},
			0o600,
		)
	})
}

func (s *Store) ReclaimOrphans() error {
	return s.withLock(func() error {
		dir := filepath.Join(s.root, "outbox")
		names, err := spoolNames(dir)
		if err != nil {
			return err
		}
		for _, name := range names {
			if !strings.HasPrefix(name, "claimed-") {
				continue
			}
			if err := os.Rename(filepath.Join(dir, name), filepath.Join(dir, "msg-"+strings.TrimPrefix(name, "claimed-"))); err != nil {
				return err
			}
		}
		return nil
	})
}

// IncomingRecorded reports whether this host already injected a delivery. It
// deliberately ignores the outbox's own record of the same id: when both ends
// of a message live on one host they share a daemon, so a flat history
// namespace let the sender's ack answer the recipient's dedupe check and the
// daemon acknowledged a delivery it never injected.
func (s *Store) IncomingRecorded(id string) bool {
	if _, err := os.Stat(filepath.Join(s.root, "history", "in", id+".json")); err == nil {
		return true
	}
	// Records written before the split are flat, and only an injected delivery
	// carries an envelope.
	body, err := os.ReadFile(filepath.Join(s.root, "history", id+".json"))
	if err != nil {
		return false
	}
	var record HistoryRecord
	return json.Unmarshal(body, &record) == nil && record.Envelope != ""
}

// IncomingVia reports the transport recorded for a delivery, empty when this
// host has no record of it. The ack reads the record rather than recomputing
// the path so the two can never disagree, and a redelivery reports how the
// message originally arrived instead of inventing a second answer.
func (s *Store) IncomingVia(id string) string {
	body, err := os.ReadFile(filepath.Join(s.root, "history", "in", id+".json"))
	if err != nil {
		return ""
	}
	var record HistoryRecord
	if json.Unmarshal(body, &record) != nil {
		return ""
	}
	return record.Via
}

func (s *Store) RecordIncoming(id, agent, via, envelope string) error {
	return s.withLock(func() error {
		return writeJSONAtomic(
			filepath.Join(s.root, "history", "in", id+".json"),
			HistoryRecord{ID: id, Envelope: envelope, Agent: agent, Via: via, At: time.Now().UTC()},
			0o600,
		)
	})
}

// ListIncoming returns the most recent deliveries this host injected, newest
// first. It is the record that answers "how did this actually reach the
// agent", which no live snapshot can answer after the fact.
func (s *Store) ListIncoming(limit int) ([]HistoryRecord, error) {
	dir := filepath.Join(s.root, "history", "in")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	records := make([]HistoryRecord, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var record HistoryRecord
		if json.Unmarshal(data, &record) != nil {
			continue
		}
		// The envelope is the bulk of the file and no caller of this listing
		// wants it; dropping it keeps a status read cheap.
		record.Envelope = ""
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].At.After(records[j].At) })
	if limit > 0 && len(records) > limit {
		records = records[:limit]
	}
	return records, nil
}

// SentRecorded reports whether the outbox archived this id after the Worker
// committed it. It is the sender's own bookkeeping and never a delivery
// receipt.
func (s *Store) SentRecorded(id string) bool {
	_, err := os.Stat(filepath.Join(s.root, "history", id+".json"))
	return err == nil
}

func (s *Store) Counts() (outbox, dead int, err error) {
	outboxNames, err := spoolNames(filepath.Join(s.root, "outbox"))
	if err != nil {
		return 0, 0, err
	}
	deadEntries, err := os.ReadDir(filepath.Join(s.root, "dead"))
	if err != nil && !os.IsNotExist(err) {
		return 0, 0, err
	}
	return len(outboxNames), len(deadEntries), nil
}

func (s *Store) ListOutbox() ([]OutboxMessage, error) {
	names, err := spoolNames(filepath.Join(s.root, "outbox"))
	if err != nil {
		return nil, err
	}
	messages := make([]OutboxMessage, 0, len(names))
	for _, name := range names {
		message, err := readOutbox(filepath.Join(s.root, "outbox", name))
		if err != nil {
			return nil, err
		}
		messages = append(messages, *message)
	}
	return messages, nil
}

func (s *Store) ListDead() ([]DeadMessage, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "dead"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	// One unreadable file must not cost the operator the whole listing. This is
	// the surface whose entire job is making a silent failure visible, so an
	// entry that cannot be parsed is reported as itself and the rest still
	// print. Structural strictness here would reproduce the bug it exists to
	// expose.
	dead := make([]DeadMessage, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		name := entry.Name()
		id := strings.TrimSuffix(name, ".json")
		unreadable := func(reason string) DeadMessage {
			at := time.Time{}
			if info, statErr := entry.Info(); statErr == nil {
				at = info.ModTime()
			}
			return DeadMessage{
				// TS carries the file's mtime because that is the only honest
				// timestamp available for a record whose body cannot be read,
				// and it is what the listing prints.
				Message: &OutboxMessage{ID: id, To: "unknown", TS: at},
				Reason:  "unreadable: " + reason,
				At:      at,
			}
		}
		data, err := os.ReadFile(filepath.Join(s.root, "dead", name))
		if err != nil {
			dead = append(dead, unreadable(err.Error()))
			continue
		}
		var item DeadMessage
		if err := json.Unmarshal(data, &item); err != nil {
			dead = append(dead, unreadable(err.Error()))
			continue
		}
		dead = append(dead, item)
	}
	sort.Slice(dead, func(i, j int) bool { return dead[i].At.Before(dead[j].At) })
	return dead, nil
}
