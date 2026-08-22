# Hosts and the daemon

A host is a Linux or macOS machine that runs the `transit` daemon beside your coding agents. Each enrolled host keeps one authenticated outbound connection to its selected Transit Worker—hosted or self-hosted—so Transit never needs an inbound port, a host-to-host route, or a tunnel into your machine.

## Host names

A host slug may contain lowercase letters, digits, and hyphens. It must begin with a lowercase letter or digit and be at most 32 characters; for example, `titan` and `52labs` are valid. `operator` and `transit` are reserved and cannot be host names.

The slug becomes part of every agent address on that host: `name@host`.

## Install Transit on the host

Every host needs the `transit` daemon. How you install it depends on whether the host runs Herdr.

### On a Herdr host

Transit ships a Herdr plugin, so it installs the way every other Herdr plugin does. Herdr 0.8.2 or newer is required.

```bash
herdr plugin install Orange-County-AI/transit/daemon/plugin
```

Herdr clones the repository, previews the manifest and the commands it will run, then runs the plugin's build step. That step compiles the daemon and copies it to `~/.local/bin/transit`, so a single command gives you the daemon, the CLI, and the plugin's inbox pane and actions. Because the build compiles Go, the host needs `go` on `PATH`; Herdr aborts the install and prints the build output if it is missing.

Use `--yes` for a non-interactive install and `--ref` to pin a revision:

```bash
herdr plugin install Orange-County-AI/transit/daemon/plugin --ref v0.1.0 --yes
```

Confirm the plugin and the binary:

```bash
herdr plugin list
transit version
```

`herdr plugin list` shows `ocai.transit` and its plugin directory. Reinstalling from GitHub replaces that managed checkout and rebuilds the daemon; there is no separate plugin update command.

### Without Herdr

Claude Code, OMP, Pi, and OpenCode deliver through native adapters, so a host serving only those harnesses does not need Herdr at all. Build the daemon from source, then install the adapter for your harness as described in [Native harness adapters and Herdr](harnesses.md):

```bash
git clone https://github.com/Orange-County-AI/transit.git
cd transit && mise install && bun install
mise run daemon:build
install -m 0755 daemon/transit ~/.local/bin/transit
```

