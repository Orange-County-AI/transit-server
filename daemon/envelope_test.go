package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestEnvelopeVectors(t *testing.T) {
	data, err := os.ReadFile("../spec/envelope-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Envelopes []struct {
			Name     string        `json:"name"`
			Input    EnvelopeInput `json:"input"`
			Expected string        `json:"expected"`
		} `json:"envelopes"`
		Full []struct {
			Name     string            `json:"name"`
			Input    FullEnvelopeInput `json:"input"`
			Expected string            `json:"expected"`
		} `json:"full"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Envelopes {
		t.Run(vector.Name, func(t *testing.T) {
			if got := RenderEnvelope(vector.Input); got != vector.Expected {
				t.Fatalf("RenderEnvelope()\n--- got ---\n%s\n--- want ---\n%s", got, vector.Expected)
			}
		})
	}
	for _, vector := range vectors.Full {
		t.Run(vector.Name, func(t *testing.T) {
			if got := RenderFull(vector.Input); got != vector.Expected {
				t.Fatalf("RenderFull()\n--- got ---\n%s\n--- want ---\n%s", got, vector.Expected)
			}
		})
	}
}

func TestEnvelopeClipsByRune(t *testing.T) {
	body := strings.Repeat("🙂", 4000) + "x"
	rendered := RenderEnvelope(EnvelopeInput{
		From: "alice@alpha", ID: "tx_56789abcdef0", TS: "2026-08-21T12:35:01Z",
		Kind: "dm", Body: body,
	})
	if !strings.Contains(rendered, `truncated="1" schema="transit/1"`) {
		t.Fatalf("missing truncation attribute: %s", rendered[:200])
	}
	if strings.Contains(rendered, body) {
		t.Fatal("unclipped body present")
	}
}
