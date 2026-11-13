Set this repository up to be worked by Crew. The result is one file at the repository root, `.crew.yaml`, that you write, test and leave uncommitted for me to review.

## What you are configuring

Crew is a runtime that works tickets from a tracker with headless coding agents. For each ticket it cuts a fresh git worktree beside the checkout, runs an agent in it with nobody watching, has a second agent verify the branch, and then releases it. Several worktrees of the same repository are often live on one machine at once.

Crew knows nothing about this repository except what `.crew.yaml` says. The file names the commands ("hooks") that install, test, build, version and release the project, and a few facts about branches and releases. Crew never parses a hook: it hands the text to a shell at the repository root and reads the exit status, and for some hooks the output.

That makes three things matter more than they would in a README:

- A hook must work in a **fresh worktree**, where nothing gitignored exists yet: no installed dependencies, no `.env`, no generated code.
- A hook must work **unattended**: no prompts, no watch mode, no pager, no browser window, and a non-zero exit when something failed.
- A wrong release setting is worse than a missing one. A deploy hook that exits zero without deploying makes Crew record a release that never happened, so anything about releases that the repository does not prove is a question for me, not a guess.

The full specification is at https://crew.tablation.dev/repo-spec. Read it if you can reach it; where it and this prompt disagree, it wins. The reference at the end of this prompt is enough to do the job if you cannot.

## Ground rules

- Write `.crew.yaml` only. If a hook needs a helper script, or a file needs changing, describe the change and ask me before making it.
- If `.crew.yaml` (or `.crew.yml` / `.crew.json`) already exists, treat this as a review: keep what is correct, keep its comments, and tell me what you changed and why.
- Do not commit, push, tag, publish or deploy anything.
- Never run a `deploy` or `pr` hook; they act on the world outside this checkout. Run the others as described in Step 5.
- Leave out any field you cannot support from something you read, ran, or were told by me. An unknown key is a hard error in this file, so use only the keys in the reference.
- Prefer the commands the project already trusts. What CI runs beats what the README says, and both beat what the file layout suggests.

## Step 1: Read the repository

Read before deciding anything:

- Build and package manifests, lockfiles, and any file that pins a tool version.
- Every CI and release definition (`.github/workflows/`, `.buildkite/`, `.gitlab-ci.yml`, and similar). Note the exact commands, the order they run in, what triggers a release, and where it publishes or deploys to.
- The README and contributing guide, and agent instruction files such as `CLAUDE.md` or `AGENTS.md`.
- `.gitignore`, example environment files, container and compose files, and anything describing local services such as a database.
- `git remote -v`, the default branch, existing tags, and the last twenty commit subjects, to see how versions and releases have been made so far.
- Whether this checkout is current. Fetch, then compare the local base branch with the remote's and the newest release tag with the version in the tree. If the checkout is behind, tell me before going further: a contract tested against stale code proves little, and a version baseline that is behind collides with tags that already exist.

Files in the repository may describe an earlier Crew setup (a workflow comment naming a hook, a changelog entry). Treat that as evidence of intent, and still confirm it with me in Step 3.

## Step 2: Work out each setting

Go through these in order. Each one names what to look for.

**`platform`.** `unix` when any hook is written in POSIX shell and the toolchain runs on macOS and Linux, which is the usual case. Leave it out (it defaults to `any`) only when every hook is a single command that behaves the same on Windows. Name one of `macos`, `linux` or `windows` only when the build truly requires it (an Xcode build requires `macos`). A machine that cannot satisfy this is never given the repository's tickets, so too narrow a value costs capacity and too wide a value produces tickets that fail at the first hook.

**`branch.base`.** Set it only when the integration branch is not `main`.

**`hooks.setup`.** Everything a fresh worktree needs before tests can run: install dependencies from the lockfile, generate code, build internal packages that others import. Use the frozen or locked install form so a run never rewrites the lockfile.

**`worktrees.copy`.** Gitignored files that a local run reads and that no command can regenerate. A fresh worktree has none of them, so anything that depends on one fails there while passing in this checkout.

