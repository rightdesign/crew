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

# Universal macOS binary: bun keeps its embedded module graph in the Mach-O
# __BUN segment and the file ends exactly at __LINKEDIT, so `lipo -create`
# carries each slice's payload through intact. Needs macOS's lipo, which is
# why the CI `binaries` job runs on a macOS runner. The per-architecture
# directories stay: the Crew macOS app updates from those.
if command -v lipo >/dev/null 2>&1; then
  echo "==> darwin-universal"
  uni="dist-bin/darwin-universal"
  mkdir -p "$uni"
  lipo -create -output "$uni/crew" dist-bin/darwin-arm64/crew dist-bin/darwin-x64/crew
  cp -R prompts "$uni/"
  cp package.json crew.example.yaml "$uni/"
  lipo -info "$uni/crew"

  # Smoke test. The slice matching this machine runs natively; the x86_64
  # slice needs Rosetta (or an Intel host) and is skipped loudly otherwise.
  "$uni/crew" --version
  if [ "$(uname -m)" = "x86_64" ]; then
    echo "x86_64 slice exercised natively"
  elif arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
    arch -x86_64 "$uni/crew" --version
    echo "x86_64 slice exercised under Rosetta"
  else
    echo "note: x86_64 slice NOT exercised (no Rosetta on this machine)"
  fi
else
  echo "note: lipo not found — skipping darwin-universal (needs macOS)"
fi

echo
echo "built:"
du -sh dist-bin/*
