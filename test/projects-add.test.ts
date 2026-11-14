import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProject, offerFirstProject, planProjectAdd, ProjectsError, PROJECT_FORBIDDEN_MESSAGE, type ProjectWriter,
} from '../src/projects-cmd.ts';
import { noProjectsError, NO_PROJECTS_CODE } from '../src/repos-cmd.ts';
import { noProjectsFinding } from '../src/doctor-problems.ts';
import { FakeTracker, MODELS, SEATS, OPERATOR, crewRows } from './helpers/fake-tracker.ts';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

const run = promisify(execFile);
const CONTRACT = { columns: { workMode: 'work_mode' }, manualWorkMode: 'manual', hybridWorkMode: 'hybrid' };

function writer(rows: Array<{ id: string; name?: string; issue_prefix?: string | null }> = [], over: Partial<ProjectWriter> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const w: ProjectWriter = {
    projectRows: async () => rows,
    projectHasWorkMode: async () => true,
    createProjectRow: async (f) => { created.push(f); return { id: 'new-1' }; },
    contract: CONTRACT,
    ...over,
  };
  return { w, created };
}

test('createProject writes name, upper-cased prefix and automatic work mode', async () => {
  const { w, created } = writer();
  const { entry, created: made } = await createProject(w, { name: ' Web ', prefix: 'web1' });
  assert.equal(made, true);
  assert.deepEqual(created, [{ name: 'Web', issue_prefix: 'WEB1', work_mode: 'automatic' }]);
  assert.deepEqual(entry, { id: 'new-1', name: 'Web', issuePrefix: 'WEB1', workMode: 'automatic', current: false });
});

test('--work-mode hybrid is written through the contract value', async () => {
  const { w, created } = writer();
  const { entry } = await createProject(w, { name: 'Web', prefix: 'WEB', workMode: 'hybrid' });
  assert.equal(created[0]!.work_mode, 'hybrid');
  assert.equal(entry.workMode, 'hybrid');
});

test('name and prefix are required, and a prefix must be letters and digits, before any request', async () => {
  let reads = 0;
  const { w } = writer([], { projectRows: async () => { reads++; return []; } });
  await assert.rejects(createProject(w, { prefix: 'A' }), /needs a name/);
  await assert.rejects(createProject(w, { name: 'A' }), /needs an issue prefix/);
  await assert.rejects(createProject(w, { name: 'A', prefix: 'WE-B' }), /only contain letters and digits/);
  await assert.rejects(createProject(w, { name: 'A', prefix: 'WEB', workMode: 'sometimes' }), /unknown work mode/);
  assert.equal(reads, 0);
});

test('a name or prefix another row uses, in any letter case, is refused naming that row', async () => {
  const { w, created } = writer([{ id: 'p1', name: 'Crew', issue_prefix: 'CREW' }]);
  await assert.rejects(createProject(w, { name: 'crew', prefix: 'NEW' }), (e: unknown) => e instanceof ProjectsError && e.code === 'duplicate' && /"Crew" already exists/.test(e.message));
  await assert.rejects(createProject(w, { name: 'Other', prefix: 'crew' }), /prefix CREW is already used by project "Crew"/);
  assert.deepEqual(created, []);
});

test('a table with no work mode column refuses --work-mode but creates the row without it', async () => {
  const { w, created } = writer([], { projectHasWorkMode: async () => false });
  await assert.rejects(createProject(w, { name: 'A', prefix: 'A', workMode: 'hybrid' }), /no work_mode column/);
  await createProject(w, { name: 'A', prefix: 'A' });
  assert.deepEqual(created, [{ name: 'A', issue_prefix: 'A' }]);
});

test('a refused write says an admin has to add the project, with no raw response', async () => {
  const { w } = writer([], { createProjectRow: async () => { throw Object.assign(new Error('403 {"message":"Forbidden resource","statusCode":403}'), { status: 403 }); } });
  await assert.rejects(createProject(w, { name: 'A', prefix: 'A' }), (e: unknown) => e instanceof ProjectsError && e.code === 'forbidden' && e.message === PROJECT_FORBIDDEN_MESSAGE && !/Forbidden resource/.test(e.message));
});

test('--dry-run plans and writes nothing', async () => {
  const { w, created } = writer();
  const r = await createProject(w, { name: 'A', prefix: 'a' }, { dryRun: true });
  assert.equal(r.created, false);
  assert.deepEqual(created, []);
});

test('planProjectAdd is pure over the rows it is given', () => {
  const p = planProjectAdd({ name: 'A', prefix: 'ab' }, { workModeColumn: 'work_mode', manualWorkMode: 'manual', hybridWorkMode: 'hybrid', existing: [], hasWorkModeColumn: true });
  assert.equal(p.prefix, 'AB');
});

test('offerFirstProject creates the project after two answers, and declining creates nothing', async () => {
  const answers = ['Web', 'web'];
  const said: string[] = [];
  const made: unknown[] = [];
  const create = async (i: { name?: string; prefix?: string }) => { made.push(i); return { entry: { id: 'p', name: i.name!, issuePrefix: 'WEB', workMode: 'automatic' as const, current: false } }; };
  const yes = await offerFirstProject({ say: (l) => said.push(l), ask: async () => answers.shift()!, confirm: async () => true }, create);
  assert.equal(yes?.id, 'p');
  assert.deepEqual(made, [{ name: 'Web', prefix: 'web' }]);
  const no = await offerFirstProject({ say: () => {}, ask: async () => { throw new Error('asked'); }, confirm: async () => false }, create);
  assert.equal(no, null);
  assert.equal(made.length, 1);
});

