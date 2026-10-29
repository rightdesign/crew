# Toolchains

A **toolchain** is the CLI crew launches for an agent session. Each one is a
named instance of a **harness adapter** — the code that knows how one vendor's
CLI is invoked, how it is granted tools, how the tracker MCP is registered with
it, and how its output stream is read. Three harnesses exist: `claude`, `codex` and `gemini`.

## Configuring

```yaml
ship:
  toolchain: claude          # the ship's default (omit for `claude`)
  toolchains:
    claude-wrapped:
      harness: claude
      bin: claude            # a bare name is found on PATH
      launcher: /opt/bin/run # optional: spawned instead, `bin` becomes its first argument
      model: claude-sonnet-5-5
      tiers:                 # light | standard | deep; harness defaults fill the gaps
        deep: { model: claude-opus-5-5, reasoning: high }
      args: []               # appended to the harness argv
      env: {}                # added to the session environment
routes:
  - route: ws/proj
    toolchain: claude-wrapped   # per-route override
    repos:
      sandbox-project:
        dir: /Users/me/src/sandbox-project
        toolchain: codex        # per-repo override (CREW-1529)
      crew: /Users/me/src/crew  # no override: the route's toolchain
```

A repo's `toolchain:` applies to any run that selected a ticket in that repo and
outranks the route's and the ship's default. Precedence: repo, then route, then
`ship.toolchain`, then `claude`. A persona `vendor` still re-targets on top of
whichever base won. Runs with no ticket (triage, nothing to pick) have no repo
and use the route/ship base. The key lives in your `crew.yaml`, never the repo's
own `.crew.yaml`: the vendor is an operator/billing decision, not a property of
the code. `crew run --dry-run` shows the reason (`repo <name> toolchain <x>`),
`crew status --json` reports `route.repos[].toolchain`, and `crew doctor` lists
each repo override.

The legacy `ship.agent: {bin, model, maxThinkingTokens}` block still works and
defines an implicit toolchain named `claude`. A `toolchains:` entry named
`claude` replaces it. Unknown toolchain names, harnesses and tiers fail at load
time (a bad route override drops only that route, with a warning).

### Forcing the subscription login (`auth`)

Crew unsets the billing variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_VERTEX_REGION`,
`CLOUD_ML_REGION` and `ANTHROPIC_MODEL`) in a run's shell environment. It cannot reach the `env` block that
the Vertex onboarding wizard writes into `~/.claude/settings.json`, which Claude
Code applies itself. On a machine where your interactive Claude Code bills a
corporate Vertex account but crew's runs should use your personal subscription,
opt in per toolchain:

```yaml
ship:
  toolchains:
    claude:
      harness: claude
      auth: subscription     # inherit (default) | subscription
```

With `subscription`, every launch passes `--settings` with an `env` block that
sets each billing variable to the empty string; `--settings` ranks above user,
project and local settings, so the override wins. `inherit` changes nothing.
`crew doctor` prints the resolved auth per Claude toolchain (`auth: claude:
subscription (settings override)`, or `inherit: vertex from
~/.claude/settings.json`), and a passing `crew selftest` repeats it. Only the
`claude` harness accepts `auth`.

### Running on Vertex or an API key

The strip above is deliberate, so a Vertex-billed or API-key-billed machine has
to opt back in: variables under a toolchain's `env:` are merged after the strip
and reach every run and `crew selftest`.

```yaml
ship:
  toolchains:
    claude:
      harness: claude
      bin: /opt/homebrew/bin/claude
      env:
        CLAUDE_CODE_USE_VERTEX: "1"
        CLOUD_ML_REGION: us-east5
        ANTHROPIC_VERTEX_PROJECT_ID: my-gcp-project
```

Leave `auth` absent or `inherit`; `subscription` blanks these variables again.
A `ship.toolchains.claude` entry replaces the implicit `ship.agent` block, so
carry `bin` over. `model` and `tiers` may need the model ids your Vertex project
exposes. Credentials must be findable without your shell; see
[What the scheduler sees](#what-the-scheduler-sees).

### What the scheduler sees

The launchd job (and the systemd unit) carries only `PATH`. Nothing exported in
a shell profile reaches a scheduled run, stripped or not, so credentials must be
found without the shell. For Vertex that means `gcloud auth application-default
login` (the default credentials file needs no variable) or
`GOOGLE_APPLICATION_CREDENTIALS` under `env:`. The same applies to
`OPENAI_API_KEY` for Codex: set it under `env:`, not in a profile.

## Codex

```yaml
ship:
  toolchains:
    codex:
      harness: codex
      bin: codex             # the Codex CLI, logged in with `codex login`
      model: gpt-5.5         # defaults: gpt-5.4-mini (light), gpt-5.5 (standard, deep)
      tiers:
        deep: { model: gpt-5.5, reasoning: high }   # minimal | low | medium | high
      args: []               # appended to `codex exec`
      env: {}