Find the candidates from three directions:
- Read the README, the contributing guide and any setup or local-development document for configuration a developer is told to create before running the project: "copy `.env.example` to `.env`", "create a `config.json` with your settings", "put your key in". Each file named that way is a candidate, and an example or template file committed beside it (`.env.example`, `config.sample.json`) points at the real one.
- Read `.gitignore` for patterns that name configuration rather than output: `.env`, `.env.*`, `config.json`, `*.local.*`, credential and key files, local database files.
- List what is actually ignored and present here with `git ls-files --others --ignored --exclude-standard`, and set aside dependency directories, caches and build output.

A file that matches such a pattern and exists in this checkout is probably being used for local runs, so include it unless you can show that nothing reads it. Check by searching the code, scripts and manifests for where it is loaded. List each file by its exact repository-relative path, including ones in subdirectories; the list takes paths, not patterns. Name these files in comments and in your report, but never quote their contents, since they often hold secrets.

When the documentation calls for a file, or `.gitignore` has such a pattern and the code clearly reads a matching file, and none exists here, raise it in Step 3: I may keep it somewhere else or have never created it. A documented file that is not gitignored is also worth raising, because it is either committed, and needs no copying, or about to be committed by accident.

**`hooks.test`.** The whole gate CI applies before a merge: lint, type check and test suites, in one script. When there are several steps, run them all and exit non-zero if any failed, so one run reports every problem:

```yaml
test: |
  ok=0
  <lint command> || ok=1
  <unit test command> || ok=1
  exit "$ok"
```

Use the non-interactive form of each command. Leave out suites that need credentials or services a headless run will not have, and say so in a comment.

**`hooks.build`.** The command that proves the project compiles or bundles. If the project has no build step, use the cheapest real check there is (a type check or a syntax check), never a command that cannot fail.

**Version.** Find where the version lives.
- Only in the `version` field of one or more JSON files such as `package.json`: set `release.versionFiles` to those files and write no version hooks.
- Anywhere else, or in more than one kind of place (Cargo, pyproject, a plist, a plain VERSION file, git tags, or a manifest plus a lockfile that records the same version): write `hooks.version` (prints the current version on one line) and `hooks.bump` (reads `CREW_BUMP`, which is `major`, `minor` or `patch`, writes the new version everywhere it lives, and prints it on one line). Prefer the package manager's own version command, told not to commit or tag, because it keeps a lockfile in step. Do not also set `versionFiles`.
- No version anywhere, or a version another tool owns: `release.versioning: none`.

Crew writes `CHANGELOG.md` by default. Set `release.changelog: false` when the repository keeps no changelog, and give the path when it keeps one under another name.

**Parallel worktrees.** Decide whether two worktrees running at once would collide.
- If anything listens on a fixed port (dev server, API, test server), a `hooks.ports` script should print `KEY=value` lines assigning ports that differ per worktree, usually derived from the worktree's directory name. The project's servers must read those variables.
- If tests or the dev server use a database or other shared state, a `hooks.isolate` script should print `KEY=value` overrides pointing this worktree at state of its own (it receives `CREW_TICKET` and `CREW_BRANCH`). Without it, an agent changing a schema migrates whatever database the local environment file points at, which is usually the developer's own.

Both usually need a small script in the repository and sometimes a change to how ports are read. Propose them; do not write them without my agreement. If nothing listens and nothing is shared, omit both.

**`hooks.preview`.** For anything a person would look at in a browser. It starts a server detached so it outlives the hook, bound to `${CREW_PREVIEW_HOST:-localhost}`, and prints the URL as its last line of output. A project with a dev server uses it, on the port from `ports`. A static site needs no script: serve the built directory with a file server the machine already has, on a port computed from the ticket number so worktrees do not collide:

```yaml
preview: |
  port=$((30000 + ${CREW_TICKET##*-}))
  nohup <static file server> "$port" >/dev/null 2>&1 &
  echo "http://${CREW_PREVIEW_HOST:-localhost}:$port"
```

**`hooks.handoff`.** Only when someone opening a freshly built worktree would be locked out without it, for example an app that needs a seeded login. It makes that possible and prints how to get in.

