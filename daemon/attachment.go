package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const (
	maxAttachmentBytes = 100 << 20
	attachmentMaxAge   = 7 * 24 * time.Hour
)

type attachmentDescriptor struct {
	Name        string `json:"name"`
	ContentType string `json:"contentType,omitempty"`
	Size        *int64 `json:"size,omitempty"`
	URL         string `json:"url"`
}

type readMessageV2Result struct {
	Text        string                 `json:"text"`
	Attachments []attachmentDescriptor `json:"attachments"`
}

func readMessageForMCP(id string) (string, error) {
	response, err := mcpCallAsPane(map[string]any{
		"op": "rpc", "method": "read_message_v2", "params": map[string]any{"id": id},
	})
	if err != nil {
		return "", err
	}
	if err := responseError(response); err != nil {
		// A new daemon can still point at an older self-hosted Worker. Attachment
		// support is additive, so retain the established read path rather than
		// making every channel message unreadable during that upgrade window.
		if !strings.Contains(err.Error(), "unknown rpc method") {
			return "", err
		}
		return readMessageV1(id)
	}

	raw, err := json.Marshal(response["result"])
	if err != nil {
		return "", fmt.Errorf("read_message returned an invalid result")
	}
	var result readMessageV2Result
	if err := json.Unmarshal(raw, &result); err != nil || result.Text == "" {
		return "", fmt.Errorf("read_message returned an invalid result")
	}
	if len(result.Attachments) == 0 {
		return result.Text, nil
	}
	return materializeAttachments(id, result), nil
}

func readMessageV1(id string) (string, error) {
	response, err := mcpCallAsPane(map[string]any{
		"op": "rpc", "method": "read_message", "params": map[string]any{"id": id},
	})
	if err != nil {
		return "", err
	}
	if err := responseError(response); err != nil {
		return "", err
	}
	text, ok := response["result"].(string)
	if !ok {
		return "", fmt.Errorf("read_message returned an invalid result")
	}
	return text, nil
}

func materializeAttachments(id string, result readMessageV2Result) string {
	root := filepath.Join(dataDir(), "attachments")
	_ = reapAttachmentDirs(root, time.Now())
	directory := filepath.Join(root, safePathComponent(id, "delivery"))
	lines := []string{"", "Attachments materialized by Transit:"}
	for index, attachment := range result.Attachments {
		name := safeAttachmentName(attachment.Name, index)
		path := filepath.Join(directory, name)
		if err := downloadAttachment(path, attachment); err != nil {
			lines = append(lines, fmt.Sprintf("- %s: unavailable (%s)", name, err))
			continue
		}
		detail := attachment.ContentType
		if attachment.Size != nil {
			if detail != "" {
				detail += ", "
			}
			detail += fmt.Sprintf("%d bytes", *attachment.Size)
		}
		if detail != "" {
			lines = append(lines, fmt.Sprintf("- %s (%s)", path, detail))
		} else {
			lines = append(lines, "- "+path)
		}
	}
	return result.Text + strings.Join(lines, "\n")
}

func downloadAttachment(path string, attachment attachmentDescriptor) error {
	if attachment.Size != nil && *attachment.Size > maxAttachmentBytes {
		return fmt.Errorf("declared size exceeds %d bytes", maxAttachmentBytes)
	}
	parsed, err := url.Parse(attachment.URL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return fmt.Errorf("invalid download URL")
	}
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		if attachment.Size == nil || info.Size() == *attachment.Size {
			return nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodGet, attachment.URL, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxAttachmentBytes {
		return fmt.Errorf("response exceeds %d bytes", maxAttachmentBytes)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".attachment-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	written, copyErr := io.Copy(temporary, io.LimitReader(response.Body, maxAttachmentBytes+1))
	if copyErr == nil && written > maxAttachmentBytes {
		copyErr = fmt.Errorf("response exceeds %d bytes", maxAttachmentBytes)
	}
	if copyErr == nil {
		copyErr = temporary.Sync()
	}
	if closeErr := temporary.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return copyErr
	}
	return os.Rename(temporaryName, path)
}

func safeAttachmentName(value string, index int) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = filepath.Base(value)
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, value)
	value = strings.TrimSpace(value)
	if value == "" || value == "." {
		value = fmt.Sprintf("attachment-%d", index+1)
	}
	if len(value) > 180 {
		value = value[:180]
	}
	return fmt.Sprintf("%02d-%s", index+1, value)
}

func safePathComponent(value, fallback string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, value)
	value = strings.Trim(value, "_")
	if value == "" {
		return fallback
	}
	return value
}

func reapAttachmentDirs(root string, now time.Time) error {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoff := now.Add(-attachmentMaxAge)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(filepath.Join(root, entry.Name()))
		}
	}
	return nil
}
