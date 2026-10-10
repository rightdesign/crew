# Toolchains

A **toolchain** is the CLI crew launches for an agent session. Each one is a
named instance of a **harness adapter** — the code that knows how one vendor's
CLI is invoked, how it is granted tools, how the tracker MCP is registered with
it, and how its output stream is read. Only the `claude` harness exists today.

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
    toolchain: claude-wrapped   # per-route override; there is no per-repo key
```

The legacy `ship.agent: {bin, model, maxThinkingTokens}` block still works and
defines an implicit toolchain named `claude`. A `toolchains:` entry named
`claude` replaces it. Unknown toolchain names, harnesses and tiers fail at load
time (a bad route override drops only that route, with a warning).

## Seat resolution: persona vendor, tier and model

A seat's Agents row can carry `vendor`, `tier` and `model` (all optional; a
workspace that predates the columns reads as `standard` / inherit). They choose
the toolchain and the concrete model for that seat's runs:

1. **Toolchain**: the route's `toolchain`, else the ship default. If the persona
   names a `vendor` the default does not serve, the first ship toolchain whose
   vendor matches is used instead. If none matches, the default runs anyway and
   a `warn` event (`step: agent`) names the seat, the vendor and the toolchain
   used. A toolchain's vendor is `openrouter` when its `launcher` is `ori`, else
   its harness's own (`anthropic` for `claude`).
2. **Model**, inside that toolchain: the persona's explicit `model` when it
   belongs to the toolchain's vendor (a mismatch is ignored with a `warn` event,
   never passed through); else the persona's `light` / `deep` tier through the
   toolchain's `tiers:` map; else the toolchain's own `model`, which is its
   `standard` entry. A persona with nothing set, or `standard`, therefore runs
   exactly what the ship configured.
3. **Reasoning**: a tier entry's `reasoning` is the harness's knob. For Claude it
   is the extended-thinking budget and supersedes `maxThinkingTokens` for that
   run. Defaults: `light` 2048, `deep` 16384; override them per entry under
   `tiers:`.

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

## Run identity

Every run records which toolchain, harness and provider produced it, beside `model`:

- the `.meta.json` sidecar and the `agent run finished` event carry `toolchain` (the `crew.yaml` entry name), `harness` and `provider`;
- the Agent Log row carries `harness` and `provider` (not `toolchain`, which is a local config name). A server that predates these fields rejects them with a 400; crew then retries the row without them, so reporting never fails the run;
- `provider` is who serves and bills the model (`anthropic` for the Claude adapter); an adapter defines it via `provider(spec)`;
- `crew logbook list` / `show` print harness and provider beside the model.

Cost is recorded only when the harness reports one (null otherwise; crew carries no price tables), and cache-write tokens only where the harness's usage schema has them (Anthropic's).
