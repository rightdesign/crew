/**
 * Neutral capability profiles (CREW-1511). Separate from `toolchain.ts` so an
 * adapter can import `profileFor` without an import cycle through the adapter
 * registry.
 */

import type { RoleName } from './config.ts';

/**
 * What a seat may do, independent of any vendor's tool names. Each adapter maps
 * it onto its own permission mechanism (§6).
 *
 * - `read`  — triage: read, run commands, call the tracker. No file-editing tools.
 * - `write` — QA: also writes throwaway files, but not the editing tool, so
 *   "bounce it back" is the path of least resistance rather than a rule.
 * - `edit`  — dev/pair: full editing.
 * - `designTools` — design only: skills and a design canvas on top of `edit`.
 */
export type CapabilityLevel = 'read' | 'write' | 'edit';
export interface CapabilityProfile {
  level: CapabilityLevel;
  designTools: boolean;
}

export function profileFor(role: RoleName): CapabilityProfile {
  if (role === 'triage') return { level: 'read', designTools: false };
  if (role === 'qa') return { level: 'write', designTools: false };
  return { level: 'edit', designTools: role === 'design' };
}
