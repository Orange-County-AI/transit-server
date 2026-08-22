package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Every fixture is a verbatim Herdr pane.read (source=visible, strip_ansi)
// capture from a live pane on this host, taken against OMP 18.0.0 and Claude
// Code with the composer in the state the file name describes. The one
// exception is claude-labeled-draft.txt: it is a live labeled-fence capture
// whose composer row carries a typed draft, because a session's fence label is
// not something a capture script can provoke on demand.
func readScreenFixture(t *testing.T, name string) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", "screens", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(body)
}

func TestDetectComposerOnLiveHarnessScreens(t *testing.T) {
	for _, test := range []struct {
		fixture string
		kind    string
		want    ComposerState
		why     string
	}{
		{"omp-empty.txt", "omp", ComposerEmpty, "idle OMP with nothing typed"},
		{"omp-empty-working.txt", "omp", ComposerEmpty, "OMP mid-turn with nothing typed"},
		{"omp-draft.txt", "omp", ComposerDraft, "one unsent line"},
		{"omp-draft-wrapped.txt", "omp", ComposerDraft, "draft wrapped across the box body"},
		{"omp-draft-working.txt", "omp", ComposerDraft, "unsent steering text mid-turn"},
		{"omp-empty.txt", "pi", ComposerEmpty, "Pi shares OMP's composer"},
		{"omp-draft.txt", "pi", ComposerDraft, "Pi shares OMP's composer"},
		{"claude-empty.txt", "claude", ComposerEmpty, "idle Claude Code with nothing typed"},
		{"claude-empty-working.txt", "claude", ComposerEmpty, "Claude Code mid-turn with nothing typed"},
		{"claude-draft.txt", "claude", ComposerDraft, "one unsent line"},
		{"claude-draft-working.txt", "claude", ComposerDraft, "unsent steering text mid-turn"},
		// The regression: a session with a label renders it inside the top
		// fence, and a fence rule that had to be a pure run of glyphs left the
		// composer unlocatable, so the guard fell open and the delivery was
		// typed on top of the human's draft.
		{"claude-labeled-empty.txt", "claude", ComposerEmpty, "labeled fence, nothing typed"},
		{"claude-labeled-empty-progress.txt", "claude", ComposerEmpty, "labeled fence with a progress row"},
		{"claude-labeled-draft.txt", "claude", ComposerDraft, "labeled fence over unsent input"},
		// The operator's shell prompt uses the same glyph as Claude's composer,
		// so an unfenced marker row must not read as a composer at all.
		{"shell.txt", "claude", ComposerUnknown, "plain shell pane"},
		{"shell.txt", "omp", ComposerUnknown, "plain shell pane"},
		// A harness with no detector delivers exactly as it did before the
		// guard, whatever is on its screen.
		{"omp-draft.txt", "codex", ComposerUnknown, "unsupported harness"},
		{"claude-draft.txt", "", ComposerUnknown, "unknown harness"},
		{"claude-draft.txt", "omp", ComposerUnknown, "detector is not applied across harnesses"},
		{"omp-draft.txt", "claude", ComposerUnknown, "detector is not applied across harnesses"},
	} {
		t.Run(test.fixture+"/"+test.kind, func(t *testing.T) {
			if got := DetectComposer(test.kind, readScreenFixture(t, test.fixture)); got != test.want {
				t.Fatalf("DetectComposer(%q, %s) = %s, want %s (%s)",
					test.kind, test.fixture, got, test.want, test.why)
			}
		})
	}
}

func TestDetectComposerIgnoresAnEmptyScreen(t *testing.T) {
	for _, screen := range []string{"", "   \n\t\n"} {
		if got := DetectComposer("omp", screen); got != ComposerUnknown {
			t.Fatalf("DetectComposer(omp, %q) = %s, want unknown", screen, got)
		}
	}
}

func TestClaudeComposerRuleAcceptsOnlyFences(t *testing.T) {
	for _, test := range []struct {
		line string
		want bool
	}{
		{"────────────────", true},
		{"──────── titan-ha-reliability-roadmap ─", true},
		{"  ──────── client-owned-infrastructure-design ─  ", true},
		{"──────", false},
		{"── a ──", false},
		{"──────── one ─── two ─", false},
		{"────────plan─", false},
		{"─ this is prose that starts and ends with a rule ─", false},
		{"  Opus 5 (1M context)  stephan@example.com", false},
		{"", false},
	} {
		if got := claudeComposerRule(test.line); got != test.want {
			t.Fatalf("claudeComposerRule(%q) = %t, want %t", test.line, got, test.want)
		}
	}
}

func TestDraftGuardEnvironmentSwitch(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{"", true},
		{"1", true},
		{"true", true},
		{"0", false},
		{"false", false},
		{" FALSE ", false},
	} {
		t.Setenv("TRANSIT_DRAFT_GUARD", test.value)
		if got := draftGuardEnabled(); got != test.want {
			t.Fatalf("draftGuardEnabled() with TRANSIT_DRAFT_GUARD=%q = %t, want %t", test.value, got, test.want)
		}
	}
}
