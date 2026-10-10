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
