#!/bin/sh
# Transit daemon installer. Served by the Worker at /install, so the command a
# person runs names our own origin and never a third-party host:
#
#   curl -fsSL https://transit.orangecountyai.com/install | sh
#
# It downloads a prebuilt binary from /dl on the SAME origin it was fetched
# from, which is what makes a self-hosted Worker serve its own daemon without
# editing anything. POSIX sh on purpose: this has to run on a stock host before
# anything of ours is installed.
set -eu

# --- where this came from -----------------------------------------------------
# TRANSIT_ORIGIN is rewritten by the Worker before this is served, so a piped
# install inherits the origin it was piped from. The default only matters when
# somebody runs the file straight out of the repository.
ORIGIN="${TRANSIT_ORIGIN:-https://transit.orangecountyai.com}"
INSTALL_DIR="${TRANSIT_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  error: %s\n\n' "$*" >&2; exit 1; }

# --- what we are running on ---------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "unsupported operating system: $os (Transit builds for Linux and macOS)" ;;
esac

case "$arch" in
  x86_64 | amd64) arch="amd64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) die "unsupported architecture: $arch (Transit builds for amd64 and arm64)" ;;
esac

# --- fetch --------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "neither curl nor wget is available"
fi

printf '\n  Transit daemon\n'
say "$os/$arch"

tmp="$(mktemp -d)"
# Clean up on any exit path, including the failures below.
trap 'rm -rf "$tmp"' EXIT INT TERM

url="$ORIGIN/dl/$os/$arch"
say "fetching $url"
fetch "$url" "$tmp/transit" || die "download failed from $url"

# A redirect that lands on an error page is still a 200 with bytes in it, so
# check we actually got a program rather than trusting the status code.
if [ ! -s "$tmp/transit" ]; then
  die "downloaded file is empty"
fi

chmod +x "$tmp/transit"
if ! "$tmp/transit" version >/dev/null 2>&1; then
  die "the downloaded file did not run — expected a $os/$arch binary"
fi
installed_version="$("$tmp/transit" version 2>/dev/null || echo unknown)"

# --- install ------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
# mv across filesystems can fail; cp then remove is portable.
cp "$tmp/transit" "$INSTALL_DIR/transit.new"
chmod +x "$INSTALL_DIR/transit.new"
# Rename last, so a half-written file never sits at the real path and a running
# daemon keeps its open inode.
mv "$INSTALL_DIR/transit.new" "$INSTALL_DIR/transit"

say "transit $installed_version"
say "installed → $INSTALL_DIR/transit"

# --- tell them what is next ---------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\n'
    say "$INSTALL_DIR is not on your PATH. Add it:"
    say "  export PATH=\"\$PATH:$INSTALL_DIR\""
    ;;
esac

printf '\n  Next: transit enroll\n\n'