test('the no-projects failure carries the stable code and names crew projects add', () => {
  const e = noProjectsError();
  assert.equal(e.code, NO_PROJECTS_CODE);
  assert.match(e.message, /crew projects add/);
  assert.doesNotMatch(e.message, /--project/);
});

test('doctor reports a tracker with no Projects row, and not one with a row', () => {
  const f = noProjectsFinding('w/p', 0);
  assert.equal(f?.kind, 'no_projects');
  assert.match(f!.remedy!, /crew projects add/);
  assert.equal(noProjectsFinding('w/p', 1), null);
});

// ---- the CLI, over a real HTTP fake ----

const PROJECTS = 'projects-model';
const REPOS = 'repos-model';

function ship(t: FakeTracker) {
  const home = mkdtempSync(join(tmpdir(), 'crew-pa-'));
  const repo = join(home, 'project');
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), 'x'); g('add', '.'); g('commit', '-qm', 'base');
  g('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  writeFileSync(join(home, '.env'), 'KEY=test-key\n');
  const cfgPath = join(home, 'crew.yaml');
  writeFileSync(cfgPath, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
  - route: test/proj
    enabled: true
    baseUrl: ${t.baseUrl}
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-1
      areaModelId: ${PROJECTS}
      reposModelId: ${REPOS}
      models: { issues: ${MODELS.issues}, comments: ${MODELS.comments}, crew: ${MODELS.crew} }
      seats: { dev: ${SEATS.dev}, design: ${SEATS.design}, qa: ${SEATS.qa} }
      operator: ${OPERATOR}
`);
  return {
    repo, cfgPath,
    run: async (...args: string[]) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [CREW, ...args], { env: { ...process.env, ...CREW_ENV, CREW_CONFIG: cfgPath }, timeout: 30_000 });
        return { code: 0, out: stdout, err: stderr };
      } catch (e) {
        const x = e as { code?: number; stdout?: string; stderr?: string };
        return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
      }
    },
  };
}

async function fake(projects: Array<Record<string, unknown> & { id: string }> = []) {
  return new FakeTracker().table(MODELS.crew, crewRows()).table(MODELS.comments, []).table(MODELS.issues, []).table(PROJECTS, projects).table(REPOS, []).start();
}

test('CLI: crew projects add creates one row, lists it, and a case-variant repeat is refused', async () => {
  const t = await fake();
  try {
    const s = ship(t);
    const r = await s.run('projects', 'add', 'Web', '--prefix', 'web');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(t.writes.map((w) => w.body), [{ name: 'Web', issue_prefix: 'WEB', work_mode: 'automatic' }]);
    const list = JSON.parse((await s.run('projects', '--json')).out) as { routes: Array<{ projects: Array<{ name: string; issuePrefix: string; workMode: string }> }> };
    assert.deepEqual(list.routes[0]!.projects.map((p) => [p.name, p.issuePrefix, p.workMode]), [['Web', 'WEB', 'automatic']]);
    const again = await s.run('projects', 'add', 'WEB', '--prefix', 'other');
    assert.notEqual(again.code, 0);
    assert.match(again.err, /already exists/);
    assert.equal(t.writes.length, 1);
  } finally { await t.stop(); }
});

test('CLI: a bad prefix makes no request, and hybrid reads back as hybrid', async () => {
  const t = await fake();
  try {
    const s = ship(t);
    const bad = await s.run('projects', 'add', 'Web', '--prefix', 'W-B');
    assert.notEqual(bad.code, 0);
    assert.equal(t.writes.length, 0);
    const ok = await s.run('projects', 'add', 'Hy', '--prefix', 'HY', '--work-mode', 'hybrid', '--json');
    assert.equal(ok.code, 0, ok.err);
    assert.equal((JSON.parse(ok.out) as { workMode: string }).workMode, 'hybrid');
    const list = JSON.parse((await s.run('projects', '--json')).out) as { routes: Array<{ projects: Array<{ workMode: string }> }> };
    assert.equal(list.routes[0]!.projects[0]!.workMode, 'hybrid');
  } finally { await t.stop(); }
});

test('CLI: repos add on an empty Projects table without a terminal stops with the reason code and writes nothing', async () => {
  const t = await fake();
  try {
    const s = ship(t);
    const r = await s.run('repos', 'add', 'test/proj', s.repo, '--json');
    assert.notEqual(r.code, 0);
    const body = JSON.parse(r.out) as { ok: boolean; reason: string; message: string };
    assert.equal(body.reason, 'no_projects');
    assert.match(body.message, /crew projects add/);
    assert.equal(t.writes.length, 0);
    assert.doesNotMatch(readFileSync(s.cfgPath, 'utf8'), /project\n|dir:/);
  } finally { await t.stop(); }
});

test('CLI: repos add --dry-run on an empty Projects table reports the need and creates nothing', async () => {
  const t = await fake();
  try {
    const s = ship(t);
    const r = await s.run('repos', 'add', 'test/proj', s.repo, '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would need a project first/);
    assert.equal(t.writes.length, 0);
  } finally { await t.stop(); }
});

test('CLI: repos add with two projects and none chosen fails as before', async () => {
  const t = await fake([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  try {
    const s = ship(t);
    const r = await s.run('repos', 'add', 'test/proj', s.repo, '--json');
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /pass --project/);
    assert.doesNotMatch(r.out, /no_projects/);
    assert.equal(t.writes.length, 0);
  } finally { await t.stop(); }
});