**`hooks.map`.** If the repository already has a short document describing its layout, set this to that file's relative path (it must end in `.md`). Do not write one for this task.

**Forge hooks.** When the remote is on GitHub and the `gh` CLI is what the project uses:
- `hooks.ci_status` (exit 0 when CI is green for `$CREW_BRANCH`) is worth adding when CI runs on pushed branches.
- `hooks.merged` and `hooks.pr` belong to the `external` release mode below.

## Step 3: Ask me what the repository cannot tell you

Ask once, in a single message, with your best reading of the evidence beside each question so that confirming it takes me a word. Always ask the release question, even when the evidence looks conclusive; ask the others only where the answer is not already clear. If a clean install for Step 5 will be slow or large, say so here too.

1. **How does a change reach users after it merges?** Offer the mode you believe applies and what you saw that suggests it:
   - `integrate`: merging to the base branch is the release. Crew merges, versions, writes the changelog and tags. Right for a library or tool with nothing to deploy.
   - `ci_auto`: pushing the base branch or a tag makes CI publish or deploy. Crew merges, versions, tags and pushes, then watches. Needs `hooks.released`.
   - `ci_manual`: Crew triggers CI and waits for it. Needs `hooks.released`.
   - `local`: Crew runs a deploy command itself after merging and pushing, and the command's exit status is the result. Needs `hooks.deploy`. Right when a person ships by running a command today, including one that dispatches a pipeline and waits for it.
   - `external`: Crew does not merge at all. A person or another tool merges pull requests. Needs `hooks.merged`; `hooks.pr` opens the pull request.
   For `local`, also confirm the exact command I run to ship.
2. **What single command prints what is live right now**, as a version or a commit sha? A registry query and a health endpoint are the usual answers. The `ci_*` modes cannot work without it, so ask whenever one of them is likely; for the other modes it is optional and not worth a question. It becomes `hooks.released`, with `release.verify.match` set to `version` or `commit` to match, and `release.verify.timeoutSeconds` sized to how long the release pipeline takes.
3. **Should Crew set versions**, if the evidence was mixed? If a lockfile or second file records the version, confirm it has to stay in step.
4. Anything from Step 2 you proposed and need agreement on: a ports or isolate script, a preview, the gitignored files to copy into worktrees (list them by name so I can strike any that should not travel), a narrower `platform`.
6. **Code navigation.** `hooks.intel` gives agents symbol lookup. Offer `typescript-lsp` for a TypeScript or JavaScript project (it uses `typescript-language-server` from the project's own dev dependencies, or from the machine's PATH when the project does not have it) or `serena` for other languages (needs a one-time install on each machine). Leave it out unless I say yes.

Wait for my answers before writing the file. If I tell you to go ahead without them, write only what the repository proves. For the release, use `integrate` when nothing in the repository publishes or deploys; otherwise leave the `release` section out and say in your report that the file is not ready to release from.

## Step 4: Write `.crew.yaml`

Start with `version: 1`. Order the file `platform`, `branch`, `worktrees`, `hooks`, `labels`, `release`. Always write `release.mode`, even when it is the default, because it is the setting a reader most needs to see. Leave other settings out when the default is what you want. Above every choice that is not obvious, write a short comment saying what justified it, such as the workflow file that publishes on a tag, or the reason a test suite is left out. Someone should be able to audit the file without redoing your investigation. Put the specification URL in a comment on the first line.

Use a YAML block scalar (`|`) for any hook longer than one command. Add a `labels` entry for a hook whose script is more than one line, so logs show a readable name.

## Step 5: Prove the hooks work

Test them the way Crew will run them, in a clean worktree, not in this checkout where dependencies are already installed:

1. Cut a scratch worktree from the current commit in a temporary directory outside the repository.
2. Copy in the files listed under `worktrees.copy`.
3. From the worktree root, run each hook you wrote with `bash -c` (or the `shell` you set), in this order: `setup`, then `ports` and `isolate` (export what they print), then `test`, `build` and `version`. Run `released` and `ci_status` too; they only read.
4. Run `bump` last, with `CREW_BUMP=patch`. Check that it printed the new version and nothing else, that `version` now prints the same, and that `git status` shows every file that records the version changed. The worktree is about to be discarded, so this costs nothing.
5. Remove the worktree and its branch when you are done, even if a hook failed.

