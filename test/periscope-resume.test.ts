import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPeriscopeResume, type ResumeDeps } from '../src/periscope-resume.ts';
import { PeriscopeError } from '../src/periscope-cmd.ts';

const NOW = new Date('2026-11-01T12:00:00Z');

function harness(over: Partial<ResumeDeps> = {}, opts: { isolated?: boolean; preview?: { code: number; output: string } } = {}) {
  const log: string[] = [];
  const deps: ResumeDeps = {
    find: async () => ({ tag: 'CREW-9', row: { id: 'r1', issue_id: 'rec', worktree: '/w/crew-9', branch: 'crew-9', host: 'box.local', isolated: opts.isolated ?? false } }),
    worktreeExists: () => true,
    caps: { idleMinutes: 30 },
    runHook: async (name, _cwd, env) => {
      log.push([name, env.CREW_PREVIEW_HOST, env.PORT].filter(Boolean).join(' '));
      if (name === 'ports') return { code: 0, output: 'PORT=4009' };
      if (name === 'isolate') return { code: 0, output: 'DATABASE_URL=x' };
      return opts.preview ?? { code: 0, output: 'starting\nhttp://box.local:4009/' };
    },
    update: async (id, f) => { log.push(`update ${id} ${JSON.stringify(f)}`); },
    clearItem: (t) => { log.push(`clear ${t}`); },
    now: () => NOW,
    say: () => {},
    ...over,
  };
  return { deps, log };
}

test('resume reruns ports and preview, refreshes the row and clears the idle item', async () => {
  const h = harness();
  const r = await runPeriscopeResume(h.deps, '9');
  assert.equal(r.url, 'http://box.local:4009/');
  assert.deepEqual(h.log, [
    'ports',
    'preview box.local 4009',
    `update r1 ${JSON.stringify({ url: 'http://box.local:4009/', last_activity_at: NOW.toISOString(), expires_at: '2026-11-01T12:30:00.000Z' })}`,
    'clear CREW-9',
  ]);
});

test('an isolated periscope reruns isolate between ports and preview', async () => {
  const h = harness({}, { isolated: true });
  await runPeriscopeResume(h.deps, '9');
  assert.deepEqual(h.log.slice(0, 3), ['ports', 'isolate 4009', 'preview box.local 4009']);
});

test('refusals: no live row, worktree gone, failing preview (row and item untouched)', async () => {
  await assert.rejects(runPeriscopeResume(harness({ find: async () => undefined }).deps, '9'), PeriscopeError);
  await assert.rejects(runPeriscopeResume(harness({ worktreeExists: () => false }).deps, '9'), /worktree .* is gone/);
  const bad = harness({}, { preview: { code: 1, output: 'port busy' } });
  await assert.rejects(runPeriscopeResume(bad.deps, '9'), /preview exited 1/);
  assert.ok(!bad.log.some((l) => l.startsWith('update') || l.startsWith('clear')));
  const noUrl = harness({}, { preview: { code: 0, output: 'ready' } });
  await assert.rejects(runPeriscopeResume(noUrl.deps, '9'), /no URL/);
});
