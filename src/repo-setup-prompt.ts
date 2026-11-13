import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the standalone repository setup prompt lives under the package root (and in an installed copy). */
export const REPO_SETUP_PROMPT_PATH = join('docs', 'repo-setup-prompt.md');

/**
 * The text `crew repos prompt` prints (CREW-3310): the file the docs site
 * publishes, byte for byte. `crewHome` is the package root (or, for the
 * compiled binary, the directory beside it), which is where `package.json`
 * `files` and `scripts/build-binaries.sh` place the one file.
 */
export function readRepoSetupPrompt(crewHome: string): string {
  return readFileSync(join(crewHome, REPO_SETUP_PROMPT_PATH), 'utf8');
}
