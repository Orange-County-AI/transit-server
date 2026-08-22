package main

import (
	"bytes"
	"errors"
	"io"
	"os"
)

// transcriptTailBytes bounds how far back a delivery id is looked for. A session
// file grows without limit and only the recent tail can hold a delivery this
// daemon is still trying to settle.
const transcriptTailBytes = int64(512 * 1024)

// transcriptContains reports whether a harness session file mentions a delivery
// id. The id travels inside the rendered envelope, so the harness having
// persisted it is proof the message was read — the same receipt the native
// adapters wait for, read from the file Herdr names for a pane.
func transcriptContains(path, id string) (bool, error) {
	if path == "" || id == "" {
		return false, errors.New("transcript path and delivery id are required")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	offset := int64(0)
	if info.Size() > transcriptTailBytes {
		offset = info.Size() - transcriptTailBytes
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return false, err
	}
	tail, err := io.ReadAll(file)
	if err != nil {
		return false, err
	}
	return bytes.Contains(tail, []byte(id)), nil
}
