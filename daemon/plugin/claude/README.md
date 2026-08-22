# Transit Claude plugin

Install this directory as a Claude Code plugin, then put the daemon executable at
`bin/transit` under the installed plugin root (a symlink or a copy both work).
The `transit-inbox` monitor runs:

```sh
"${CLAUDE_PLUGIN_ROOT}"/bin/transit adapter listen --harness claude
```

The SessionStart hook records the Claude session ID, transcript path, and working
directory under Transit’s data directory. On resume it overwrites that state with
the new transcript path.

A Claude restart stops the monitor process. Resuming the session runs SessionStart
again and Claude autonomously re-arms the monitor, so the resumed session registers
with Transit without manual intervention.
