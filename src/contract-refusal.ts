/**
 * A repository whose base `.crew.yaml` is refused must still be able to release
 * the ticket that fixes it (CREW-2928). The release reads the contract before it
 * merges anything, so a refusal there would otherwise be permanent: the change
 * that repairs the file is the very work it blocks.
 */
import { REPO_CONFIG_FILENAMES, RepoConfigError, parseRepoConfig } from './repo-config.ts';
import { gitOk } from './git.ts';
import { join } from 'node:path';

export interface ContractFixer {
  issueId: string;
  branch: string;
  file: string;
}

/**
 * The tickets whose branch changes the repo contract AND carries a version of
 * it that parses. `baseRef` is the ref the file was refused on; `locate` names a
 * ticket's branch (null when it has none). Parsing here is the same
 * `parseRepoConfig` the release uses, so a branch that still fails does not
 * count as a fix.
 */
export function contractFixers(
  dir: string, baseRef: string, tickets: ReadonlyArray<{ issue_id: string }>,
  locate: (t: { issue_id: string }) => string | null,
): ContractFixer[] {
  const out: ContractFixer[] = [];
  for (const t of tickets) {
    const branch = locate(t);
    if (!branch) continue;
    const changed = gitOk(dir, ['diff', '--name-only', `${baseRef}...${branch}`, '--', ...REPO_CONFIG_FILENAMES]);
    const file = changed?.split('\n').find((f) => f.trim() !== '');
    if (!file) continue;
    const text = gitOk(dir, ['show', `${branch}:${file}`]);
    if (text === null) continue;
    try {
      parseRepoConfig(text, join(dir, file));
    } catch (e) {
      if (e instanceof RepoConfigError) continue;
      throw e;
    }
    out.push({ issueId: t.issue_id, branch, file });
  }
  return out;
}
