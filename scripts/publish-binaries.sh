#!/usr/bin/env bash
# Manual path for publishing the compiled binaries while Actions minutes are
# unavailable: builds, packs and uploads the assets to the GitHub Release for
# the tag (creating the release if the tag push did not). The `binaries` job
# in .github/workflows/publish.yml does the same on CI.
#
# Usage: scripts/publish-binaries.sh [vX.Y.Z]   (default: v<package.json version>)
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh is not installed — https://cli.github.com" >&2
  exit 1
fi

tag="${1:-v$(node -p "require('./package.json').version")}"

scripts/build-binaries.sh
scripts/package-binaries.sh

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --title "$tag" --verify-tag --notes "Release $tag"
fi
gh release upload "$tag" dist-release/* --clobber
echo "published $(ls dist-release | wc -l | tr -d ' ') assets to $tag"
