import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePushedSha, verifiedShaFor, movedPastVerified } from '../src/verified-tip.ts';
import type { Ticket, RunnerEvent } from '../src/tracker.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-verified-tip-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  g('commit', '--allow-empty', '-qm', 'base');
  return { dir, g };
}
const T = (o: Record<string, unknown> = {}) => ({ id: 'rec-1', issue_id: 'ISSUE-1', ...o }) as unknown as Ticket;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ev = (sha: string, at: string, record_id = 'rec-1'): RunnerEvent =>
  ({ record_id, event_type: 'pushed', message: `pushed ${sha} to origin/crew-1`, occurred_at: at });

test('parsePushedSha reads only the runner\'s own hand-off wording', () => {
  assert.equal(parsePushedSha(`pushed ${SHA_A} to origin/crew-1`), SHA_A);
  assert.equal(parsePushedSha('pushed abc to origin/x'), null);
  assert.equal(parsePushedSha(null), null);
});

test('verifiedShaFor: the column beats events; otherwise the newest pushed event for this ticket', () => {
  const events = [ev(SHA_A, '2026-10-13T10:00:00Z'), ev(SHA_B, '2026-10-13T11:00:00Z'), ev('c'.repeat(40), '2026-10-13T12:00:00Z', 'other')];
  assert.equal(verifiedShaFor(T(), 'verified_sha', events), SHA_B);
  assert.equal(verifiedShaFor(T({ verified_sha: SHA_A }), 'verified_sha', events), SHA_A);
  assert.equal(verifiedShaFor(T(), 'verified_sha', []), null);
});

test('movedPastVerified: unchanged, merge-only and behind are not movement; new work and divergence are', () => {
  const { dir, g } = repo();
  g('checkout', '-qb', 'crew-1');
  g('commit', '--allow-empty', '-qm', 'work');
  const verified = g('rev-parse', 'HEAD');
  assert.equal(movedPastVerified(dir, 'crew-1', verified), null);

  // The base moves on and the runner merges it in: merge commit only.
  g('checkout', '-q', 'main'); g('commit', '--allow-empty', '-qm', 'main moves');
  g('checkout', '-q', 'crew-1'); g('merge', '--no-ff', '-qm', 'merge main', 'main');
  assert.equal(movedPastVerified(dir, 'crew-1', verified), null);

  // A real commit past it.
  g('commit', '--allow-empty', '-qm', 'more work');
  const tip = g('rev-parse', 'HEAD');
  assert.deepEqual(movedPastVerified(dir, 'crew-1', verified), { tip, verified });

  // The branch behind what was verified: the squash carries less, not more.
  assert.equal(movedPastVerified(dir, 'main', tip), null);

  // Diverged from what was verified.
  g('checkout', '-q', '-b', 'other', verified); g('commit', '--allow-empty', '-qm', 'rewritten');
  assert.ok(movedPastVerified(dir, 'other', tip));
});

test('movedPastVerified: a verified sha this checkout cannot see is "can\'t tell", not movement', () => {
  const { dir, g } = repo();
  g('checkout', '-qb', 'crew-1');
  assert.equal(movedPastVerified(dir, 'crew-1', SHA_A), null);
});
