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

// Zero is the report that matters most and the one `omitempty` on an int would
// throw away, so a healthy box would send nothing and be indistinguishable from
// a daemon too old to report at all. Same trap as the agents array, one field
// over.
func TestRosterFrameSendsAZeroDeadCount(t *testing.T) {
	for _, test := range []struct {
		name string
		dead *int
		want string
	}{
		{"none spooled", new(0), `"dead":0`},
		{"some spooled", new(4), `"dead":4`},
	} {
		t.Run(test.name, func(t *testing.T) {
			agents := []WireAgent{}
			encoded, err := json.Marshal(WireFrame{T: "roster", Agents: &agents, Dead: test.dead})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(encoded), test.want) {
				t.Fatalf("roster frame = %s, want it to contain %s", encoded, test.want)
			}
		})
	}
}

// A daemon that cannot count its spool must omit the field rather than claim a
// zero, and no other frame type may carry it.
func TestUnreportedDeadCountIsOmitted(t *testing.T) {
	agents := []WireAgent{}
	for _, frame := range []WireFrame{
		{T: "roster", Agents: &agents},
		{T: "deliver_ack", ID: "tx_00000000abcd", Agent: "alice"},
	} {
		encoded, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), `"dead"`) {
			t.Fatalf("%s frame carries a dead field: %s", frame.T, encoded)
		}
	}
}
