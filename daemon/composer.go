package main

import (
	"os"
	"strings"
	"unicode"
)

// A Herdr-path delivery is keystrokes: agent.prompt writes the envelope at the
// pane's cursor and presses Enter a beat later, so a composer already holding a
// human's unsent input submits draft and envelope as one prompt. The rendered
// screen is the only evidence Herdr exposes — pane.read returns text, never the
// harness input buffer — so detection is per-harness and deliberately
// one-sided: only a composer recognized as non-empty holds a delivery back. An
// unfamiliar harness, a composer that cannot be located, or an unreadable
// screen delivers exactly as it did before the guard, because starving a
// durable queue is worse than the clobber the guard prevents.
type ComposerState int

const (
	// ComposerUnknown means no composer this build can read was on the screen.
	ComposerUnknown ComposerState = iota
	// ComposerEmpty means the composer was located and holds no input.
	ComposerEmpty
	// ComposerDraft means the composer holds unsent input.
	ComposerDraft
)

func (state ComposerState) String() string {
	switch state {
	case ComposerEmpty:
		return "empty"
	case ComposerDraft:
		return "draft"
	default:
		return "unknown"
	}
}

// DetectComposer reads a harness composer out of a rendered pane screen.
// agentKind is Herdr's AgentInfo.agent label.
func DetectComposer(agentKind, screen string) ComposerState {
	content, located := composerContent(agentKind, screen)
	if !located {
		return ComposerUnknown
	}
	if strings.TrimSpace(content) != "" {
		return ComposerDraft
	}
	return ComposerEmpty
}

// composerContent returns the text a located composer is holding. The bool
// reports whether a composer was found at all, which is the difference between
// an empty input and an unreadable screen.
func composerContent(agentKind, screen string) (string, bool) {
	if strings.TrimSpace(screen) == "" {
		return "", false
	}
	switch strings.ToLower(strings.TrimSpace(agentKind)) {
	case "omp", "pi":
		return ompComposerContent(screen)
	case "claude":
		return claudeComposerContent(screen)
	default:
		return "", false
	}
}

func ompComposerContent(screen string) (string, bool) {
	lines := strings.Split(screen, "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		footer, ok := ompComposerFooter(lines[index])
		if !ok {
			continue
		}
		// A wrapped draft spills upward into the box body and leaves the footer
		// row empty, so the footer alone does not describe the input.
		rows := []string{footer}
		for above := index - 1; above >= 0; above-- {
			body, ok := ompComposerBody(lines[above])
			if !ok {
				break
			}
			rows = append([]string{body}, rows...)
		}
		return strings.Join(rows, "\n"), true
	}
	return "", false
}

func ompComposerFooter(line string) (string, bool) {
	trimmed := strings.TrimRight(line, " \t\r")
	interior, ok := strings.CutPrefix(trimmed, "╰─")
	if !ok {
		return "", false
	}
	interior, ok = strings.CutSuffix(interior, "─╯")
	// The space is what separates the composer's input row from a collapsed
	// attachment box, whose footer reads "╰ +19 lines ─╯".
	if !ok || !strings.HasPrefix(interior, " ") {
		return "", false
	}
	return interior, true
}

func ompComposerBody(line string) (string, bool) {
	trimmed := strings.TrimRight(line, " \t\r")
	body, ok := strings.CutPrefix(trimmed, "│")
	if !ok {
		return "", false
	}
	return strings.CutSuffix(body, "│")
}

func claudeComposerContent(screen string) (string, bool) {
	lines := strings.Split(screen, "\n")
	for index := len(lines) - 1; index >= 1; index-- {
		text, ok := strings.CutPrefix(strings.TrimSpace(lines[index]), "❯")
		if !ok || !claudeComposerRule(lines[index-1]) {
			continue
		}
		rows := []string{text}
		for below := index + 1; below < len(lines); below++ {
			row := strings.TrimSpace(lines[below])
			if claudeComposerRule(row) {
				break
			}
			rows = append(rows, row)
		}
		return strings.Join(rows, "\n"), true
	}
	return "", false
}

// claudeComposerRule reports whether a line is one of the rules fencing Claude
// Code's composer. The fence carries an inline right-aligned label whenever the
// session has one — "──────── titan-ha-reliability-roadmap ─" — so requiring a
// pure run of rule glyphs left the composer unlocatable on exactly the panes
// that had been running long enough to earn a label, and the guard fell open
// there.
func claudeComposerRule(line string) bool {
	trimmed := strings.TrimSpace(line)
	glyphs := []rune(trimmed)
	if len(glyphs) < 8 || glyphs[0] != '─' || glyphs[len(glyphs)-1] != '─' {
		return false
	}
	rules, segments, inSegment := 0, 0, false
	for _, glyph := range glyphs {
		if glyph == '─' {
			rules++
			inSegment = false
			continue
		}
		if !inSegment {
			// One space-padded label is a fence; anything else is prose that
			// happens to start and end with a rule glyph.
			if segments > 0 {
				return false
			}
			segments++
			inSegment = true
		}
	}
	if segments == 1 && !labelIsPadded(trimmed) {
		return false
	}
	return rules >= 8
}

func labelIsPadded(trimmed string) bool {
	label := strings.Trim(trimmed, "─")
	return strings.HasPrefix(label, " ") && strings.HasSuffix(label, " ")
}

// composerHoldsOnlyPaste reports whether everything in the composer came from
// Transit's own paste of this envelope. Two paths need the distinction: a
// delivery must not be held behind its own unsent paste, and the stall
// recovery must not press Enter once a human has added to it. A large paste
// collapses into an attachment reference rather than rendering its text, and a
// rendered paste is wrapped and clipped, so the comparison is made against the
// envelope with whitespace flattened.
func composerHoldsOnlyPaste(content, envelope string) bool {
	remainder := strings.TrimSpace(stripAttachmentTokens(flattenSpace(content)))
	if remainder == "" {
		return true
	}
	remainder = strings.Trim(remainder, "…")
	if remainder == "" {
		return true
	}
	return strings.Contains(flattenSpace(envelope), remainder)
}

// stripAttachmentTokens removes what a collapsed attachment box contributes to
// the composer row: the reference chip and its line count. Input is already
// space-flattened, so the tokens are plain fields.
func stripAttachmentTokens(text string) string {
	fields := strings.Fields(text)
	kept := make([]string, 0, len(fields))
	countedLines := false
	for _, field := range fields {
		switch {
		case field == "📄":
		case strings.HasPrefix(field, "#") && isDigits(field[1:]):
		case strings.HasPrefix(field, "+") && isDigits(field[1:]):
			countedLines = true
			continue
		case field == "lines" && countedLines:
		default:
			kept = append(kept, field)
		}
		countedLines = false
	}
	return strings.Join(kept, " ")
}

func isDigits(text string) bool {
	if text == "" {
		return false
	}
	return strings.IndexFunc(text, func(glyph rune) bool { return glyph < '0' || glyph > '9' }) < 0
}

func flattenSpace(text string) string {
	var out strings.Builder
	space := false
	for _, glyph := range text {
		if unicode.IsSpace(glyph) {
			space = true
			continue
		}
		if space && out.Len() > 0 {
			out.WriteByte(' ')
		}
		space = false
		out.WriteRune(glyph)
	}
	return out.String()
}

func draftGuardEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("TRANSIT_DRAFT_GUARD")))
	return value != "0" && value != "false"
}
