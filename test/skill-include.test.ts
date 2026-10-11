import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expandSkillMarkers, skillMarkerNames, SkillIncludeError } from '../src/skill-include.ts';
import { planAgentRun, AgentError } from '../src/agent.ts';
import { personaDefaultPrompt } from '../src/agents.ts';
import { skillMarkerWarnings } from '../src/skills.ts';

const lookupFrom = (skills: Record<string, string>) => (name: string) => skills[name];

test('a marker is replaced by the skill body, on its own line or inline, with whitespace tolerated', () => {
  const r = expandSkillMarkers('top\n{{skill: A}}\nmid {{ skill:B }} end', lookupFrom({ A: '\nAAA\n\n', B: 'bbb' }));
  assert.equal(r.text, 'top\nAAA\nmid bbb end');
  assert.deepEqual(r.warnings, []);
});

test('names match exactly after trimming — case and inner spacing matter', () => {
  assert.throws(() => expandSkillMarkers('{{skill: a}}', lookupFrom({ A: 'x' })), SkillIncludeError);
  assert.throws(() => expandSkillMarkers('{{skill: Crew  Lane}}', lookupFrom({ 'Crew Lane': 'x' })), SkillIncludeError);
});

test('an unknown skill throws rather than running with a raw marker', () => {
  assert.throws(() => expandSkillMarkers('{{skill: Nope}}', lookupFrom({})), /no skill named "Nope"/);
});

test('text that is not a marker is untouched, including wiki links and other braces', () => {
  const text = '[[Skills:key|alias]] {{variable}} {{skill}} {{skill:}} {skill: A}';
  assert.equal(expandSkillMarkers(text, lookupFrom({ A: 'x' })).text, text);
});

test('a self-including skill is expanded once and the repeat is left literal with a warning', () => {
  const r = expandSkillMarkers('{{skill: A}}', lookupFrom({ A: 'a1 {{skill: A}} a2' }));
  assert.equal(r.text, 'a1 {{skill: A}} a2');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /A → A/);
});

test('a two-skill cycle terminates, naming the chain', () => {
  const r = expandSkillMarkers('{{skill: A}}', lookupFrom({ A: 'a {{skill: B}}', B: 'b {{skill: A}}' }));
  assert.equal(r.text, 'a b {{skill: A}}');
  assert.match(r.warnings[0]!, /A → B → A/);
});

test('the same skill included twice side by side is not a cycle', () => {
  const r = expandSkillMarkers('{{skill: A}} {{skill: A}}', lookupFrom({ A: 'x' }));
  assert.equal(r.text, 'x x');
  assert.deepEqual(r.warnings, []);
});

test('includes nested past the depth cap are left literal', () => {
  const skills = { A: '{{skill: B}}', B: '{{skill: C}}', C: '{{skill: D}}', D: 'deep' };
  const r = expandSkillMarkers('{{skill: A}}', lookupFrom(skills));
  assert.equal(r.text, '{{skill: D}}');
  assert.match(r.warnings[0]!, /deeper than 3/);
  assert.equal(expandSkillMarkers('{{skill: A}}', lookupFrom(skills), { maxDepth: 4 }).text, 'deep');
});

test('includes past the byte budget are left literal', () => {
  const r = expandSkillMarkers('{{skill: A}}{{skill: B}}', lookupFrom({ A: 'aaaa', B: 'bbbb' }), { maxBytes: 6 });
  assert.equal(r.text, 'aaaa{{skill: B}}');
  assert.match(r.warnings[0]!, /byte include budget/);
});

test('skillMarkerNames lists each distinct name once', () => {
  assert.deepEqual(skillMarkerNames('{{skill: A}} {{skill: B}} {{skill: A}}'), ['A', 'B']);
});

