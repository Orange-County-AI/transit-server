package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestMaterializeAttachmentsDownloadsAtomicallyAndCaches(t *testing.T) {
	t.Setenv("TRANSIT_DATA_DIR", t.TempDir())
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Length", "3")
		_, _ = w.Write([]byte{1, 2, 3})
	}))
	defer server.Close()
	size := int64(3)
	result := readMessageV2Result{
		Text: "full message",
		Attachments: []attachmentDescriptor{{
			Name: "../../brief.pdf", ContentType: "application/pdf", Size: &size, URL: server.URL,
		}},
	}

	first := materializeAttachments("dlv_test", result)
	path := filepath.Join(dataDir(), "attachments", "dlv_test", "01-brief.pdf")
	if !strings.Contains(first, path) {
		t.Fatalf("result missing local path %q: %s", path, first)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string([]byte{1, 2, 3}) {
		t.Fatalf("downloaded bytes = %v", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("attachment mode = %o", info.Mode().Perm())
	}

	_ = materializeAttachments("dlv_test", result)
	if got := requests.Load(); got != 1 {
		t.Fatalf("requests after cached read = %d, want 1", got)
	}
}

func TestMaterializeAttachmentsRefusesOversizeBeforeFetch(t *testing.T) {
	t.Setenv("TRANSIT_DATA_DIR", t.TempDir())
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte("unexpected"))
	}))
	defer server.Close()
	size := int64(maxAttachmentBytes + 1)
	text := materializeAttachments("dlv_large", readMessageV2Result{
		Text:        "full message",
		Attachments: []attachmentDescriptor{{Name: "large.bin", Size: &size, URL: server.URL}},
	})
	if !strings.Contains(text, "unavailable") || requests.Load() != 0 {
		t.Fatalf("oversize result = %q, requests = %d", text, requests.Load())
	}
}
