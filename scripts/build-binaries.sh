#!/usr/bin/env bash
# Builds standalone `crew` binaries with bun, so a target machine needs
# neither node nor pnpm. One output dir per target under dist-bin/, each
# holding the compiled binary plus the assets it reads from disk at
# runtime (prompts/, package.json for its own version, crew.example.yaml
# for `crew connect`'s pointer to it) — see src/runtime-info.ts for how
# the compiled binary resolves CREW_HOME to its own directory instead of
# the checkout root a `node bin/crew` run resolves to.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed — https://bun.sh/install" >&2
  exit 1
fi

targets=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-linux-x64:linux-x64"
)

rm -rf dist-bin
for entry in "${targets[@]}"; do
  bun_target="${entry%%:*}"
  dir_name="${entry##*:}"
  out="dist-bin/${dir_name}"
  mkdir -p "$out"
  echo "==> ${dir_name}"
  bun build src/cli.ts --compile --target="${bun_target}" --outfile "${out}/crew"
  cp -R prompts "$out/"
  cp package.json crew.example.yaml "$out/"
done

echo
echo "built:"
du -sh dist-bin/*
