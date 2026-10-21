#!/usr/bin/env bash
# Packs the per-target directories build-binaries.sh left in dist-bin/ into
# release assets under dist-release/: one crew-<version>-<target>.tar.gz per
# target (binary plus prompts/, package.json, crew.example.yaml at the top
# level of the archive) and a SHA256SUMS covering them. Shared by the
# `binaries` job in .github/workflows/publish.yml and by
# scripts/publish-binaries.sh so both produce identical asset names.
set -euo pipefail

cd "$(dirname "$0")/.."

version="$(node -p "require('./package.json').version")"
out="dist-release"

if [ ! -d dist-bin ]; then
  echo "error: dist-bin/ is missing — run scripts/build-binaries.sh first" >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$out"

for dir in dist-bin/*/; do
  target="$(basename "$dir")"
  if [ ! -x "$dir/crew" ]; then
    echo "error: $dir/crew is missing or not executable" >&2
    exit 1
  fi
  tar -czf "$out/crew-${version}-${target}.tar.gz" -C "$dir" .
done

if command -v sha256sum >/dev/null 2>&1; then
  sum=(sha256sum)
else
  sum=(shasum -a 256)
fi
(cd "$out" && "${sum[@]}" crew-*.tar.gz > SHA256SUMS)

echo "packed:"
ls -l "$out"
