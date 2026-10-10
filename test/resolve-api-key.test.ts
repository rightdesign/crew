import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveApiKey, type Route } from '../src/config.ts';

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.CREW_API_KEY;
  if (value === undefined) delete process.env.CREW_API_KEY; else process.env.CREW_API_KEY = value;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.CREW_API_KEY; else process.env.CREW_API_KEY = prior;
  }
}

const route = (extra: Partial<Route> = {}): Route => ({ route: 'r', ...extra }) as Route;

test('explicit apiKey wins over CREW_API_KEY (CREW-1503)', () => {
  assert.equal(withEnv('from-env', () => resolveApiKey(route({ apiKey: 'explicit' }))), 'explicit');
});

test('apiKeyFile/apiKeyVar wins over CREW_API_KEY (CREW-1503)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'crew-key-')), '.env');
  writeFileSync(file, 'MY_KEY="from-file"\n');
  const r = route({ apiKeyFile: file, apiKeyVar: 'MY_KEY' });
  assert.equal(withEnv('from-env', () => resolveApiKey(r)), 'from-file');
});

test('CREW_API_KEY is used when nothing else is configured (CREW-1503)', () => {
  assert.equal(withEnv(' from-env ', () => resolveApiKey(route())), 'from-env');
});

test('with nothing set the error names all three sources (CREW-1503)', () => {
  const r = route({ apiKeyFile: '/nope/.env', apiKeyVar: 'MY_KEY' });
  assert.throws(
    () => withEnv(undefined, () => resolveApiKey(r)),
    /apiKey; MY_KEY in \/nope\/\.env; CREW_API_KEY/,
  );
});

test('an empty CREW_API_KEY counts as unset (CREW-1503)', () => {
  assert.throws(() => withEnv('  ', () => resolveApiKey(route())), /no API key/);
});
