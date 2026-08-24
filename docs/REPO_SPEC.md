# `.crew.yaml` — the repo contract

A repository that a crew works declares, in a file at its root, what a ship
must be able to do to build it and what the commands are. `.crew.yaml` is
preferred; `.crew.json` is accepted and parsed identically.

This file is **the repo describing itself**. It is deliberately not in the
tracker, for three reasons:

1. **A hook is code.** It belongs beside what it builds, under review and in
   version control, changing atomically with the thing it tests. A repo whose
   test command changes in the same commit as its test runner stays correct;
   one whose command lives in a database does not.
2. **Security.** Shell stored in a workspace record and executed on every
   connected ship would make the tracker a remote-code-execution vector:
   anyone who can edit a record could run commands on other people's
   machines. That matters more once templates are installed into workspaces
   nobody here controls.
3. It is the direction the PRD already sets (R14: *briefs name hooks rather
   than commands*).

The tracker's `Repos` row holds what the repo **cannot** know: which area it
serves, which other repos must release before it, and whether it is enabled.

## Minimal example

```yaml
version: 1
platform: unix
hooks:
  test: pnpm test
  build: pnpm build
```

## Full example

```yaml
# The version of THIS SPEC the file is written against. Required.
version: 1

# What a ship must be to run the hooks below:
#   any | unix | macos | linux | windows
# "unix" is right for POSIX-shell hooks; name a single host only when the
# repo genuinely requires it (an Xcode build needs macos). A ship that cannot
# satisfy this will not be given work from this repo.
platform: unix

# How this repo names the branches the crew creates. A convention, not a
# constant: `issue-326` suits one org, `feature/ISSUE-326-add-widget`
# another, and a repo with branch protection may require a prefix to be
# pushable at all.
#
# Placeholders: {key} (ISSUE-326), {number} (326), {slug} (the title,
# slugified and safe in a git ref), {role} (dev/design/qa).
branch:
  base: main                 # what work is cut from and merged back into
  name: "issue-{number}"     # the local working branch
  push: "crew/{key}"         # what it is called on the remote, if different
  remote: origin

# The interpreter the hooks are written for. Defaults to bash on macOS and
# Linux, PowerShell on Windows. The crew never parses a hook — it hands the
# script to this interpreter and reads the exit status — so the language is
# entirely yours.
shell: bash

hooks:
  # Every hook is a script run from the repo root. Exit status decides
  # pass/fail. Use a YAML block scalar for anything multi-step.
  #
  # Required for a repo the crew builds:
  test: |
    ok=0
    pnpm --filter backend test || ok=1
    pnpm --filter frontend test || ok=1
    exit "$ok"
  build: pnpm build

  # Optional. Omit any that do not apply.
  setup: pnpm install --frozen-lockfile   # run once in a fresh worktree
  deploy: ./deploy.sh                     # only when release.mode is `local`
  ports: scripts/dev-ports.sh             # prints KEY=value port assignments

  # Prints this repo's CURRENT version, on one line. Where versions live is
  # entirely a repo's business — package.json, Cargo.toml, pyproject.toml, a
  # VERSION file, or `git describe --tags`.
  version: node -p "require('./package.json').version"

  # Applies a version increment and prints the NEW version, on one line.
  # Receives CREW_BUMP=major|minor|patch in its environment.
  #
  # Defining this REPLACES `release.versionFiles` — the repo owns where
  # versions are written and how they are computed, which is the only way a
  # non-npm project can be released at all.
  bump: |
    npm version "$CREW_BUMP" --no-git-tag-version >/dev/null
    node -p "require('./package.json').version"

  # Did this ticket's work land? Exit 0 for yes, non-zero for no.
  # Receives CREW_TICKET, CREW_BRANCH and CREW_BASE in its environment.
  #
  # Define this wherever closure matters. Without it the crew falls back to
  # searching the base branch for the ticket key, which a squash merge keeps
  # only if whoever merged left the PR title alone — useful, but not something
  # to close a ticket on. One line is usually enough:
  merged: gh pr list --head "$CREW_BRANCH" --state merged --json number | grep -q number

  # Prints, on one line, WHAT IS LIVE RIGHT NOW — a commit sha or a version.
  # This is how the crew learns the outcome of a release it did not perform,
  # so it is REQUIRED for `ci_manual` and `ci_auto`, and merely useful for
  # `local`. A hook rather than a URL because "what is live" is answered very
  # differently per project: an HTTP health endpoint, `npm view <pkg>
  # version`, a registry query, `kubectl get deploy -o jsonpath=...`.
  released: curl -sf https://example.com/api/health-check | jq -r .commit

# Human-readable names for the hooks, used in log lines and in tickets the
# crew files. Defaults to the script itself, which reads badly when it is
# eight lines of shell.
labels:
  test: pnpm test (backend + frontend)
  build: pnpm build

