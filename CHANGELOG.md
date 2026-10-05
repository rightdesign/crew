# Changelog

All notable changes to `@tablation/crew`. Versions are the `version` field in
`package.json`.

## How this file is maintained

Nobody edits this file or bumps `package.json` on a ticket branch. Each ticket
branch records, in its own commit message, a `Bump: patch|minor` trailer
(never `major`, that stays a manual call) and one or more `Changelog: <line>`
trailers worded as they should read here, each with its ticket reference.

Each cycle the release phase (`release.mode: ci_auto` in `.crew.yaml`)
squash-merges every verified ticket, then in one following commit adds one
`## [x.y.z] — YYYY-MM-DD` section here (newest first, a bullet per
`Changelog:` line across the batch) and bumps `package.json`, sized by the
largest `Bump:` in the batch. It pushes `main` and the annotated `v<x.y.z>`
tag; the tag triggers `.github/workflows/publish.yml`, which publishes to npm.

## [0.2.0] — 2026-10-05

- `crew repos add` takes optional route, repo name and path — run from inside a checkout it uses the current directory, the only configured route, and the origin remote's repo name (CREW-1362)

## [0.1.7] — 2026-10-05

- `merged_at` now records the merge commit's own date instead of the stamp time, so it no longer mirrors `released_at` in ci_* modes (CREW-1361)
