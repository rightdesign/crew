#!/usr/bin/env bash
# Installs the crew binary for this host's architecture and runs `crew provision`.
# Meant for a cloud first-boot hook (user data, cloud-init) on a headless Linux
# host; also fine by hand. Every argument is passed on to `crew provision`, and
# the connect key and forge token are read from the environment so they stay
# out of the process list:
#
#   CREW_CONNECT_KEY=sk_... CREW_FORGE_TOKEN=ghp_... \
#     bash provision.sh --route my-workspace --ship-name build-1 --json
#
# Environment (all optional except the key and a route, which `crew provision` checks):
#   CREW_VERSION        release to install, e.g. 0.94.0 (default: the latest release)
#   CREW_RELEASE_BASE   where release assets are served (default: the GitHub releases of rightdesign/crew);
#                       a mirror must serve <base>/v<version>/<asset> and <base>/latest
#   CREW_INSTALL_DIR    where the build is unpacked (default: /opt/crew as root, else ~/.local/share/crew)
#   CREW_BIN_DIR        where the `crew` symlink goes (default: /usr/local/bin as root, else ~/.local/bin)
#
# Re-running reuses an installed build of the same version and reconciles the
# rest (an upgrade replaces the build in place; a running daemon picks it up at its next restart); `crew provision` reports `already provisioned` when nothing changed.
set -euo pipefail

repo="rightdesign/crew"
base="${CREW_RELEASE_BASE:-https://github.com/${repo}/releases}"

die() { echo "provision.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

[ "$(uname -s)" = "Linux" ] || die "this script is for Linux hosts (use the Crew app or npm on a Mac)"
need curl; need tar; need git
case "$(uname -m)" in
  x86_64|amd64) target="linux-x64" ;;
  aarch64|arm64) target="linux-arm64" ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

if [ "$(id -u)" = "0" ]; then
  install_dir="${CREW_INSTALL_DIR:-/opt/crew}"; bin_dir="${CREW_BIN_DIR:-/usr/local/bin}"
else
  install_dir="${CREW_INSTALL_DIR:-$HOME/.local/share/crew}"; bin_dir="${CREW_BIN_DIR:-$HOME/.local/bin}"
fi

version="${CREW_VERSION:-}"
if [ -z "$version" ]; then
  # /releases/latest redirects to /releases/tag/v<version>.
  final="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "${base}/latest")" || die "could not look up the latest release"
  version="${final##*/v}"
fi
version="${version#v}"
[ -n "$version" ] || die "could not work out the release version"

# One directory, not one per version: the systemd unit names the binary's path
# (and its label hashes the real path), so the path must not change on upgrade.
dest="$install_dir"
installed=""
[ -r "${dest}/package.json" ] && installed="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${dest}/package.json" | head -n1)"
if [ ! -x "${dest}/crew" ] || [ "$installed" != "$version" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  asset="crew-${version}-${target}.tar.gz"
  curl -fsSL -o "${tmp}/${asset}" "${base}/download/v${version}/${asset}" || die "could not download ${asset}"
  curl -fsSL -o "${tmp}/SHA256SUMS" "${base}/download/v${version}/SHA256SUMS" || die "could not download SHA256SUMS"
  (cd "$tmp" && grep " ${asset}\$" SHA256SUMS | sha256sum -c -) >&2 || die "checksum mismatch for ${asset}"
  mkdir -p "${tmp}/unpacked"
  tar -xzf "${tmp}/${asset}" -C "${tmp}/unpacked"
  mkdir -p "$(dirname "$dest")"
  # Swap by rename so a running daemon keeps its old binary until it restarts.
  rm -rf "${dest}.old"
  [ -e "$dest" ] && mv "$dest" "${dest}.old"
  mv "${tmp}/unpacked" "$dest"
  rm -rf "${dest}.old"
fi

mkdir -p "$bin_dir"
ln -sfn "${dest}/crew" "${bin_dir}/crew"
export PATH="${bin_dir}:${PATH}"

exec "${dest}/crew" provision "$@"