release:
  # Whether the crew touches this repo's version at all:
  #   auto  bump on release — via `bump`, or by rewriting `versionFiles`
  #   none  never write a version. A release is identified by its commit.
  #         Right for a repo that does not version, and for one whose version
  #         a human or another tool controls; `version` is still read, if
  #         defined, so a release can be REPORTED by version without the crew
  #         ever setting one.
  versioning: auto

  # What "release" means here:
  #   local      the crew runs the deploy hook itself
  #   ci_manual  the crew triggers CI and waits for its result
  #   ci_auto    CI releases on its own; the crew pushes, then WATCHES.
  #              It must not also deploy, or the release happens twice.
  mode: local

  # Where CI lives, when mode is not `local`.
  ci:
    provider: github        # github | buildkite | other | none
    ref: .github/workflows/release.yml

  # How the crew waits for, and recognises, a release it did not perform.
  verify:
    # What `hooks.released` prints, so the crew knows what to compare it
    # against: `commit` (a sha, matched by prefix) or `version` (exact).
    match: commit
    # How long to keep asking before calling the release unconfirmed, and how
    # often. An unconfirmed release is NOT a failed one — the deploy may
    # simply be slower than the window — so it is reported, not treated as an
    # error to roll back.
    timeoutSeconds: 600
    intervalSeconds: 15

  # Every file the version is written into. The first is also read from.
  versionFiles: [package.json]
  # `false` for a repo that keeps no changelog — not every project does.
  changelog: CHANGELOG.md
