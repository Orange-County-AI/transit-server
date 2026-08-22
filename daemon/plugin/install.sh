#!/bin/sh
# Build step for `herdr plugin install Orange-County-AI/transit-server/daemon/plugin`.
#
# Herdr clones the repository, runs this from the plugin directory (no shell, so
# the manifest calls `sh install.sh`), and registers the plugin only if this
# exits 0. It compiles the daemon next to its source at ../transit, which the
# manifest's startup hook, event hook, pane, and actions all invoke, then copies
# the same binary onto PATH so `transit enroll` and the stdio MCP server resolve
# a stable command name that survives a plugin reinstall.
set -eu

plugin_dir=$(cd "$(dirname "$0")" && pwd)
source_dir=$(cd "$plugin_dir/.." && pwd)
install_dir=${TRANSIT_INSTALL_DIR:-$HOME/.local/bin}

if ! command -v go >/dev/null 2>&1; then
  echo "transit: this plugin compiles a Go binary and needs 'go' on PATH (https://go.dev/dl/)" >&2
  exit 1
fi

echo "transit: building the daemon in $source_dir"
(cd "$source_dir" && CGO_ENABLED=0 go build -o transit .)

# Replace by rename: copying over the running daemon's own binary fails with
# ETXTBSY, and a rename keeps the live process on its old inode.
mkdir -p "$install_dir"
staged="$install_dir/.transit.$$"
trap 'rm -f "$staged"' EXIT INT TERM
cp "$source_dir/transit" "$staged"
chmod 0755 "$staged"
mv "$staged" "$install_dir/transit"

echo "transit: installed $("$install_dir/transit" version) at $install_dir/transit"

case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) echo "transit: add $install_dir to PATH so 'transit' and the MCP server resolve" >&2 ;;
esac

echo "transit: enroll this host next — transit enroll --url <your-transit-server> --code <code> (or set TRANSIT_URL to supply the default)"