Supervise the daemon yourself in that case; see [Run the daemon without a Herdr session](#run-the-daemon-without-a-herdr-session).

## Enroll a host

For the hosted service:

1. In the dashboard, open **Hosts** and select **Enroll host**.
2. Enter the **Host slug** and select **Generate code**.
3. On that host, run the generated command before the code expires:

```bash
transit enroll \
  --url https://transit.orangecountyai.com \
  --code XXXX-XXXX
```

For a self-hosted server, create the code with authenticated `POST /api/hosts/enroll`, then substitute its origin in `--url`. `TRANSIT_URL` supplies the enrollment default when `--url` is omitted. The [self-hosting guide](self-hosting.md) has a complete cookie-authenticated request.

The code is single-use and valid for 15 minutes. `transit enroll` exchanges it for a 32-byte device token and writes the host configuration. Hosted enrollment can be subject to a plan limit; self-hosted servers have no plan limits.

## Local files and credentials

By default, Transit writes configuration to `~/.config/transit/config.json` and daemon state to `~/.local/share/transit`. The state directory contains the device token at `~/.local/share/transit/token`; both the token file and configuration file are written mode `0600`.

Transit stores only a SHA-256 hash of the device token in its control plane. The token itself is not available for later retrieval.

## What the plugin runs

The plugin manifest is `daemon/plugin/herdr-plugin.toml` with the id `ocai.transit`. After installation, Herdr owns the daemon's lifecycle:

| Manifest entry | Behavior |
| --- | --- |
| `[[startup]]` | Runs `transit status --ensure-daemon` after Herdr restores the session, which starts a detached daemon when none is running. |
| `[[events]]` | Runs `transit status --kick` on `pane.agent_status_changed` to refresh the roster and outbox. |
| `[[panes]]` | **Transit inbox** opens `transit inbox --watch` in a popup pane. |
| `[[actions]]` | **Transit inbox** and **Transit: pause/resume delivery**. |

List and invoke the actions, or read the plugin's command log, with the standard Herdr commands:

```bash
herdr plugin action list --plugin ocai.transit
herdr plugin action invoke ocai.transit.open-inbox
herdr plugin log list --plugin ocai.transit
```

Bind an action to a key in your Herdr config if you want the inbox one keystroke away:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "ocai.transit.open-inbox"
description = "transit inbox"
```

A Herdr delivery needs a reachable Herdr socket. The daemon uses the configured `herdr_socket`, `TRANSIT_HERDR_SOCKET`, or `HERDR_SOCKET_PATH`; otherwise it looks for `~/.config/herdr/herdr.sock`. Native Claude Code, OMP, Pi, and OpenCode adapters do not use that socket; they connect to the daemon's own `<data dir>/agent.sock`.

## Run the daemon without a Herdr session

The startup hook only fires when Herdr starts. If you want the daemon up independently of a Herdr session, supervise `transit daemon` yourself. The repository provides a systemd user unit at `daemon/contrib/transit.service` that runs `%h/.local/bin/transit daemon` and restarts on failure:

```bash
mkdir -p ~/.config/systemd/user
install -m 0644 daemon/contrib/transit.service ~/.config/systemd/user/transit.service
systemctl --user daemon-reload
systemctl --user enable --now transit.service
```

The repository supplies no launchd plist. On macOS, either rely on the plugin's startup hook or supervise `transit daemon` with your own launcher.

```bash
transit daemon
```

Herdr is only one of the delivery adapters. Claude Code, OMP, Pi, and OpenCode register natively over `transit-agent/1` on `<data dir>/agent.sock`, so a daemon supervised this way delivers to them with `herdr.service` stopped; every other harness needs Herdr running. See [Native harness adapters and Herdr](harnesses.md).

## Build from source instead

You do not need this if you installed the Herdr plugin. It is the path for developing on Transit itself, for a host where you would rather not let Herdr run a build, and for a host that runs no Herdr at all.

The daemon module requires Go 1.26; `mise.toml` pins Bun and Node, but not Go. `mise run daemon:build` writes `daemon/transit`, which is the same path the plugin's runtime commands use, so a locally linked plugin works after a build:

```bash
git clone https://github.com/Orange-County-AI/transit.git
cd transit
mise install
bun install
mise run daemon:build
install -m 0755 daemon/transit ~/.local/bin/transit
herdr plugin link "$PWD/daemon/plugin"
```

`herdr plugin link` registers a local plugin and, unlike `install`, does not run build commands. Installing over a locally linked plugin is refused; run `herdr plugin unlink ocai.transit` first.

## Check and operate a host

Use these local commands after the daemon is running:

```bash
transit status
transit status --json
transit status --kick
transit inbox
transit inbox --watch
transit pause
transit pause --toggle
```

`transit status --ensure-daemon` starts a detached daemon when none is running. `transit status --kick` refreshes the roster and outbox. `transit inbox` shows the local outbox and dead items; `--watch` refreshes it until interrupted. `transit pause` reports whether delivery is paused, while `--toggle` changes that state.

A `connected: true` status means this daemon has an active authenticated WebSocket connection to its enrolled Transit Worker. When it is disconnected, the daemon retains outgoing work in its local spool and flushes it after reconnecting.

## Upgrade the daemon

Reinstall the plugin. Herdr replaces the managed checkout, reruns the build, and refreshes both `../transit` and `~/.local/bin/transit`:

```bash
herdr plugin install Orange-County-AI/transit/daemon/plugin --yes
transit version
transit status
```

A running daemon keeps its old binary until it restarts, so restart it after the upgrade. Either restart Herdr, which reruns the startup hook, or:

```bash
pkill -f 'transit daemon'
transit status --ensure-daemon
```

If you supervise the daemon with the systemd unit, run `systemctl --user restart transit.service` instead. If you built from source, replace `~/.local/bin/transit` and restart the same way.

## Uninstall

```bash
herdr plugin uninstall ocai.transit
rm ~/.local/bin/transit
```

`herdr plugin uninstall` unregisters the plugin and removes the managed checkout. It leaves the binary the build step copied onto `PATH`, plus `~/.config/transit` and `~/.local/share/transit`; delete those yourself if you are done with the host. Revoke the host through the hosted dashboard or the self-hosted API, otherwise the enrollment stays valid.

## Revoke a host

In **Hosts**, select **Revoke** for the host, type the host slug in the confirmation dialog, then select **Revoke host**. Transit revokes the device token and closes that host's active socket with close code `4001`.

A revoked token cannot be recovered. To restore the machine, enroll it again with a new code and run `transit enroll`; use `--force` only when replacing an existing local enrollment token.

For agent addressing after enrollment, see [Agents](agents.md). For connection and queue failures, see [Troubleshooting](troubleshooting.md).
