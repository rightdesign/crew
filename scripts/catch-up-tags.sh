#!/usr/bin/env bash
# Tag any `Release vX.Y.Z` commit that has no tag yet.
#
# The bash loop this replaces records releases in a private ref
# (refs/tablation/last-release) and creates no tags, so every release it ships
# widens the gap between what is tagged and what has actually shipped. The Node
# runner reads tags, and would try to re-release anything untagged.
#
# Idempotent and local-only. Run it before cutover, and any time the gap
# matters. Nothing is pushed.
set -euo pipefail
repo="${1:?usage: catch-up-tags.sh <repo> [tag-template]}"
template="${2:-v{version}}"
cd "$repo"

created=0 skipped=0
while read -r sha subject; do
  version="${subject#Release v}"
  tag="${template/\{version\}/$version}"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
    skipped=$((skipped + 1)); continue
  fi
  GIT_COMMITTER_DATE="$(git log -1 --format=%cI "$sha")" \
    git tag -a "$tag" "$sha" -m "$subject"
  echo "  tagged $tag at ${sha:0:8}"
  created=$((created + 1))
done < <(git log --format='%H %s' --grep='^Release v' HEAD)

echo "catch-up: $created created, $skipped already present"
echo "latest: $(git describe --tags --abbrev=0 --match "${template/\{version\}/*}" HEAD)"
