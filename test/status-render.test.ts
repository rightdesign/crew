import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus, WAITING_SHOWN, type StatusView } from '../src/status-render.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = (minsAgo: number): string => new Date(NOW - minsAgo * 60_000).toISOString();

const idle = (): StatusView => ({
  ship: { name: 'studio', platform: 'darwin' },
  route: { name: 'tablation', dir: '/work/tablation', enabled: true },
  crewPaused: false, releasePaused: false, pausedRoles: [],
  periscopes: { summary: 'off', live: [] },
  watermark: '2026-11-12T11:00:00Z', projects: ['Crew (automatic)'],
  reloadRequestedSecondsAgo: null,
  runs: [], lastRuns: [{ role: 'dev', ticket: 'CREW-1', finishedAt: iso(30), outcome: 'ok' }],
  attention: [], waiting: [],
  repos: Array.from({ length: 9 }, (_, i) => ({ name: `repo${i}`, releaser: 'any ship may release; lock row free', notable: false })),
  heldReleases: [],
  ships: [{ name: 'studio', line: 'studio online, idle', attention: [] }],
});

const text = (v: StatusView, verbose = false): string => renderStatus(v, { verbose, now: NOW }).join('\n');
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

test('an idle ship prints under ten lines', () => {
  const lines = renderStatus(idle(), { verbose: false, now: NOW });
  assert.ok(lines.length < 10, lines.join('\n'));
  assert.match(lines[0]!, /studio · tablation · active/);
  assert.match(text(idle()), /nothing \(last run 30m ago\)/);
  assert.match(text(idle()), /9 repositories idle/);
});

test('a busy ship shows each attention item once, runs, and a held lock', () => {
  const v = idle();
  v.pausedRoles = ['qa'];
  v.runs = [{ role: 'dev', ticket: 'CREW-9', repo: 'crew', pid: 42, spawnedAt: iso(12) }];
  v.attention = [
    { kind: 'role_parked', message: 'qa parked', since: iso(60) },
    { kind: 'release_stale', message: 'release timer stalled', since: iso(5) },
  ];
  v.repos[0] = { name: 'repo0', releaser: 'released by mini; lock held by mini', notable: true };
  v.ships = [
    { name: 'studio', line: 'studio online, engaged', attention: [...v.attention] },
    { name: 'mini', line: 'mini online, idle', attention: [{ kind: 'hook_missing', message: 'no setup' }] },
  ];
  const out = text(v);
  assert.match(out, /qa paused/);
  assert.match(out, /running:    dev — CREW-9 in crew for 12m/);
  assert.equal(count(out, 'qa parked'), 1);
  assert.equal(count(out, 'release timer stalled'), 1);
  assert.ok(out.indexOf('release timer stalled') < out.indexOf('qa parked'), 'most recent first');
  assert.match(out, /ship mini: 1 item/);
  assert.match(out, /releaser:   repo0 — released by mini; lock held by mini/);
  assert.match(out, /8 repositories idle/);
  assert.equal(count(text(v, true), 'qa parked'), 1);
  assert.equal(count(text(v, true), 'no setup'), 1);
});

test('the waiting list is cut at five, with the total, and --verbose lists all', () => {
  const v = idle();
  v.waiting = Array.from({ length: 8 }, (_, i) => ({
    key: `T-${i}`, title: `title ${i}`, reasons: i < 3 ? ['needs_planning'] : ['needs_info'], updatedAt: iso(i + 1),
  }));
  const out = text(v);
  assert.match(out, /waiting on you: 8 \(needs_planning 3, needs_info 5\)/);
  assert.equal(count(out, '  T-'), WAITING_SHOWN);
  assert.match(out, /… 3 more/);
  assert.ok(out.includes('T-0') && !out.includes('T-7'));
  const full = text(v, true);
  for (let i = 0; i < 8; i++) assert.ok(full.includes(`T-${i}`));
  assert.ok(!full.includes('more ('));
});

test('--verbose carries the configuration the default leaves out', () => {
  const v = idle();
  v.periscopes = { summary: 'on', relayUrl: 'https://r.example', live: ['T-1 repo http://x live'] };
  v.reloadRequestedSecondsAgo = 5;
  const def = text(v);
  const full = text(v, true);
  for (const frag of ['/work/tablation', 'enabled:    true', 'periscopes: on', 'relay:      https://r.example', 'periscope:  T-1', 'watermark:  2026-11-12T11:00:00Z', 'Crew (automatic)', 'crew:       active', 'release:    active']) {
    assert.ok(full.includes(frag), frag);
    assert.ok(!def.includes(frag), `default leaks ${frag}`);
  }
  assert.match(def, /reload:     requested 5s ago/);
  assert.equal(count(full, 'releaser:'), 9);
});
