import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFile } from '../src/skills.ts';
import { skillMarkerNames } from '../src/skill-include.ts';

/**
 * ISSUE-293's acceptance criterion, as a test.
 *
 * The briefs under prompts/<preset>/ are shared by every project a route
 * points at that preset (see Route.promptsDir, config.ts). A path, a
 * command, an id or a person's name in one of them is wrong for every
 * project except the one it was written for — and wrong silently, since
 * the agent will follow it. Everything specific belongs in the Environment
 * block (src/environment.ts), the roster, or the repository's own .crew.yaml.
 *
 * If this fails, the fix is to move the specific thing out, not to widen the
 * pattern.
 *
 * Known gap: a bare repo-relative directory name (e.g. `apps/frontend`) is
 * NOT caught here — a pattern general enough to catch "any path that looks
 * project-shaped" would also fire on ordinary prose. Catching that class
 * currently relies on a human noticing (see ISSUE-375).
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
  // CREW-1533: incident history belongs in docs/prompt-rationale.md, not in a
  // prompt every run pays for — and a local ticket id or a date means nothing
  // to another organization's board. `ISSUE-123`/`ISSUE-000` are the worked
  // examples the briefs and the Environment section use for a tag's shape.
  ['a ticket reference', /\b(?:ISSUE|CREW|TABL|CMAC)-(?!(?:123|000)\b)\d+\b/],
  ['a date', /\b20\d\d-\d\d-\d\d\b/],
];

/** Every `prompts/<name>/` directory is its own self-contained preset — see docs/CONTRACT.md and Route.promptsDir. */
function presetDirs(): string[] {
  return readdirSync(PROMPTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PROMPTS, e.name));
}

function scan(dir: string, label: string, found: string[]): void {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    text.split('\n').forEach((line, n) => {
      for (const [what, re] of FORBIDDEN) {
        const m = re.exec(line);
        if (m) found.push(`${label}/${f}:${n + 1} contains ${what}: ${m[0].trim()}`);
      }
    });
  }
}

test('every prompt set is complete and names nothing specific to one project, machine or person', () => {
  const dirs = presetDirs();
  assert.ok(dirs.length >= 1, 'expected at least one prompt-set directory under prompts/');
  const found: string[] = [];
  for (const dir of dirs) {
    const label = dir.slice(PROMPTS.length + 1);
    const personas = join(dir, 'personas');
    const files = existsSync(personas) ? readdirSync(personas).filter((f) => f.endsWith('.md')) : [];
    assert.ok(files.some((f) => f.startsWith('lane-')), `${dir}/personas: expected at least one lane-<role>.md brief`);
    scan(personas, `${label}/personas`, found);

    const skills = join(dir, 'skills');
    if (existsSync(skills)) {
      for (const f of readdirSync(skills).filter((s) => s.endsWith('.md'))) {
        // Reuses the real parser rather than re-checking frontmatter shape here —
        // a skill file that fails to parse is exactly as broken as one `crew skills
        // sync` would reject.
        parseSkillFile(join(skills, f));
      }
      scan(skills, `${label}/skills`, found);
    }
  }
  assert.deepEqual(found, []);
});

/**
 * CREW-1388: a stop for a person must be written in data, and every stop
 * comment names what un-parks it. Both preset copies carry the same rules.
 */
