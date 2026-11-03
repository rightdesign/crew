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
  hook?: 'setup' | 'test' | 'build' | 'deploy' | 'intel' | 'map';
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
  /** Sandbox ship (CREW-3007): hooks run in the image, so these gaps replace the host PATH check. */
  sandboxGaps?: Array<{ hook: string; command: string; message: string; remedy: string }>;
  /** Sandbox ship (CREW-3036): why the image's pnpm store cannot be written, when it cannot. */
  sandboxStoreProblem?: string | null;
  /** A file-form `map` (CREW-2919): what `hooks.map` names and whether it exists in the checkout. */
  mapFile?: { path: string; exists: boolean; lines: number; tokens: number };
  /** The `intel` hook's syntax check, when the repository declares one. */
  intelSyntax?: { status: 'ok' | 'error' | 'unchecked'; message?: string };
  /** A built-in `intel` flavor and the prerequisites it is missing from PATH (CREW-2914), each with its install line. */
  intelFlavor?: { name: string; missing: string[] };
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
  for (const g of o.sandboxGaps ?? []) {
    problems.push({ severity: 'attention', kind: 'hook_missing', ...at, hook: g.hook as (typeof HOOK_NAMES)[number], command: g.command, message: g.message, remedy: g.remedy });
  }
  if (o.sandboxStoreProblem !== undefined) {
    if (o.sandboxStoreProblem === null) passed++;
    else problems.push({
      severity: 'attention', kind: 'sandbox_store_unwritable', ...at,
      message: `${o.route}/${o.repo}: the pnpm store in its sandbox image cannot be written, so every offline \`pnpm install\` in a run fails (${o.sandboxStoreProblem})`,
      remedy: `rebuild the image with \`crew sandbox build ${o.repo}\`; the store at /opt/crew/pnpm-store must be owned by the sandbox user`,
    });
  }
  for (const hook of o.sandboxGaps ? [] : HOOK_NAMES) {
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
  if (o.mapFile) {
    if (!o.mapFile.exists) {
      problems.push({
        severity: 'attention', kind: 'map_file_missing', ...at, hook: 'map',
        message: `${o.route}/${o.repo}: hooks.map names ${o.mapFile.path}, which is not in the checkout, so briefs carry no repository map`,
        remedy: `commit ${o.mapFile.path}, or correct hooks.map in the repository's .crew.yaml`,
      });
    } else passed++;
  }
  if (o.intelSyntax) {
    if (o.intelSyntax.status === 'error') {
      problems.push({
        severity: 'attention', kind: 'intel_hook_syntax', ...at, hook: 'intel',
        message: `${o.route}/${o.repo}: the intel hook fails its syntax check, so no symbol service will start: ${(o.intelSyntax.message ?? '').split('\n')[0]}`,
        remedy: 'fix hooks.intel in the repository\'s .crew.yaml (`crew repos check` prints the full error)',
      });
    } else passed++;
  }
  if (o.intelFlavor) {
    if (o.intelFlavor.missing.length) {
      problems.push({
        severity: 'attention', kind: 'intel_prerequisite_missing', ...at, hook: 'intel',
        message: `${o.route}/${o.repo}: hooks.intel is \`${o.intelFlavor.name}\`, but ${o.intelFlavor.missing.join(' and ')} is not on the scheduler PATH, so no symbol service will start`,
        remedy: `install it (${o.intelFlavor.missing.join('; ')}) or add its directory to ship.extraPath in crew.yaml`,
      });
    } else passed++;
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