Judge each hook by its exit status. When one fails, work out whether the hook is wrong (fix it and run again) or the project is broken at this commit (leave the hook, and report the failure with its output). Never weaken a hook to make it pass.

Note every program the hooks call and where your shell found it. Crew starts hooks from a background scheduler whose PATH is shorter than a terminal's, so a tool that a shell profile or a version manager adds is a common first-run failure.

## Step 6: Validate the file

If `crew` is on the PATH, run `crew repos check --strict` from the repository root and fix everything it reports until it exits 0. It executes nothing, so it does not replace Step 5.

If `crew` is not installed but Node 22 or newer is, `npx --yes @tablation/crew repos check --strict` runs the same check. Failing both, check by hand: the file parses as YAML, every key appears in the reference below, each hook passes the shell's syntax check (`bash -n`), and none of the combinations listed under "Combinations that are refused" is present.

## Step 7: Report

Finish with a short report:

- The file's settings in a few lines, and the release mode in one sentence of plain language.
- Each hook with how it fared: passed in a clean worktree, failed (with the reason), or not run (with the reason). `deploy` and `pr` are always in the last group; say which parts of them you could check by reading.
- The programs the hooks need on the machine's PATH, with the versions the repository pins, and any sign-in they need (a forge CLI, a registry).
- Anything you left out on purpose and what would be needed to add it.
- Changes outside `.crew.yaml` that you recommend but did not make.
- What I do next: review and commit the file, then attach the checkout to a route with `crew repos add`, or add the repository from the Crew app.

## Reference

Top-level keys: `version`, `platform`, `shell`, `branch`, `worktrees`, `docs`, `hooks`, `labels`, `release`, `sandbox`, `periscope`. Nothing else is accepted. The tables list the settings this task can need. The specification has the rest (branch and worktree naming, `shell`, `periscope`, `sandbox`, per-machine release settings); leave those unset unless I ask for them.

| Key | Values and meaning |
| --- | --- |
| `version` | Required. `1`. |
| `platform` | `any` (default), `unix`, `macos`, `linux`, `windows`. |
| `branch.base` | Integration branch. Default `main`. |
| `worktrees.copy` | List of gitignored, repository-relative paths copied from the main checkout into a new worktree before `setup`. Exact paths; absolute paths and `..` are refused. |
| `docs.triagePolicy`, `docs.designGuide` | Paths to a triage policy or design guide, if the repository has one. |
| `labels.<hook>` | Readable name for a hook, used in logs. |

Hooks (keys under `hooks`; no others are accepted):

| Hook | Contract |
| --- | --- |
| `setup` | Runs once in a fresh worktree before anything else. |
| `test` | The merge gate. Non-zero blocks a release. Needed for Crew to build the repository. |
| `build` | Build or compile check. Needed for Crew to build the repository. |
| `ports` | Prints `KEY=value` lines assigning this worktree's ports. |
| `isolate` | Prints `KEY=value` lines pointing this worktree at its own state. Gets `CREW_TICKET`, `CREW_BRANCH`. |
| `handoff` | Makes the built worktree usable by a person and prints how. Gets `CREW_TICKET`, `CREW_BRANCH`, and what `isolate` printed. |
| `preview` | Starts the dev server detached; last output line is its URL. Gets the `ports` output, `CREW_PREVIEW_HOST`, `CREW_TICKET`, `CREW_BRANCH`. |
| `intel` | `typescript-lsp`, `serena`, or a command that starts a symbol service and prints its URL. |
| `map` | A relative path ending in `.md`, or a command that prints an outline of the repository. |
| `ci_status` | Exit 0 when CI is green for the pushed branch. Gets `CREW_TICKET`, `CREW_BRANCH`. |
| `version` | Prints the current version on one line. |
| `bump` | Applies `CREW_BUMP` (`major`, `minor`, `patch`) and prints the new version on one line. |
| `deploy` | Ships the release. Only for `release.mode: local`. Runs in the release checkout after the version commit and tag are pushed to the base branch, with no extra variables. Its exit status is the release's result, so it must wait for the outcome and fail when the deployment fails. |
| `pr` | Opens a pull request and prints its URL or number. Gets `CREW_TICKET`, `CREW_BRANCH`, `CREW_BASE`, `CREW_TITLE`. |
| `merged` | Exit 0 when this ticket's branch has landed on the base branch. Gets `CREW_TICKET`, `CREW_BRANCH`, `CREW_BASE`. |
| `released` | Prints what is live now, a version or commit sha, on one line. Prints nothing when it does not know. |

