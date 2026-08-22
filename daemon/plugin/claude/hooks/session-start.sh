#!/usr/bin/env bash
set -euo pipefail

state_path="$({
  node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const sessionID = input.session_id;
const transcriptPath = input.transcript_path;
const cwd = input.cwd;
if (typeof sessionID !== "string" || !sessionID ||
    typeof transcriptPath !== "string" || !transcriptPath ||
    typeof cwd !== "string" || !cwd) {
  throw new Error("SessionStart input is missing session_id, transcript_path, or cwd");
}
if (!/^[A-Za-z0-9._-]+$/.test(sessionID)) {
  throw new Error("SessionStart session_id contains unsupported filename characters");
}
const dataDir = process.env.TRANSIT_DATA_DIR ||
  (process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "transit") : path.join(os.homedir(), ".local", "share", "transit"));
const stateDir = path.join(dataDir, "claude-sessions");
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const statePath = path.join(stateDir, `${sessionID}.json`);
const state = {
  session_id: sessionID,
  transcript_path: transcriptPath,
  cwd,
  source: typeof input.source === "string" ? input.source : ""
};
const temporary = path.join(stateDir, `.${sessionID}.${process.pid}.tmp`);
// The surrounding shell string is single-quoted, so this JS source reaches
// node verbatim: "\n" is a newline, and "\\n" would write a literal
// backslash-n that makes the state file fail to decode.
fs.writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
fs.renameSync(temporary, statePath);
process.stdout.write(statePath);
' 
} )"

# Claude hooks cannot modify their parent process environment. This makes the
# resolved state available to hook subprocesses; the monitor also falls back to
# the newest file in this directory when Claude starts it separately.
export CLAUDE_SESSION_STATE="$state_path"
