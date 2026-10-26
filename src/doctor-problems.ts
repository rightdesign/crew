import type { ShipAttentionItem } from './ship-attention.ts';
import { hookCommand } from './ship-attention.ts';

/**
 * The structured form of what `crew doctor` finds (CREW-2542), for
 * `crew doctor --json`. Built from the same inputs the text report prints
 * (the same `doctorBaseReport` result, the same `validateEffective` notes,
 * the same hook scan), so the two cannot disagree.
 *
 * - `blocker`: what makes doctor exit non-zero, i.e. stops `--fix` enabling the route.
 * - `attention`: open ship-attention items, `hook_missing` included.
 * - `note`: release-readiness advice; never changes the exit status.
 */
export interface DoctorProblem {
  severity: 'blocker' | 'attention' | 'note';
  /** Stable slug: `repo_missing_checkout`, `base_unsafe`, `release_note`, `hook_missing`, or a ship-attention kind. */
  kind: string;
  route?: string;
  repo?: string;
  /** crew's full text for the finding, unwrapped and untruncated. */
  message: string;
  remedy?: string;
  /** `hook_missing` only: which hook, and the binary it runs. */
  hook?: 'setup' | 'test' | 'build' | 'deploy';
  command?: string;
}

export interface DoctorFindings {
  problems: DoctorProblem[];
  /** Checks that raised nothing. */
  passed: number;
}

const HOOK_NAMES = ['setup', 'test', 'build', 'deploy'] as const;

/** Findings for one repository: its checkout, release-readiness notes, base branch and hook commands. */
export function repoFindings(o: {
  route: string;
  repo: string;
  dir: string;
  notes: string[];
  base: { message: string; failed: boolean; skipRest: boolean };
  hooks: Partial<Record<(typeof HOOK_NAMES)[number], string | undefined>>;
  onPath: (command: string) => boolean;
}): DoctorFindings {
  const problems: DoctorProblem[] = [];
  let passed = 0;
  const at = { route: o.route, repo: o.repo };
  for (const n of o.notes) problems.push({ severity: 'note', kind: 'release_note', ...at, message: n });
  if (o.notes.length === 0) passed++;
  if (o.base.skipRest) {
    problems.push({
      severity: 'blocker', kind: 'repo_missing_checkout', ...at, message: `${o.repo}: ${o.base.message}`,
      remedy: `clone ${o.repo} to ${o.dir}, or correct its path in crew.yaml`,
    });
    return { problems, passed };
  }
  passed++;
  if (o.base.failed) {
    problems.push({ severity: 'blocker', kind: 'base_unsafe', ...at, message: `${o.repo}: ${o.base.message}` });
  } else if (o.base.message) passed++;
  for (const hook of HOOK_NAMES) {
    const script = o.hooks[hook];
    const command = script ? hookCommand(script) : null;
    if (!command) continue;
    if (o.onPath(command)) { passed++; continue; }
    problems.push({
      severity: 'attention', kind: 'hook_missing', ...at, hook, command,
      message: `${o.route}/${o.repo}: the ${hook} hook runs \`${command}\`, which is not on the scheduler PATH — add its directory to ship.extraPath in crew.yaml`,
      remedy: 'add the directory holding it to ship.extraPath in crew.yaml',
    });
  }
  return { problems, passed };
}

/** Open ship-attention items as problems, skipping any a fresh finding already covers (`hook_missing` repeats). */
export function attentionProblems(items: ShipAttentionItem[], already: DoctorProblem[]): DoctorProblem[] {
  const seen = new Set(already.filter((p) => p.kind === 'hook_missing').map((p) => `hook_missing:${p.route}/${p.repo}/${p.hook}`));
  return items
    .filter((i) => !seen.has(i.key))
    .map((i) => ({ severity: 'attention' as const, kind: i.kind, message: i.message }));
}
