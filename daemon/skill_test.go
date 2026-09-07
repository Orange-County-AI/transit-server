package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFetchSkillReturnsServedMarkdown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/SKILL.md" {
			t.Errorf("path = %q, want /SKILL.md", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = writer.Write([]byte("---\nname: transit\n---\n"))
	}))
	defer server.Close()

	got, err := fetchSkill(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "name: transit") {
		t.Fatalf("fetchSkill() = %q, want the served skill", got)
	}
}

func TestFetchSkillReportsServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	if _, err := fetchSkill(context.Background(), server.URL); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("fetchSkill() error = %v, want an HTTP 404 error", err)
	}
}

// A self-hosted box must read its own server's skill: the hosted copy can
// describe tools its Worker does not serve.
func TestSkillOriginPrefersEnrolledServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	body, err := json.Marshal(Config{URL: "https://self-hosted.example", Host: "titan"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TRANSIT_CONFIG", path)
	t.Setenv("TRANSIT_URL", "https://ignored.example")

	got, err := skillOrigin()
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://self-hosted.example" {
		t.Fatalf("skillOrigin() = %q, want the enrolled server", got)
	}
}

func TestSkillOriginFallsBackWithoutEnrollment(t *testing.T) {
	t.Setenv("TRANSIT_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	t.Setenv("TRANSIT_URL", "https://unenrolled.example")

	got, err := skillOrigin()
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://unenrolled.example" {
		t.Fatalf("skillOrigin() = %q, want the environment value", got)
	}

	t.Setenv("TRANSIT_URL", "")
	got, err = skillOrigin()
	if err != nil {
		t.Fatal(err)
	}
	if got != hostedTransitURL {
		t.Fatalf("skillOrigin() = %q, want %q", got, hostedTransitURL)
	}
}

// --global is what makes the install user-level. Without it the skills CLI
// installs into whatever directory the operator ran the command from.
func TestSkillInstallArgsInstallGloballyFromGitHub(t *testing.T) {
	got := strings.Join(skillInstallArgs(skillRepository, defaultSkillAgent), " ")
	want := "-y skills add Orange-County-AI/transit-server --global --skill transit --yes --agent claude-code"
	if got != want {
		t.Fatalf("skillInstallArgs() = %q, want %q", got, want)
	}
}

func TestSkillUninstallArgsRemovesEveryAgentLinkByDefault(t *testing.T) {
	got := strings.Join(skillUninstallArgs(""), " ")
	want := "-y skills remove transit --global --yes"
	if got != want {
		t.Fatalf("skillUninstallArgs() = %q, want %q", got, want)
	}
	got = strings.Join(skillUninstallArgs("claude-code"), " ")
	want = "-y skills remove transit --global --yes --agent claude-code"
	if got != want {
		t.Fatalf("skillUninstallArgs(agent) = %q, want %q", got, want)
	}
}

func TestRunSkillRejectsUnknownSubcommand(t *testing.T) {
	err := runSkill([]string{"upgrade"})
	if err == nil || !strings.Contains(err.Error(), "unknown skill command") {
		t.Fatalf("runSkill() error = %v, want an unknown subcommand error", err)
	}
}
