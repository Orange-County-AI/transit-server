# Native harness adapters and Herdr

Transit delivers the same `transit/1` envelope and exposes the same MCP tools in every supported harness. Claude Code, OMP, Pi, and OpenCode have native adapters that register with the local daemon over `transit-agent/1`; every other harness delivers through Herdr `agent.prompt`.

## How an adapter reaches the daemon

The daemon listens on `<data dir>/agent.sock` — by default `~/.local/share/transit/agent.sock` — with mode `0600`. Frames are newline-delimited JSON on a persistent, bidirectional connection, unlike the one-shot `transit.sock` used by the CLI and the MCP server. The socket is not reachable from the network, and it is authenticated by the kernel rather than by a token in a file: the daemon checks `SO_PEERCRED` for the same UID, records the peer PID's start time so PID reuse cannot impersonate a dead session, and hands back a random 32-hex capability that every later control frame must echo.

An adapter is a local client of the daemon, never a client of the Worker. The daemon keeps sole ownership of the Worker WebSocket, the spool, names, queues, and MCP RPC.

Identity keys on `(harness, session_id)`. A resumed session keeps its address, a fork gets a new one, and each re-registration increments a `generation`. A native session's synthetic pane id is `native:<harness>:<session prefix>`. Because the Transit MCP server runs below the registered harness process, its tool calls resolve identity by walking the caller's PPID chain, which is why `send_message` works with `herdr.service` stopped. The model never supplies `from`.

When an adapter runs inside a Herdr pane, it sends `HERDR_PANE_ID` in its registration frame. Unless the launcher explicitly sets `TRANSIT_AGENT_NAME` or `WORKSPACE_AGENT_NAME`, the daemon adopts that pane's roster name so the native adapter and pane have one address. Registration name precedence is explicit launcher name, persisted `(harness, session_id)` name, matching Herdr pane name, then a generated auto-name. A pane name already persisted for another native session is not adopted. A `claim_name` from a native caller rebinds its native session and renames its matching Herdr pane together.

`transit-agent/1` frames are specified in [Transit protocols](protocols.md); the decisions behind them are in [Transit architecture](architecture.md).

## Claude Code

Install `daemon/plugin/claude` as a Claude Code plugin, then place the daemon executable at `bin/transit` under the installed plugin root; a symlink or a copy both work. The `transit-inbox` monitor runs:

```sh
"${CLAUDE_PLUGIN_ROOT}"/bin/transit adapter listen --harness claude
```

The `SessionStart` hook records the Claude session id, transcript path, and working directory under Transit's data directory, overwriting that state with the new transcript path on resume. A Claude restart stops the monitor process; resuming the session runs `SessionStart` again and Claude re-arms the monitor, so a resumed session re-registers without manual intervention.

A write is not an acknowledgement. The monitor writes the envelope to stdout and acknowledges only once the delivery id appears in the session's `transcript_path`; on timeout it sends a retryable `deliver_nak`, and at-least-once plus delivery-id deduplication covers the retry.

## OMP

Copy the extension into OMP's user extension directory from a Transit checkout:

```sh
mkdir -p ~/.omp/agent/extensions
cp -R daemon/contrib/omp-extension ~/.omp/agent/extensions/transit
```

OMP discovers `~/.omp/agent/extensions/transit/package.json` and its `omp.extensions` manifest enables `index.js`, so no setting or flag is needed; start a new OMP session afterwards. To scope it to one repository, copy the same package to `.omp/extensions/transit` instead.

The extension registers `ctx.sessionManager.getSessionId()` and injects a delivered envelope with `pi.sendUserMessage(envelope, { deliverAs: "steer" })`. It then records a `transit-delivery-receipt` session entry with `pi.appendEntry` and acknowledges only after that write completes. On a resumed session it rebuilds the receipt set from the current session branch, so a redelivery is acknowledged without reinjecting it.

If the daemon is unavailable when OMP starts, the extension reconnects with a bounded 1-30 second backoff. It connects to `${TRANSIT_DATA_DIR:-$HOME/.local/share/transit}/agent.sock`, so set `TRANSIT_DATA_DIR` before launching OMP when the daemon uses a non-default data directory.

## Pi

The OMP extension package also contains a standalone Pi entrypoint. Install it from a Transit checkout:

```sh
pi install ./daemon/contrib/omp-extension
```

