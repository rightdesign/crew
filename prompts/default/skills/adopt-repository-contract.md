---
name: Adopt Repository Contract
description: How the dev seat writes a repository's `.crew.yaml` from its checkout (hooks, release mode, sandbox section) and how QA verifies it by running the hooks and `crew repos check --strict`. Fetch when a ticket asks the crew to write or adopt a repository's contract.
---
# Adopting a repository: writing its `.crew.yaml`

A repository added from the app arrives with a setup ticket asking the crew to
write its contract: a `.crew.yaml` at the checkout root. The file is the only
thing that knows how this repository tests, builds and releases, so write it
from what the checkout shows, never from habit. The repo spec that ships with crew is the field
reference (`crew repos check` prints what it parsed); this skill is the procedure.

## Dev: write the file

1. **Read the checkout first.** Package manifests (`package.json`,
   `Package.swift`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`), the
   README's build and test section, and every CI workflow
   (`.github/workflows/`, `.buildkite/`, and the like). Note which commands CI
   runs: those are the hooks, because they are what the maintainers already trust.
2. **Ask the tool for a baseline.** Run `crew repos hooks --json` against the
   checkout (the file-sniff proposal plus detected `recipes`), and `crew repos
   hooks --agent` where the harness allows it (it needs a signed-in toolchain; a
   `reason` such as `not_signed_in` or `unsupported_harness` is not a failure of
   the ticket, so carry on from the sniff and say so). Treat both as a draft:
   where the sniff and CI disagree, CI wins. Never use `--write` on a route for
   this ticket; the contract belongs in the repository, committed on the branch.
3. **Choose `release.mode` from what the repository shows.**
   - A release workflow (a tag or merge triggers CI that publishes or deploys):
     `release.mode: ci_auto`, with a `hooks.released` that prints what is live
     (a commit sha or version) and `release.verify.match` to suit. Do not also
     write a `deploy` hook, or the release happens twice.
   - Otherwise: `release.mode: integrate` (the crew merges and tags, nothing is deployed).
   - Do not pick `local` unless the repository has a deploy script a person runs
     today, and then `hooks.deploy` is required. Do not pick `external` or
     `ci_manual` without evidence in the checkout.
   - If `ci_auto` is the right mode but `released` cannot be derived from the
     checkout (no health endpoint, no registry name), that is a question for the
     operator, not a guess (see "Nothing to detect").
4. **Versioning.** If the repository keeps a version, point `version`/`bump` or
   `release.versionFiles` at where it lives. If it keeps none, set
   `release.versioning: none`. If it keeps no changelog, `release.changelog: false`.
5. **Add a `sandbox:` section only when needed.** The base sandbox image has git,
   curl and the agent toolchain. If the hooks need a runtime or system package
   beyond that (a language toolchain, a database client, a compiler), declare it
   under `sandbox.packages` (apt names), allow run-time downloads the tests
   really make through `sandbox.toolchains`/`sandbox.hosts`, and keep baked
   steps in `sandbox.setup`. A repository whose hooks need nothing extra gets no
   `sandbox:` section.
6. **Run every hook once before committing**, from the checkout (or the ticket's
   worktree), in the order `setup`, `test`, `build`, then any `ports`,
   `isolate`, `version` that you wrote. Judge by exit code. A hook that fails
   because the repository itself is broken is not yours to fix on this ticket:
   record it in the file's comment and file it as its own ticket. A hook you
   could not run (a tool missing on this machine) is stated in your comment, not
   assumed to work.
7. **Write the file with comments.** Each non-obvious choice gets a one-line
   comment saying what in the checkout justified it ("mode is ci_auto: .github/workflows/release.yml
   publishes on tag"). A reader should be able to audit the file without
   re-deriving it.
8. **Check it.** Run `crew repos check --strict` from the checkout and fix
   everything it prints until it exits 0. Quote the summary in your hand-off.
9. Commit only `.crew.yaml` (and anything the ticket names). Hand off as usual.

## Nothing to detect

If the checkout has no manifest, no CI and no README guidance, so that the test
or build command would be a guess, do not write one. Stop per the lane's
person-stop rule: `needs_info`, assigned to the operator, with the **specific**
question ("What command runs this repository's tests?", "Does a push to main
deploy it, and how do I see what is live?"). A partial file is fine only when
the missing part is optional.

## QA: verify the file

1. Cut the branch's worktree and run `crew repos check --strict` on it: exit 0.
2. Run the hooks the file declares, verbatim: `setup`, then `test` and `build`.
   Where the repository declares a `sandbox:` section, run them in the sandbox
   when the ship supports it. A hook that was only syntax-checked has not been verified.
3. Confirm the choices match the repository: the `release.mode` against the
   workflows actually present, a `released` hook for any `ci_*` mode, no
   `deploy` hook alongside `ci_auto`, no `sandbox:` section with nothing in it.
4. Bounce with the failing hook's output quoted. Do not edit the file yourself.
