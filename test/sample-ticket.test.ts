import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadRepoConfig } from '../src/repo-config.ts';
import {
  SAMPLE_CREW_YAML, SAMPLE_MARKER, SAMPLE_REPO, isSampleTicket, planSampleTicket, sampleDescription, sampleDir,
} from '../src/sample-ticket.ts';
import { planRepoAdd, planRepoRemove, ReposError } from '../src/repos-cmd.ts';

test('the sandbox lands beside the first checkout, else under the repos base', () => {
  assert.equal(sampleDir(['/src/crew'], '/base', 'acme'), `/src/${SAMPLE_REPO}`);
  assert.equal(sampleDir([], '/base', 'acme'), `/base/acme/${SAMPLE_REPO}`);
});

test('the sandbox .crew.yaml is an always-green integrate repo with no versioning', () => {
  const y = parse(SAMPLE_CREW_YAML);
  assert.equal(y.release.mode, 'integrate');
  assert.equal(y.release.versioning, 'none');
  assert.equal(y.hooks.test, 'true');
  assert.equal(y.hooks.build, 'true');
  assert.equal(y.hooks.deploy, undefined);
});

test('the ticket is approved, unassigned, routed to the sandbox and recognisable', () => {
  const t = planSampleTicket({ projectId: 'p1', repoId: 'r1', approvedStatus: 'accepted' });
  assert.equal(t.status, 'accepted');
  assert.equal(t.repo_id, 'r1');
  assert.equal(t.project_id, 'p1');
  assert.ok(!('assignee_id' in t));
  assert.ok(isSampleTicket(String(t.description)));
  assert.ok(sampleDescription().startsWith(SAMPLE_MARKER));
  assert.ok(!isSampleTicket('mentions sample: true later'));
  assert.ok(!isSampleTicket(null));
});

test('removing the sandbox from a route restores the config it was added to', () => {
  const text = 'routes:\n  - route: a/b\n    dir: /src/crew\n';
  const added = planRepoAdd({ text, base: '/cfg', route: 'a/b', path: '/src/crew-sample', name: SAMPLE_REPO,
    nameForExisting: () => 'crew' });
  assert.deepEqual(parse(added.text).routes[0].repos, { crew: '/src/crew', [SAMPLE_REPO]: '/src/crew-sample' });
  const back = planRepoRemove(added.text, '/cfg', 'a/b', '/src/crew-sample');
  assert.equal(back.name, SAMPLE_REPO);
  assert.deepEqual(parse(back.text).routes[0], { route: 'a/b', dir: '/src/crew' });
});

test('removing the only checkout drops dir; an unknown path is refused', () => {
  const text = 'routes:\n  - route: a/b\n    dir: /src/crew-sample\n';
  assert.deepEqual(parse(planRepoRemove(text, '/cfg', 'a/b', '/src/crew-sample').text).routes[0], { route: 'a/b' });
  assert.throws(() => planRepoRemove(text, '/cfg', 'a/b', '/elsewhere'), ReposError);
});

test('the sandbox .crew.yaml passes the repo-config loader', () => {
  const d = mkdtempSync(join(tmpdir(), 'crew-sample-'));
  try {
    writeFileSync(join(d, '.crew.yaml'), SAMPLE_CREW_YAML);
    const rc = loadRepoConfig(d);
    assert.equal(rc?.release.mode, 'integrate');
    assert.equal(rc?.release.versioning, 'none');
    assert.equal(rc?.release.changelog, null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