```

A run is `codex exec --json --sandbox <mode> -`, prompt on stdin, with approvals
off (a headless run cannot answer a prompt). `read` (triage) maps to the
`read-only` sandbox. `write` and `edit` run with `danger-full-access`, not
`workspace-write`: that mode keeps every `.git` directory read-only (the
checkout's own included, whatever `writable_roots` or `--add-dir` add), so a
sandboxed seat could neither cut its worktree nor commit, and the escalation
Codex would ask for is auto-rejected under `approval_policy="never"`. `crew
doctor` lists this in the capability matrix; the lane guard and persona are the
backstop, as they are for the Claude adapter's unsandboxed Bash. The tracker MCP is passed per run as `-c
mcp_servers.tablation.*` overrides (`url`, `bearer_token_env_var`, and
`default_tools_approval_mode="approve"`, without which Codex auto-rejects every
MCP call under `approval_policy="never"`), with the key named by `CREW_API_KEY`,
never written. `OPENAI_API_KEY`-style variables are removed from the inherited
environment so the run bills the operator's Codex login; set them under `env:` to
opt in (the scheduler passes only `PATH`; see
[What the scheduler sees](#what-the-scheduler-sees)). Cost is not reported, only tokens.

For a local OpenAI-compatible endpoint, define a
provider in `~/.codex/config.toml` (`[model_providers.local]`, `base_url`,
`wire_api`) and select it with `args: ["-c", "model_provider=\"local\""]` and
the matching `model`; because the args select a non-default `model_provider`,
`provider` is recorded as `local` (it stays `openai` otherwise).

## Gemini CLI

```yaml
ship:
  toolchains:
    gemini:
      harness: gemini
      bin: gemini
      model: gemini-2.5-pro     # tiers default to flash (light) / pro (standard, deep)
```

Runs `gemini -p '' --model <model> --output-format stream-json` (the prompt goes on stdin; `-p ''` only selects non-interactive mode), billed as
`provider: google`. Run `crew connect` first: Gemini has no per-run MCP flag, so
the tracker server is read from `~/.gemini/settings.json` (the same
`mcpServers.tablation` entry `ship.pair: [gemini]` writes, key by `$CREW_API_KEY`
only). Capabilities map to `--approval-mode` / `--allowed-tools`; `crew doctor`
prints what that cannot enforce (no deny list, unrestricted shell, no design
tools, no thinking blocks, no cost or turn count). Gemini billing variables
(`GEMINI_API_KEY`, `GOOGLE_API_KEY`, Vertex settings) are unset at exec so the
operator's Google login is what pays. A tier's `reasoning` is ignored.

The stream mapping was written from Gemini CLI's documented schema; the fixture
is hand-built, not recorded. One real headless run is still owed.

## Running a harness through OpenRouter's Ori

`launcher: ori` runs the harness behind OpenRouter's Ori (`ori claude …`), which
serves the harness against OpenRouter's catalog. Ori is a launcher, not a
harness: the harness's own flags pass through unchanged and `bin` names the
harness as Ori expects it.

```yaml
ship:
  toolchains:
    claude-ori:
      harness: claude
      bin: claude                  # becomes `ori claude -p …`
      launcher: ori
      launcherBin: /opt/homebrew/bin/ori   # optional: Ori is not on the scheduler PATH
      model: anthropic/claude-sonnet-5-5   # OpenRouter catalog id, passed to --model as is
      tiers:
        deep: { model: anthropic/claude-opus-5-5 }
```

- Models are OpenRouter `vendor/model` ids; a persona's explicit `model` is
  accepted as-is behind Ori.
- A run records `provider: openrouter` with the harness (`claude`) and the
  catalog model id. Cost is null unless the harness reports it.
- `crew doctor` checks the Ori binary (`launcherBin`, else `launcher`) against the
  scheduler PATH and prints a caveat line: Ori signs in with an interactive OAuth
  login, and **whether that login is visible to a launchd/systemd job is not yet
  verified**. Run `ori login` as the user the scheduler runs as, then confirm one
  headless run lands in the Agent Log with `provider: openrouter`. If it cannot
  authenticate headlessly, treat Ori as interactive-only. Ori has only been
  exercised in front of the `claude` harness.

## Running a harness against a local oMLX server

`launcher: omlx` runs the harness against oMLX, an
MLX inference server on Apple Silicon, with `omlx launch <harness> --model <model> -- <harness args>`.
Everything after `--` reaches the harness unchanged; `--model` is required because
oMLX would otherwise prompt.

```yaml
ship:
  toolchains:
    local-qwen:
      harness: claude
      launcher: omlx
      launcherBin: /Users/you/.omlx/bin/omlx   # optional: defaults to ~/.omlx/bin/omlx
      model: Qwen3.8-27B-4bit
