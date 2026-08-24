import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ISSUE-293's acceptance criterion, as a test.
 *
 * The briefs under prompts/ are shared by every project the crew is pointed
 * at. A path, a command, an id or a person's name in one of them is wrong for
 * every project except the one it was written for — and wrong silently, since
 * the agent will follow it. Everything specific belongs in the Environment
 * block (src/environment.ts), the roster, or the repository's own .crew.yaml.
 *
 * If this fails, the fix is to move the specific thing out, not to widen the
 * pattern.
 */
const PROMPTS = join(import.meta.dirname, '..', 'prompts');

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a UUID', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
  ['an absolute path', /(?:^|[\s`(])\/(?:Users|home|opt|var|etc)\//],
  ['a package-manager command', /\b(?:pnpm|npm|yarn|npx|cargo|poetry|bundle)\s+\w/],
  ['a repository-relative script path', /\bscripts\/[\w.-]+/],
  ['a project document path', /\bdocs\/[A-Z_]+\.md/],
  ['a hostname', /https?:\/\/(?!example\.com)[\w.-]+/],
  ['an email address', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['a hardcoded port', /:(?:3000|5173|5432|8080)\b/],
];

test('no brief names anything specific to one project, machine or person', () => {
  const files = readdirSync(PROMPTS).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, 'expected the shared policy plus one brief per role');
  const found: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(PROMPTS, f), 'utf8');
    text.split('\n').forEach((line, n) => {
      for (const [what, re] of FORBIDDEN) {
        const m = re.exec(line);
        if (m) found.push(`${f}:${n + 1} contains ${what}: ${m[0].trim()}`);
      }
    });
  }
  assert.deepEqual(found, []);
});
