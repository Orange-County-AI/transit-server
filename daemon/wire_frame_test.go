package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A host with no agents must still send an agents array. `omitempty` elides an
// empty slice, so an agentless host sent `{"t":"roster"}`; the Worker requires
// an array there, rejected the frame as invalid and closed 4002, and the host
// reconnected into the same rejection every 30 seconds. Any host reaching zero
// agents hit it, which is why it stayed latent on a box that always had one.
func TestRosterFrameAlwaysCarriesAnAgentsArray(t *testing.T) {
	for _, test := range []struct {
		name   string
		agents []WireAgent
		want   string
	}{
		{"no agents", []WireAgent{}, `"agents":[]`},
		{"one agent", []WireAgent{{Name: "alice", Kind: "omp"}}, `"agents":[{"name":"alice"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			agents := test.agents
			encoded, err := json.Marshal(WireFrame{T: "roster", Agents: &agents})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(encoded), test.want) {
				t.Fatalf("roster frame = %s, want it to contain %s", encoded, test.want)
			}
		})
	}
}

// The frame struct is shared by every frame type, so the field has to stay off
// the frames that have no roster in them.
func TestNonRosterFramesOmitAgents(t *testing.T) {
	for _, frame := range []WireFrame{
		{T: "deliver_ack", ID: "tx_00000000abcd", Agent: "alice"},
		{T: "send", ID: "tx_00000000abcd", From: "alice@titan", To: "bob@titan", Body: "hello"},
		{T: "hello", Proto: 1, Host: "titan"},
	} {
		encoded, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "agents") {
			t.Fatalf("%s frame carries an agents field: %s", frame.T, encoded)
		}
	}
}
