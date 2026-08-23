package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const wireProtocol = 1
const maxWireFrameBytes = 1 << 20
const maxMessageBytes = 64 * 1024

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
var hostPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
var organizationPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var reservedNames = map[string]bool{"transit": true, "operator": true}

type WireAgent struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	PaneID  string `json:"pane_id"`
	Status  string `json:"status"`
	CWD     string `json:"cwd"`
	Title   string `json:"title"`
	NamedBy string `json:"named_by"`
}

type WireFrame struct {
	T         string `json:"t"`
	Proto     int    `json:"proto,omitempty"`
	DaemonVer string `json:"daemon_ver,omitempty"`
	Host      string `json:"host,omitempty"`
	HostID    string `json:"host_id,omitempty"`
	Org       string `json:"org,omitempty"`
	// A pointer so a roster of none is sent as `"agents": []` rather than
	// dropped: `omitempty` elides an empty slice, so an agentless host sent
	// `{"t":"roster"}`, the Worker read `undefined` where an array is required,
	// rejected the frame and closed 4002, and the host lost its connection the
	// moment its last agent exited. The frame is shared by every type, so the
	// pointer is what keeps `agents` off a deliver or ack frame.
	Agents   *[]WireAgent `json:"agents,omitempty"`
	ID       string       `json:"id,omitempty"`
	From     string       `json:"from,omitempty"`
	To       string       `json:"to,omitempty"`
	Body     string       `json:"body,omitempty"`
	ReplyTo  string       `json:"reply_to,omitempty"`
	TS       string       `json:"ts,omitempty"`
	Agent    string       `json:"agent,omitempty"`
	Envelope string       `json:"envelope,omitempty"`
	// Via reports which transport carried a delivery to its agent. Set only on
	// `deliver_ack`; omitted everywhere else, and by any daemon older than it.
	Via       string          `json:"via,omitempty"`
	Code      string          `json:"code,omitempty"`
	Retryable *bool           `json:"retryable,omitempty"`
	RID       string          `json:"rid,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     json.RawMessage `json:"error,omitempty"`
}

type RPCResponse struct {
	Result json.RawMessage
	Error  json.RawMessage
}

func parseAgentAddress(address string) (name, host string, err error) {
	if strings.HasPrefix(address, "#") {
		room := strings.TrimPrefix(address, "#")
		if !namePattern.MatchString(room) || reservedNames[room] {
			return "", "", fmt.Errorf("invalid room address %q", address)
		}
		return "#" + room, "", nil
	}

	agentAddress := address
	if strings.Contains(address, "/") {
		if strings.Count(address, "/") != 1 {
			return "", "", fmt.Errorf("address must be name@host, organization/name@host, #room, or organization/#room")
		}
		organization, local, _ := strings.Cut(address, "/")
		if len(organization) < 2 || len(organization) > 128 ||
			!organizationPattern.MatchString(organization) {
			return "", "", fmt.Errorf("invalid organization in address %q", address)
		}
		agentAddress = local
		if strings.HasPrefix(agentAddress, "#") {
			room := strings.TrimPrefix(agentAddress, "#")
			if !namePattern.MatchString(room) || reservedNames[room] {
				return "", "", fmt.Errorf("invalid room address %q", address)
			}
			return "#" + room, "", nil
		}
	}
	if strings.Count(agentAddress, "@") != 1 {
		return "", "", fmt.Errorf("address must be name@host, organization/name@host, #room, or organization/#room")
	}
	name, host, _ = strings.Cut(agentAddress, "@")
	if !namePattern.MatchString(name) || !hostPattern.MatchString(host) {
		return "", "", fmt.Errorf("invalid agent address %q", address)
	}
	if reservedNames[name] || reservedNames[host] {
		return "", "", fmt.Errorf("reserved name in address %q", address)
	}
	return name, host, nil
}

func wireURL(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported Transit URL scheme %q", parsed.Scheme)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/daemon/ws"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}
