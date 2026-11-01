import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideIdle, newestWorktreeMtime, runPeriscopeIdlePass, periscopeIdleItem, periscopeIdleKey, type IdleDeps,
} from '../src/periscope-idle.ts';
import type { PeriscopeRow } from '../src/tracker.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const row = (over: Partial<PeriscopeRow> = {}): PeriscopeRow => ({
  id: 'r1', issue_id: 'rec1', worktree: '/w/crew-9',
  last_activity_at: iso(T0), expires_at: iso(T0 + 120 * MIN), ...over,
});

test('decideIdle: nothing before expiry, expiry after it', () => {
  assert.deepEqual(decideIdle(row(), null, T0 + 60 * MIN, 120), { action: 'none' });
  assert.deepEqual(decideIdle(row(), T0 - MIN, T0 + 119 * MIN, 120), { action: 'none' });
  const d = decideIdle(row(), null, T0 + 130 * MIN, 120);
  assert.deepEqual(d, { action: 'expire', idleMs: 130 * MIN });
});

test('decideIdle: a newer file pushes expires_at forward by the idle window', () => {
  const edited = T0 + 90 * MIN;
  assert.deepEqual(decideIdle(row(), edited, T0 + 100 * MIN, 120), {
    action: 'refresh', lastActivityAt: iso(edited), expiresAt: iso(edited + 120 * MIN),
  });
});

test('decideIdle: activity after expiry refreshes instead of expiring; a touched last_activity_at is honored', () => {
  assert.equal(decideIdle(row(), T0 + 200 * MIN, T0 + 210 * MIN, 120).action, 'refresh');
  const touched = row({ last_activity_at: iso(T0 + 100 * MIN) });
  assert.equal(decideIdle(touched, null, T0 + 110 * MIN, 120).action, 'refresh');
});

test('newestWorktreeMtime ignores gitignored files and node_modules, sees untracked ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-idle-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n');
  writeFileSync(join(dir, 'a.txt'), 'x');
  mkdirSync(join(dir, 'dist')); mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'dist', 'out.js'), 'x');
  writeFileSync(join(dir, 'node_modules', 'm.js'), 'x');
  const old = new Date('2026-01-01T00:00:00Z');
  const recent = new Date('2026-06-01T00:00:00Z');
  for (const f of ['.gitignore', 'a.txt']) utimesSync(join(dir, f), old, old);
  for (const f of ['dist/out.js', 'node_modules/m.js']) utimesSync(join(dir, f), recent, recent);
  assert.equal(newestWorktreeMtime(dir), old.getTime());
  writeFileSync(join(dir, 'new.txt'), 'x');   // untracked, not ignored
  utimesSync(join(dir, 'new.txt'), recent, recent);
  assert.equal(newestWorktreeMtime(dir), recent.getTime());
  assert.equal(newestWorktreeMtime(join(dir, 'missing')), null);
});

function harness(rows: PeriscopeRow[], over: Partial<IdleDeps> = {}, mtime: number | null = null) {
  const log: string[] = [];
  let open: ShipAttentionItem[] = [];
  const deps: IdleDeps = {
    idleMinutes: 120,
    now: () => new Date(T0 + 130 * MIN),
    listLive: async () => rows,
    mtimeOf: () => mtime,
    update: async (id, f) => { log.push(`update ${id} ${JSON.stringify(f)}`); },
    ticketOf: async () => ({ tag: 'CREW-9', number: '9', repo: 'crew' }),
    stopServer: async (w, n) => { log.push(`stop ${w} ${n}`); },
    raise: async (i) => { open = [...open.filter((o) => o.key !== i.key), i]; log.push(`raise ${i.key}`); },
    clear: (k) => { open = open.filter((o) => o.key !== k); log.push(`clear ${k}`); },
    openKeys: () => open.map((o) => o.key),
    warn: (m) => log.push(`warn ${m}`),
    ...over,
  };
  return { deps, log, items: () => open };
}

test('the pass stops the server and raises periscope_idle once expired; the row is not touched', async () => {
  const h = harness([row()]);
  const r = await runPeriscopeIdlePass(h.deps);
  assert.deepEqual(r, { refreshed: 0, expired: 1 });
  assert.deepEqual(h.log, ['stop /w/crew-9 9', 'raise periscope_idle:CREW-9']);
  const item = h.items()[0]!;
  assert.equal(item.kind, 'periscope_idle');
  for (const part of ['CREW-9', '(crew)', '2h 10m', 'down 9 --keep', 'down 9 --discard', 'up --resume 9']) {
    assert.ok(item.message.includes(part), `message names ${part}: ${item.message}`);
  }
});

test('activity before expiry refreshes the row; activity after an idle stop clears the item without restarting', async () => {
  const edited = T0 + 125 * MIN;
  const h = harness([row({ expires_at: iso(T0 + 120 * MIN) })], {}, edited);
  await h.deps.raise(periscopeIdleItem('CREW-9', 'crew', '9', 1, iso(T0)));
  h.log.length = 0;
  const r = await runPeriscopeIdlePass(h.deps);
  assert.deepEqual(r, { refreshed: 1, expired: 0 });
  assert.equal(h.log[0], `update r1 ${JSON.stringify({ last_activity_at: iso(edited), expires_at: iso(edited + 120 * MIN) })}`);
  assert.ok(!h.log.some((l) => l.startsWith('stop')));
  assert.deepEqual(h.items(), []);
});

test('an item whose periscope is no longer live is cleared; a failing row is warned about and keeps items', async () => {
  const h = harness([]);
  await h.deps.raise(periscopeIdleItem('CREW-9', 'crew', '9', 1, iso(T0)));
  await runPeriscopeIdlePass(h.deps);
  assert.deepEqual(h.items(), []);

  const bad = harness([row()], { ticketOf: async () => { throw new Error('boom'); } });
  await bad.deps.raise(periscopeIdleItem('CREW-9', 'crew', '9', 1, iso(T0)));
  const r = await runPeriscopeIdlePass(bad.deps);
  assert.deepEqual(r, { refreshed: 0, expired: 0 });
  assert.ok(bad.log.some((l) => l.startsWith('warn periscope idle check failed')));
  assert.deepEqual(bad.items().map((i) => i.key), [periscopeIdleKey('CREW-9')]);
});