for (const preset of ['default', 'dev-qa']) {
  test(`${preset} common persona keeps the stop-in-data rules (CREW-1388)`, () => {
    const text = readFileSync(join(PROMPTS, preset, 'skills', 'crew-lane-agent.md'), 'utf8');
    assert.match(text, /## Stopping: say it in data, not prose/);
    assert.match(text, /`needs_info` \*\*and\*\*\s+`assignee_id`/, 'a person-stop sets needs_info and the operator assignee');
    assert.match(text, /Resumes automatically when <condition>\. No status\s+change needed\./);
    assert.match(text, /"Mine, but nothing exists" is a start, not a stop/);
    assert.match(text, /that is a resume, not a new claim/);
    assert.doesNotMatch(text, /report it as unusual rather than\s+guessing/);
  });
}

// CREW-1495. A hand-off that clears the assignee makes a hybrid ticket off
// limits, so every hand-off sentence has to name the mode condition.
test('every prompt set states the hybrid vs automatic hand-off rule', () => {
  for (const dir of presetDirs()) {
    const personas = join(dir, 'personas');
    const common = readFileSync(join(dir, 'skills', 'crew-lane-agent.md'), 'utf8');
    assert.match(common, /`hybrid` project[^]*assigning that lane's seat/, `${dir}: common.md lacks the hybrid hand-off rule`);
    assert.match(common, /`automatic` project \*\*clear `assignee_id`\*\*/, `${dir}: step 3.9 lacks the mode condition`);
    assert.match(readFileSync(join(personas, 'lane-qa.md'), 'utf8'), /Person-built hybrid ticket/, `${dir}: lane-qa.md lacks the person-built case`);
    // CREW-1498: the bounce path must not clear the assignee in a hybrid project.
    assert.match(readFileSync(join(personas, 'lane-qa.md'), 'utf8'), /`hybrid` project[^]*clearing the assignee would strand the bounce[^]*assign the building seat/, `${dir}: lane-qa.md bounce path lacks the hybrid exception`);
  }
});

// CREW-1505. Work a ticket needs in another repo is a dependency: file it, link
// it in the waiting ticket's own `blocked_by`, return to `accepted`; QA bounces
// hand-offs that name needed work with no ticket.
for (const preset of ['default', 'dev-qa']) {
  test(`${preset} prompts park a ticket on cross-repo dependencies (CREW-1505)`, () => {
    const personas = join(PROMPTS, preset, 'personas');
    // CREW-1533: the procedure lives in the `Filing a Ticket` skill, fetched on
    // demand; common.md keeps the rule and the trigger.
    const common = readFileSync(join(PROMPTS, preset, 'skills', 'crew-lane-agent.md'), 'utf8');
    assert.match(common, /`Filing a Ticket` skill/);
    assert.match(common, /add\s+it to your own ticket's `blocked_by`[^]*set your ticket back\s+to `accepted`/);
    const filing = readFileSync(join(PROMPTS, preset, 'skills', 'filing-a-ticket.md'), 'utf8');
    assert.match(filing, /### Work your ticket needs in another repository/);
    assert.match(filing, /Add the new ticket's id to \*\*your own ticket's\*\* `blocked_by`/);
    assert.match(filing, /Set your ticket back to `accepted`/);
    assert.match(filing, /`hybrid` project keep `assignee_id` as your own seat/);
    assert.match(filing, /add the new ticket to \*\*your own ticket's\*\* `blocked_by`/);
    assert.doesNotMatch(filing, /in the new ticket's `blocked by` column/, 'the dependency points from the waiting ticket');
    assert.match(readFileSync(join(personas, 'lane-dev.md'), 'utf8'), /must not\s+name needed-but-unfiled work/);
    assert.match(readFileSync(join(personas, 'lane-qa.md'), 'utf8'), /needed-but-unfiled work[^]*that is a bounce[^]*stand-in/);
  });
}

// CREW-1533: a persona that says "fetch the `X` skill" must ship that skill in
// the same preset, or the trigger points at nothing.
test('every skill a persona names ships in the same preset', () => {
  for (const dir of presetDirs()) {
    const skillsDir = join(dir, 'skills');
    const shipped = new Set(
      existsSync(skillsDir)
        ? readdirSync(skillsDir).filter((f) => f.endsWith('.md')).map((f) => parseSkillFile(join(skillsDir, f)).name)
        : [],
    );
    const personas = join(dir, 'personas');
    for (const f of readdirSync(personas).filter((x) => x.endsWith('.md'))) {
      const text = readFileSync(join(personas, f), 'utf8');
      for (const m of text.matchAll(/`([A-Z][^`]+)` skill/g)) {
        assert.ok(shipped.has(m[1]!), `${dir}/personas/${f} names the \`${m[1]}\` skill, which ${dir}/skills does not ship`);
      }
    }
  }
});

test('the default design lane checks its hand-off for unfiled needed work (CREW-1505)', () => {
  const design = readFileSync(join(PROMPTS, 'default', 'personas', 'lane-design.md'), 'utf8');
  assert.match(design, /must not name needed-but-unfiled\s+work/);
});

// CREW-1534. The shared lane policy is a skill the building briefs include by
// marker, so an admin edit to a brief never forks it.
for (const preset of ['default', 'dev-qa']) {
  test(`${preset} building briefs include the Crew Lane Agent skill, and every marker names a shipped skill (CREW-1534)`, () => {
    const dir = join(PROMPTS, preset);
    assert.ok(!existsSync(join(dir, 'personas', 'common.md')), 'the policy lives in skills/, not personas/common.md');
    for (const role of ['dev', 'design', 'qa']) {
      const brief = readFileSync(join(dir, 'personas', `lane-${role}.md`), 'utf8');
      assert.ok(brief.startsWith('{{skill: Crew Lane Agent}}\n'), `lane-${role}.md must start with the include marker`);
    }
    const shipped = new Set(readdirSync(join(dir, 'skills')).map((f) => parseSkillFile(join(dir, 'skills', f)).name));
    for (const f of readdirSync(join(dir, 'personas'))) {
      for (const name of skillMarkerNames(readFileSync(join(dir, 'personas', f), 'utf8'))) {
        assert.ok(shipped.has(name), `${preset}/personas/${f} includes unshipped skill "${name}"`);
      }
    }
  });
}

test('lane skill and QA brief never prescribe rewriting a pushed branch (CREW-1550)', () => {
  for (const preset of readdirSync(PROMPTS)) {
    for (const file of ['skills/crew-lane-agent.md', 'personas/lane-qa.md']) {
      const text = readFileSync(join(PROMPTS, preset, file), 'utf8');
      assert.match(text, /merge `<remote>\/<base>` into/, `${preset}/${file} lacks the merge-the-base rule`);
      assert.equal(text.match(/rebase/gi)?.length ?? 0, 1, `${preset}/${file}: "rebase" only in the forbidding sentence`);
    }
  }
});

// CREW-1558: the record-then-file attachment steps stay inline in the shared
// lane policy and the QA brief — a one-line pointer to a skill was not enough
// (TABL-1557: two runs guessed `files/<id>` paths and reported a 404).
for (const preset of ['default', 'dev-qa']) {
  test(`${preset} prompts spell out the attachment lookup inline (CREW-1558)`, () => {
    const lane = readFileSync(join(PROMPTS, preset, 'skills', 'crew-lane-agent.md'), 'utf8');
    assert.match(lane, /Open the ticket's attachments before you start[^]*records\/<id>[^]*`storage_key`[^]*files\/<storage_key>/);
    const qa = readFileSync(join(PROMPTS, preset, 'personas', 'lane-qa.md'), 'utf8');
    assert.match(qa, /Media Library record for its `storage_key`/);
    const skill = readFileSync(join(PROMPTS, preset, 'skills', 'ticket-attachments.md'), 'utf8');
    assert.match(skill, /`uuid` and `filename`/);
  });
}