Use `pi install -l ./daemon/contrib/omp-extension` for one repository. The package's `pi.extensions` manifest loads `pi.js`, which registers `ctx.sessionManager.getSessionId()` as harness `pi`. Delivery, durable `transit-delivery-receipt` entries, resume deduplication, and reconnect behavior are identical to OMP.

## OpenCode

Copy the TUI plugin from `daemon/contrib/opencode-plugin/index.js` into the OpenCode configuration directory, then add it to the `plugin` array in `~/.config/opencode/tui.jsonc`:

```sh
cp daemon/contrib/opencode-plugin/index.js ~/.config/opencode/transit-opencode.js
```

```json
{
  "plugin": ["./transit-opencode.js"]
}
```

The plugin follows the root session selected by the TUI and registers its OpenCode session id. It injects deliveries with `client.session.promptAsync`, then acknowledges only after `client.session.messages` contains the delivery id. The persisted user message is also the deduplication receipt, so a resumed session acknowledges a redelivery without reinjecting it. Switching sessions closes the old registration and registers the newly selected root; child sessions are never registered as the pane identity.

The plugin reconnects to `${TRANSIT_DATA_DIR:-$HOME/.local/share/transit}/agent.sock` with bounded backoff. It therefore recovers when the daemon starts after OpenCode, but the plugin must be installed before the TUI session starts.

## Every other harness

The daemon falls back to Herdr `agent.prompt`, which needs Herdr 0.8.2 or newer with `herdr.service` running. Before a Herdr-path delivery, the daemon reads the target pane with `pane.read`, `source=visible`, and `strip_ansi` to protect a person's unsent composer input. It holds only when it positively recognizes the OMP/Pi box footer and wrapped body, or a Claude Code `❯` row fenced by rule lines; a Claude fence may carry an inline label such as a plan name. Detection is one-sided and fail-open: an unfamiliar harness, an unlocatable composer, or a failed pane read delivers as it did before the guard, because starving a durable queue is worse than the clobber the guard prevents. A hold naks with retryable `draft_busy` and leaves the HostHub attempt count unchanged; the daemon watches the held pane and sends a roster snapshot the moment the composer clears, so the delivery resumes without spending the host's hourly alarm budget. A large paste can collapse into an OMP attachment chip and absorb Herdr's submit key, causing `agent_prompt_stalled`; the daemon then sends the recovery `Enter` regardless, notifies when a person's own text went with it, and submits an already-pasted envelope rather than typing a second copy. A prompt that failed with a coded `timeout` is still acknowledged when the pane shows the agent moved, so a delivered envelope is not redelivered. `TRANSIT_DRAFT_GUARD=0` or `false` disables the guard.

Herdr injection still targets a terminal container rather than a session and cannot distinguish a resumed session from a new one. Native adapters can identify the session that owns a delivery, avoiding those PTY identity failures, but native delivery is not composer-guarded: an adapter registers a harness session rather than a pane, and no harness API exposes composer state. A native delivery can therefore steer into the session while a person is composing.

Transit also ships a Herdr plugin, `ocai.transit` from `daemon/plugin/herdr-plugin.toml`, which installs the daemon and provides the inbox pane and the dashboard and pause actions. See [Hosts and the daemon](hosts.md).

## Choosing the policy

`delivery_mode` in `~/.config/transit/config.json`, or `TRANSIT_DELIVERY_MODE`, selects how native adapters and Herdr interact:

| mode | behavior |
| --- | --- |
| `shadow` | native sessions register and appear in the roster, Herdr still delivers |
| `prefer` (default) | native adapter when registered, Herdr otherwise |
| `require` | Claude Code, OMP, Pi, and OpenCode refuse delivery with retryable `adapter_unavailable` when their adapter is absent |

Native registration always wins over a matching Herdr roster entry. `require` is the correct end state, because silent fallback hides a broken adapter install; keep a fleet in `prefer` while adapters are still being rolled out, or in `shadow` to register natively while Herdr keeps delivering.

## What does not change with the adapter

- Delivery is at least once, so an agent deduplicates by envelope `id`.
- Channel deliveries require `read_message` before `chat_reply` or `mark_handled` settles them.
- Sender identity comes from the local adapter; agents never supply a `from` value.
- Direct messages use `name@host`; rooms use `#room`.

Never infer the transport from an envelope. Read [Transit protocols](protocols.md) for the exact envelope, MCP, and `transit-agent/1` contracts, and [Agent skill](agent-skill.md) for the canonical agent instructions.