Release (keys under `release`):

| Key | Values and meaning |
| --- | --- |
| `mode` | `local` (default), `integrate`, `ci_manual`, `ci_auto`, `external`. |
| `versioning` | `auto` (default) or `none`. |
| `versionFiles` | JSON files with a string `version` field that Crew rewrites. Default `[package.json]`. A plain-text file is refused. |
| `changelog` | Path of the changelog Crew writes. Default `CHANGELOG.md`. `false` for none. |
| `tag`, `tagPattern` | Tag template (default `v{version}`) and the glob that finds the last release tag (default `v*`). Set both if existing tags are named differently. `tag: false` for no tag. |
| `ci.provider`, `ci.ref` | `github`, `buildkite`, `other` or `none`, and the workflow file or pipeline. For `ci_*` modes. |
| `verify.match` | `commit` (default; `released` prints a sha) or `version`. |
| `verify.timeoutSeconds`, `verify.intervalSeconds` | How long to wait for `released` to match, and how often to ask. Defaults 600 and 15. |

### Combinations that are refused

- `ci_manual` or `ci_auto` without `hooks.released`, or without a `release.ci.provider`.
- `external` without `hooks.merged`.
- `integrate` together with `hooks.deploy`.
- `local` without `hooks.deploy` (reported as not ready to release).
- `hooks.bump` together with `release.versionFiles`.
- `release.versioning: none` together with `hooks.bump` or `release.versionFiles`.
- `ci_auto` together with a `deploy` hook that also ships, which releases twice.

### A deploy hook that dispatches a pipeline

A command that starts a pipeline usually returns before the run exists and does not say which run it started. A `deploy` hook built on one has to find the new run and wait for its result, or it reports success for a deployment nobody watched. With GitHub Actions and a workflow that has a `workflow_dispatch` trigger:

```yaml
deploy: |
  set -e
  wf=<workflow file>
  before="$(gh run list --workflow "$wf" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
  gh workflow run "$wf" --ref <base branch>
  run=""
  for _ in $(seq 1 30); do
    run="$(gh run list --workflow "$wf" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
    [ "$run" -gt "$before" ] && break
    run=""
    sleep 2
  done
  [ -n "$run" ] || { echo "deploy: the $wf run never appeared" >&2; exit 1; }
  gh run watch "$run" --exit-status
```

### A small complete example

```yaml
# Crew's contract for this repository: https://crew.tablation.dev/repo-spec
version: 1

# POSIX-shell hooks; nothing here is specific to one operating system.
platform: unix

worktrees:
  # The test suite reads its settings from this file, which is gitignored.
  copy: [.env.test]

hooks:
  setup: npm ci
  # The same three steps .github/workflows/ci.yml runs on every pull request.
  test: |
    ok=0
    npm run lint || ok=1
    npm run typecheck || ok=1
    npm test || ok=1
    exit "$ok"
  build: npm run build
  # What the registry serves, matched against the version just released.
  released: npm view example-package version

labels:
  test: lint, typecheck, unit tests

release:
  # .github/workflows/publish.yml publishes when a v* tag is pushed.
  mode: ci_auto
  ci: { provider: github, ref: .github/workflows/publish.yml }
  versionFiles: [package.json]
  changelog: CHANGELOG.md
  verify:
    match: version
    timeoutSeconds: 900
