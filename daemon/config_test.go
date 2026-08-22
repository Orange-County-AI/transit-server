package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestRunConfigPrintsResolvedEndpoints(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("TRANSIT_CONFIG", path)
	if err := writeConfig(&Config{URL: "https://transit.example/base", Host: "titan"}); err != nil {
		t.Fatal(err)
	}

	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	err = runConfig(nil)
	writer.Close()
	os.Stdout = original
	if err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(output), "config: "+path+"\nserver: https://transit.example/base\nwebsocket: wss://transit.example/base/api/daemon/ws\n"; got != want {
		t.Fatalf("runConfig() output = %q, want %q", got, want)
	}
}