function rig(briefs: Record<string, string>, skills: Record<string, string>) {
  const promptsDir = mkdtempSync(join(tmpdir(), 'crew-inc-'));
  mkdirSync(join(promptsDir, 'personas'), { recursive: true });
  mkdirSync(join(promptsDir, 'skills'), { recursive: true });
  for (const [role, text] of Object.entries(briefs)) writeFileSync(join(promptsDir, 'personas', `lane-${role}.md`), text);
  for (const [name, body] of Object.entries(skills)) {
    writeFileSync(join(promptsDir, 'skills', `${name.replace(/\W+/g, '-')}.md`), `---\nname: ${name}\ndescription: d\n---\n${body}`);
  }
  const route = { route: 'test/proj', dir: '/tmp/proj', promptsDir } as any;
  const ship = { agent: { bin: '/bin/echo', model: 'claude-sonnet-5' } } as any;
  const state = mkdtempSync(join(tmpdir(), 'crew-state-'));
  return { promptsDir, route, ship, state };
}

test('planAgentRun expands a marker from the local skill file, frontmatter stripped, and hashes the expanded text', () => {
  const { route, ship, state } = rig({ dev: '{{skill: Policy}}\n\nDEV BRIEF\n' }, { Policy: 'LOCAL POLICY\n' });
  const plan = planAgentRun({ role: 'dev', route, ship, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  assert.match(plan.prompt, /ENV\n\nLOCAL POLICY\n\nDEV BRIEF/);
  assert.ok(!plan.prompt.includes('{{skill'));
  assert.ok(!plan.prompt.includes('description: d'));
  assert.equal(plan.promptSha, createHash('sha256').update('LOCAL POLICY\n\nDEV BRIEF\n').digest('hex'));
});

test('planAgentRun prefers a diverged skill row over the local file', () => {
  const { route, ship, state } = rig({ dev: '{{skill: Policy}}\nBRIEF\n' }, { Policy: 'LOCAL POLICY\n' });
  const plan = planAgentRun({
    role: 'dev', route, ship, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1',
    skillOverrides: { Policy: 'ADMIN POLICY' },
  });
  assert.ok(plan.prompt.includes('ADMIN POLICY') && !plan.prompt.includes('LOCAL POLICY'));
});

test('planAgentRun expands markers in a diverged persona prompt too, including an admin-only skill', () => {
  const { route, ship, state } = rig({ dev: 'BRIEF\n' }, {});
  const plan = planAgentRun({
    role: 'dev', route, ship, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1',
    divergedPrompt: 'EDITED\n{{skill: Admin Only}}', skillOverrides: { 'Admin Only': 'FROM ROW' },
  });
  assert.match(plan.prompt, /EDITED\nFROM ROW/);
});

test('planAgentRun refuses to run when a brief includes an unknown skill', () => {
  const { route, ship, state } = rig({ dev: '{{skill: Missing}}\n' }, {});
  assert.throws(
    () => planAgentRun({ role: 'dev', route, ship, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' }),
    (e: unknown) => e instanceof AgentError && /Missing/.test(e.message),
  );
});

test('planAgentRun reports a skill cycle in the plan warnings and still runs', () => {
  const { route, ship, state } = rig({ dev: '{{skill: A}}\n' }, { A: 'a {{skill: B}}', B: 'b {{skill: A}}' });
  const plan = planAgentRun({ role: 'dev', route, ship, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  assert.ok(plan.warnings?.some((w) => /A → B → A/.test(w)));
});

test('personaDefaultPrompt syncs the brief with its marker unexpanded', () => {
  const { promptsDir } = rig({ dev: '{{skill: Policy}}\n\nDEV\n' }, { Policy: 'P' });
  assert.equal(personaDefaultPrompt(promptsDir, 'dev'), '{{skill: Policy}}\n\nDEV\n');
});

test('skillMarkerWarnings names a marker whose skill the preset does not ship', () => {
  const { promptsDir } = rig({ dev: '{{skill: Policy}}\n' }, { Policy: 'P' });
  assert.deepEqual(skillMarkerWarnings(promptsDir, { dev: '{{skill: Policy}}', qa: '{{skill: Gone}}' }).length, 1);
  assert.match(skillMarkerWarnings(promptsDir, { qa: '{{skill: Gone}}' })[0]!, /^qa:.*Gone/);
});
