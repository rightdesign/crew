/**
 * The harness-neutral seam between crew and whatever CLI actually runs an agent
 * session (CREW-1511, EPIC-035 §2/§3/§6/§7).
 *
 * A *toolchain* is a named, configured instance of a *harness adapter*: the
 * adapter knows how one vendor's CLI is invoked, how it is granted tools, how
 * the tracker MCP is registered with it, and how to read its output stream; the
 * toolchain entry (`toolchains:` in crew.yaml, or the implicit `claude` entry
 * the legacy `agent:` block defines) says which binary, model and extras to use.
 *
 * Everything that used to be Claude-shaped in `agent.ts`/`cli.ts` goes through
 * `HarnessAdapter` now. Only the `claude` adapter exists; adding a second
 * harness means writing another file under `adapters/` and registering it here.
 */

import type { Route, RoleName, Ship } from './config.ts';
import type { StreamKindEvent, StreamResult } from './stream.ts';
import { claudeAdapter } from './adapters/claude.ts';
import type { CapabilityProfile } from './capability.ts';

/** Model-size tiers a toolchain can map to concrete models (EPIC-035 §2). */
export const TIERS = ['light', 'standard', 'deep'] as const;
export type Tier = (typeof TIERS)[number];

export interface ToolchainTier {
  model: string;
  /** Harness-specific reasoning setting, passed through verbatim (e.g. a thinking budget). */
  reasoning?: string;
}

export { profileFor } from './capability.ts';
export type { CapabilityLevel, CapabilityProfile } from './capability.ts';

/** A toolchain as resolved from config: every field filled, nothing optional left to guess. */
export interface ToolchainSpec {
  name: string;
  harness: string;
  bin: string;
  /** A wrapper command: it is spawned, with `bin` as its first argument. */
  launcher?: string;
  model: string;
  tiers: Partial<Record<Tier, ToolchainTier>>;
  /** Extra argv appended after the adapter's own. */
  args: string[];
  /** Extra environment for the session. */
  env: Record<string, string>;
  /** Claude: extended-thinking budget; 0 disables. Other harnesses ignore it. */
  maxThinkingTokens: number;
}

export interface McpTarget {
  /** `<baseUrl>/api/mcp`. */
  url: string;
  /** The env var carrying the tracker key; the key itself is never in argv. */
  keyVar: string;
}

export interface McpRegistrationOpts {
  bin: string;
  url: string;
  key: string;
  home?: string;
}

export type McpRegistration =
  | { state: 'no-binary' }
  | { state: 'missing' }
  | { state: 'registered'; url: string }
  | { state: 'different'; detail: string };

export interface HarnessAdapter {
  harness: string;
  displayName: string;
  defaultBin: string;
  defaultModel: string;
  defaultTiers: Partial<Record<Tier, ToolchainTier>>;
  /**
   * What this harness cannot enforce or provide, one line each. `crew doctor`
   * prints them for every configured toolchain so an operator choosing a
   * toolchain knows what it does NOT guard against (§6).
   */
  limitations: string[];
  /** Headless argv for one run; prompt delivery is stdin for every harness. */
  invocation(spec: ToolchainSpec, o: { role: RoleName; model: string; mcp?: McpTarget }): { bin: string; args: string[] };
  /** Environment to add for a run (beyond the tracker key). */
  runEnv(spec: ToolchainSpec): Record<string, string>;
  /** Variables removed from the inherited environment before exec. */
  unsetEnv: string[];
  mapStreamLine(parsed: unknown): StreamKindEvent[];
  extractResult(parsed: unknown): StreamResult | undefined;
  extractTurnTokens(parsed: unknown): number | undefined;
  inspectMcp(o: McpRegistrationOpts): McpRegistration;
  /** Register (or report) the tracker MCP server; returns the one line to print. */
  ensureMcp(o: McpRegistrationOpts & { replace?: boolean; dryRun?: boolean }): string;
}

const ADAPTERS: Record<string, HarnessAdapter> = {
  [claudeAdapter.harness]: claudeAdapter,
};

export const HARNESS_NAMES = Object.keys(ADAPTERS);

export function isHarness(name: string): boolean {
  return Object.hasOwn(ADAPTERS, name);
}

export function adapterFor(harness: string): HarnessAdapter {
  const a = Object.hasOwn(ADAPTERS, harness) ? ADAPTERS[harness] : undefined;
  if (!a) throw new Error(`unknown harness "${harness}" (have: ${HARNESS_NAMES.join(', ')})`);
  return a;
}

/** The name of the entry the legacy `agent:` block defines. */
export const LEGACY_TOOLCHAIN = 'claude';

/**
 * Every toolchain a ship has: the explicit `toolchains:` map, plus the implicit
 * `claude` entry from the legacy `agent:` block unless the map names its own
 * `claude`. Hand-built `Ship`s in tests carry only `agent`, which still works.
 */
export function shipToolchains(ship: Ship): ToolchainSpec[] {
  const explicit = ship.toolchains ?? [];
  if (explicit.some((t) => t.name === LEGACY_TOOLCHAIN)) return explicit;
  const a = claudeAdapter;
  const legacy: ToolchainSpec = {
    name: LEGACY_TOOLCHAIN,
    harness: a.harness,
    bin: ship.agent.bin,
    model: ship.agent.model,
    tiers: a.defaultTiers,
    args: [],
    env: {},
    maxThinkingTokens: ship.agent.maxThinkingTokens,
  };
  return [legacy, ...explicit];
}

/** The ship's default toolchain, unless the route overrides it. */
export function resolveToolchain(ship: Ship, route?: Pick<Route, 'toolchain'>): ToolchainSpec {
  const name = route?.toolchain ?? ship.toolchain ?? LEGACY_TOOLCHAIN;
  const found = shipToolchains(ship).find((t) => t.name === name);
  if (!found) throw new Error(`toolchain "${name}" is not defined (have: ${shipToolchains(ship).map((t) => t.name).join(', ')})`);
  return found;
}
