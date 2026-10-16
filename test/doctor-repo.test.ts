import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctorBaseReport } from '../src/doctor-repo.ts';

const boom = () => { throw new Error('git rev-parse: not a git repository'); };

test('a repo directory missing on disk is reported, not run through git (CREW-1796)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'doctor-')), 'never-created');
  const out = doctorBaseReport({ dir }, 'main', boom);
  assert.match(out.text, /is missing on disk/);
  assert.equal(out.failed, true);
  assert.equal(out.skipRest, true);
});

test('an existing directory whose git check throws prints "could not check"', () => {
  const out = doctorBaseReport({ dir: tmpdir() }, 'main', boom);
  assert.match(out.text, /base main: could not check — .*not a git repository/);
  assert.equal(out.failed, true);
  assert.equal(out.skipRest, false);
});

test('a healthy base prints its detail and does not fail', () => {
  const out = doctorBaseReport({ dir: tmpdir() }, 'main', () => ({ action: 'level', unsafe: false, detail: 'level with origin' }));
  assert.match(out.text, /base main: level with origin/);
  assert.equal(out.failed, false);
});