```

## Field reference

| field | required | default | meaning |
| --- | --- | --- | --- |
| `version` | yes | — | Spec version this file targets. Currently `1`. |
| `platform` | no | `any` | `any` / `unix` / `macos` / `linux` / `windows` |
| `branch.base` | no | `main` | The integration branch — `master`, `develop`, a release train. Never assumed. |
| `branch.name` | no | `issue-{number}` | Local working branch. Must name at least one placeholder. |
| `branch.push` | no | `branch.name` | Name on the remote — useful to namespace crew branches in a PR list. |
| `branch.remote` | no | `origin` | Where a review branch is pushed. |
| `shell` | no | per platform | Interpreter for the hooks. |
| `hooks.test` | for building | — | Test suite. Non-zero blocks a release. |
| `hooks.build` | for building | — | Build. |
| `hooks.setup` | no | — | Run once in a fresh worktree, before anything else. |
| `hooks.deploy` | when `mode: local` | — | Ship it. |
| `hooks.ports` | no | — | Prints `KEY=value` lines assigning ports, so parallel worktrees do not collide. |
| `hooks.isolate` | no | — | Prints `KEY=value` lines pointing this worktree at state of its own — typically its own database. Receives `CREW_TICKET`, `CREW_BRANCH`. Without it, a session that changes a schema has nowhere to run migrations except the operator's own data. |
| `hooks.handoff` | no | — | Leaves the operator able to open what was built, and prints how. Receives `CREW_TICKET`, `CREW_BRANCH` and whatever `isolate` printed. Its output goes into the session's progress comment. |
| `worktrees.copy` | no | `[]` | Gitignored paths to copy from the main checkout into a new worktree, before `setup` runs. Repo-relative; absolute paths and `..` are rejected. A ship cannot supply or override this. |
| `docs.triagePolicy` | no | — | The triage seat's contract for this project — what its statuses mean, when a ticket may be accepted. Where it and a brief disagree, it wins. |
| `docs.designGuide` | no | — | This project's design brief, read by the design seat before it works a surface out. |
| `hooks.version` | no | reads `versionFiles[0]` | Prints the current version. |
| `hooks.bump` | no | rewrites `versionFiles` | Applies `CREW_BUMP` (`major`/`minor`/`patch`) and prints the new version. Replaces `versionFiles`. |
| `hooks.merged` | when a human merges | — | Did this ticket's work land? Exit 0 = yes. The only *definitive* closure signal; without it the crew guesses from commit subjects. |
| `hooks.released` | for `ci_*` | — | Prints what is live now, on one line. The only way the crew can observe a release it did not perform. |
| `labels.*` | no | the script | Readable names for log lines and filed tickets. |
| `release.mode` | no | `local` | `local` / `integrate` / `ci_manual` / `ci_auto` / `external` |
| `release.ci.provider` | when not `local` | `none` | `github` / `buildkite` / `other` / `none` |
| `release.ci.ref` | when not `local` | — | Workflow file or pipeline slug. |
| `release.versioning` | no | `auto` | `auto` or `none`. `none` means the crew never writes a version. |
| `release.verify.match` | no | `commit` | `commit` (prefix match) or `version` (exact). |
| `release.verify.timeoutSeconds` | no | `600` | How long to wait for `released` to match. |
| `release.verify.intervalSeconds` | no | `15` | How often to ask. |
| `release.versionFiles` | no | `[package.json]` | Files the version is written into, when there is no `bump` hook. The built-in handling is npm-shaped — it rewrites a `"version": "…"` field — so any project that is not npm should define `version` and `bump` instead. |
| `release.changelog` | no | `CHANGELOG.md` | `false` for a repo that keeps none. |

### `release.mode: integrate`

For a repository where **merging to the base branch IS the release** — a CLI, a
library, a tool an operator upgrades by pulling. The crew merges, versions,
writes the changelog and tags; it runs no deploy hook, expects no CI provider,
and does not verify a release it never performed. Declaring `hooks.deploy`
alongside it is an error rather than a silent no-op, because silently not
running a deploy hook would leave an operator believing it runs.

It exists against a specific temptation: declaring `local` with
`deploy: exit 0`. A hook that exits zero without shipping anything reports
success for something that did not happen, and the release then stamps its
tickets as deployed on the strength of it. The crew's own repository is the
first instance; before this mode existed it declared `external`, which meant
its verified branches were never merged and every ticket had to be closed by
hand.

### Why `isolate` and `handoff` are hooks

Both express a principle that is general and an implementation that is not.

*A headless session must not be able to destroy the operator's working state.*
Migrating a shared development database is not reversible by the agent that
ran it, and an agent asked to change a schema will do exactly that unless it
has somewhere else to go. Where a project keeps its state — a database, a
volume, a cloud namespace, nothing at all — is entirely the project's own
business, so it prints the answer rather than the crew assuming one.

*Leave the operator able to open what you built.* For a project with no
password-reset flow and no mail service on local dev, that means seeding a
login: a fresh database nobody has an account on can only be fixed by
re-provisioning it. For another project it means something else entirely. What
generalises is that the session must say, in its progress comment, how to get
in — so the hook prints that, and the crew carries it.

## Rules

- **Unknown keys are an error, not a warning.** A typo in a hook name would
  otherwise mean a suite that silently never runs, which is the worst
  possible failure for a test hook.
- **An absent `.crew.yaml` is not an error.** The crew falls back to whatever
  the ship's own `crew.yaml` declares for that repo, which is how a repo that
  has not adopted this file yet still gets worked.
- **Precedence is repo > ship > default, per field.** A repo can therefore
  adopt this spec one field at a time: declare `hooks.test` here and leave the
  rest to the ship, and only `test` moves. Where the ship declares something
  the repo also declares, the repo wins and the shadowed setting is
  *reported* by `crew doctor` rather than silently ignored — a hook that looks
  configured but never runs is exactly the failure this spec exists to avoid.
- **The merged result is validated, not just the file.** A repo with no
  `.crew.yaml` does not escape the consistency rules (a `local` release still
  needs a deploy hook) just because its settings arrived from the ship.
- **The repo is the source of truth for everything in this file.** Where the
  tracker's `Repos` row caches `platform` so that work can be dispatched
  without cloning first, `crew doctor` compares the two and reports drift; the
  file wins.
- `platform` and `shell` are separate on purpose: `linux` does not imply bash.
  But `shell` is a local execution detail and is deliberately **not** on the
  Ship record — see ISSUE-328.
- **`ci_manual` and `ci_auto` require `hooks.released`.** Without it the crew
  has no way to tell whether a release it triggered — or merely pushed to —
  ever landed, and would report success on the basis of having pushed. That is
  the failure this hook exists to prevent, so it is refused at load rather
  than discovered at release time.
- **Versioning is repo-specific too.** The built-in `versionFiles` handling
  reads and rewrites a JSON `"version"` field, which is an npm assumption
  wearing a general-sounding name. A repo that versions any other way — Cargo,
  pyproject, a VERSION file, git tags — defines `version` and `bump` and the
  crew stops guessing. Defining `bump` and `versionFiles` together is an
  error, not a merge: two mechanisms writing the version is how they drift.
- **Versioning is opt-out.** `release.versioning: none` is right for a repo
  that does not version, or whose version something else owns. Combining it
  with `bump` or `versionFiles` is refused rather than merged — that
  combination means someone changed their mind in one place only.
- **`bump` must print the version it produced**, and the crew uses what it
  printed rather than recomputing. A hook that bumps differently from the
  crew's arithmetic (a calendar version, a build counter, a pre-release
  suffix) is then correct by construction rather than a disagreement.
- **Closure is repo-specific too, and the fallback is a guess.** When work is
  merged on a forge rather than by the crew, the only durable trace in git is
  the ticket key in a commit subject — and a squash merge keeps that only if
  the person merging left the PR title alone. The crew will use it, and will
  label the conclusion `heuristic`; a heuristic answer should prompt a human
  rather than close a ticket, because silently mis-closing one is worse than
  not closing it. `hooks.merged` is how a repo replaces the guess with an
  answer.
- **Detecting the release is repo-specific, not runner-specific.** The bash
  runner this replaces hardcoded one project's `/api/health-check` and reached
  it through the *tracker's* base URL, which worked only because that project's
  app and tracker happen to share a host. Nothing about "what is live" belongs
  in the crew.