routes:
  - route: issues/issues
    repos:
      some-repo:
        dir: /Users/you/git/some-repo
        toolchain: local-qwen   # per-repo override: only this repo's tickets run locally
```

- The vendor and the recorded `provider` are `local`; a persona's explicit
  `model` is accepted as-is, and tier maps pass local model ids through.
- The API key lives in oMLX's own settings, never in `crew.yaml`; oMLX hands it to
  the harness itself.
- Crew passes its own `--disallowedTools` to Claude, so oMLX's default `LSP` deny
  would not apply; crew appends `LSP` to the list under this launcher.
- **Codex: do not use this launcher.** `omlx launch codex` rewrites
  `~/.codex/config.toml` (a persistent `model_provider = "omlx"`), which would
  redirect every Codex run on the ship. Use the per-run provider override above.
- `crew doctor` checks the oMLX binary, reads `server.host`/`server.port` and
  `model.model_dirs` from `~/.omlx/settings.json` (nothing under `auth`), probes
  `GET /v1/models` with no key (a 401 is reported as "up, key required") and
  checks the model is present in a model directory.
- Scope the local toolchain with the per-repo override (as above), or a
  route-level `toolchain:` when a whole project should go local, rather than
  making it the ship default: local models vary in tool-call reliability and
  prefill speed.

## Seat resolution: persona vendor, tier and model

A seat's Agents row can carry `vendor`, `tier` and `model` (all optional; a
workspace that predates the columns reads as `standard` / inherit). They choose
the toolchain and the concrete model for that seat's runs:

1. **Toolchain**: the route's `toolchain`, else the ship default. If the persona
   names a `vendor` the default does not serve, the first ship toolchain whose
   vendor matches is used instead. If none matches, the default runs anyway and
   a `warn` event (`step: agent`) names the seat, the vendor and the toolchain
   used. A toolchain's vendor is `openrouter` when its `launcher` is `ori`, `local`
   when it is `omlx`, else its harness's own (`anthropic` for `claude`).
2. **Model**, inside that toolchain: the persona's explicit `model` when it
   belongs to the toolchain's vendor (a mismatch is ignored with a `warn` event,
   never passed through); else the persona's `light` / `deep` tier through the
   toolchain's `tiers:` map; else the toolchain's own `model`, which is its
   `standard` entry. A persona with nothing set, or `standard`, therefore runs
   exactly what the ship configured.
3. **Reasoning**: a tier entry's `reasoning` is the harness's knob. For Claude it
   is the extended-thinking budget and supersedes `maxThinkingTokens` for that
   run. Defaults: `light` 2048, `deep` 16384; override them per entry under
   `tiers:`. For Codex it is the reasoning effort (`minimal`, `low`, `medium`, `high`).

`crew run --dry-run` prints the chain (`resolved: toolchain ← why; model ← why`)
and any warnings. `crew doctor` lists every seat whose persona vendor has no
toolchain on this ship.

## Capability profiles

Seats are granted neutral profiles; each adapter maps them onto its own
permission mechanism.

| profile | seats | meaning |
| --- | --- | --- |
| `read` | triage | read, run commands, call the tracker; no editing tools |
| `write` | QA | also writes throwaway files, but no editing tool |
| `edit` | dev, pair | full editing |
| `edit` + design tools | design | adds skills and the design canvas |

Each adapter also declares what it **cannot** enforce; `crew doctor` prints that
for every configured toolchain, next to its binary check and MCP registration.

## Where it shows up

- `crew run --dry-run` prints a `toolchain:` line when a run does not use the
  default `claude` toolchain.
- `crew status --json` carries `ship.toolchain`, `ship.toolchains[]`
  (name, harness, bin, launcher, model) and `route.toolchain`; `ship.agent`
  stays for older crew-macos builds.
- `crew connect` registers the tracker MCP server in each configured
  toolchain's user-level config.
- `ship.pair` lists the harnesses Pair is installed for (`claude`, `codex`,
  `gemini`, `copilot`); `crew connect` / `crew doctor` / `crew disconnect` act on each. See
  GETTING_STARTED §2.7.

## Run identity

Every run records which toolchain, harness and provider produced it, beside `model`:

- the `.meta.json` sidecar and the `agent run finished` event carry `toolchain` (the `crew.yaml` entry name), `harness` and `provider`;
- the Agent Log row carries `harness` and `provider` (not `toolchain`, which is a local config name). A server that predates these fields rejects them with a 400; crew then retries the row without them, so reporting never fails the run;
- `provider` is who serves and bills the model (`anthropic` for the Claude adapter); an adapter defines it via `provider(spec)`;
- `crew logbook list` / `show` print harness and provider beside the model.

Cost is recorded only when the harness reports one (null otherwise; crew carries no price tables), and cache-write tokens only where the harness's usage schema has them (Anthropic's).
