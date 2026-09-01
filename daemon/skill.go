package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// skillRepository is where `npx skills add` fetches the canonical skill from.
// The published subtree carries SKILL.md at its root, so the repository name
// alone is the whole package reference.
const skillRepository = "Orange-County-AI/transit-server"

// skillName is the frontmatter name in SKILL.md, which is also the name the
// skills CLI installs and removes it under.
const skillName = "transit"

// defaultSkillAgent matches the harness the documented install line targets.
// `*` installs to every agent the skills CLI recognises.
const defaultSkillAgent = "claude-code"

// skillFetchTimeout bounds the one public GET this command makes. The skill is
// a small Markdown file served with no authentication.
const skillFetchTimeout = 15 * time.Second

// runSkill prints the agent skill, or hands install and uninstall to the
// skills CLI. Printing is the default because the common question is "what
// does Transit tell my agents to do", and answering it should not require a
// harness, an install, or a browser.
func runSkill(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "install":
			return runSkillInstall(args[1:])
		case "uninstall", "remove":
			return runSkillUninstall(args[1:])
		}
		if !strings.HasPrefix(args[0], "-") {
			return fmt.Errorf("unknown skill command %q (want install or uninstall)", args[0])
		}
	}
	return runSkillPrint(args)
}

func runSkillPrint(args []string) error {
	flags := flag.NewFlagSet("skill", flag.ContinueOnError)
	overrideURL := flags.String("url", "", "Transit server to read the skill from (defaults to this host's enrolled server)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("usage: transit skill [--url <server>]")
	}
	origin := strings.TrimRight(*overrideURL, "/")
	if origin == "" {
		resolved, err := skillOrigin()
		if err != nil {
			return err
		}
		origin = resolved
	}
	markdown, err := fetchSkill(context.Background(), origin)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(os.Stdout, markdown); err != nil {
		return err
	}
	if !strings.HasSuffix(markdown, "\n") {
		fmt.Println()
	}
	return nil
}

// skillOrigin prefers the server this host is enrolled against, so a
// self-hosted box reads its own server's copy rather than the hosted one. An
// unenrolled box still has an answer: TRANSIT_URL, then the public server.
func skillOrigin() (string, error) {
	if cfg, err := loadConfig(); err == nil && cfg.URL != "" {
		return strings.TrimRight(cfg.URL, "/"), nil
	}
	resolved, err := resolveEnrollURL("", false)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(resolved, "/"), nil
}

func fetchSkill(ctx context.Context, origin string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, skillFetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/SKILL.md", nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("fetch skill from %s: %w", origin, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch skill from %s: HTTP %d", origin, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read skill from %s: %w", origin, err)
	}
	return string(body), nil
}

func runSkillInstall(args []string) error {
	flags := flag.NewFlagSet("skill install", flag.ContinueOnError)
	agent := flags.String("agent", defaultSkillAgent, "agents to install for, comma separated (\"*\" for all)")
	repository := flags.String("repo", skillRepository, "skills package to install from")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("usage: transit skill install [--agent <agents>] [--repo <package>]")
	}
	return runSkillsCLI(skillInstallArgs(*repository, *agent))
}

func runSkillUninstall(args []string) error {
	flags := flag.NewFlagSet("skill uninstall", flag.ContinueOnError)
	agent := flags.String("agent", "", "agents to remove from, comma separated (default: every agent it is linked into)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("usage: transit skill uninstall [--agent <agents>]")
	}
	return runSkillsCLI(skillUninstallArgs(*agent))
}

// skillInstallArgs builds the npx argv. `--global` is what makes the install
// user-level: a skill installed into whatever directory the operator happened
// to run this from would follow the checkout, not the person.
func skillInstallArgs(repository, agent string) []string {
	args := []string{"-y", "skills", "add", repository, "--global", "--skill", skillName, "--yes"}
	if agent != "" {
		args = append(args, "--agent", agent)
	}
	return args
}

// skillUninstallArgs mirrors the install. An empty agent removes every link
// the skills CLI made, which is what "uninstall" means to the operator who
// installed it with the default.
func skillUninstallArgs(agent string) []string {
	args := []string{"-y", "skills", "remove", skillName, "--global", "--yes"}
	if agent != "" {
		args = append(args, "--agent", agent)
	}
	return args
}

// runSkillsCLI shells out to npx. Transit does not vendor a skills installer:
// the skills CLI owns where each harness keeps its skills, and duplicating
// that layout here would rot the first time a harness moved it.
func runSkillsCLI(args []string) error {
	binary, err := exec.LookPath("npx")
	if err != nil {
		return fmt.Errorf("npx not found on PATH; install Node.js, or run: npx %s", strings.Join(args, " "))
	}
	command := exec.Command(binary, args...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}
