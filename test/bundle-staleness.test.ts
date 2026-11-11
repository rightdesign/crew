import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleStaleness } from '../src/bundle-staleness.ts';

/**
 * CREW-3236: a decoy checkout (bin/dist/src beside a package.json), in the
 * manner of test/launcher.test.ts, with mtimes set explicitly.
 */
function checkout(o: { src?: boolean; bundleAt?: number; srcAt?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crew-stale-'));
  mkdirSync(join(home, 'dist'));
  writeFileSync(join(home, 'dist', 'cli.js'), '');
  utimesSync(join(home, 'dist', 'cli.js'), (o.bundleAt ?? 2000) / 1000, (o.bundleAt ?? 2000) / 1000);
  if (o.src !== false) {
    mkdirSync(join(home, 'src'));
    writeFileSync(join(home, 'src', 'cli.ts'), '');
    utimesSync(join(home, 'src', 'cli.ts'), (o.srcAt ?? 1000) / 1000, (o.srcAt ?? 1000) / 1000);
    utimesSync(join(home, 'src'), (o.srcAt ?? 1000) / 1000, (o.srcAt ?? 1000) / 1000);
  }
  return home;
}

test('a bundle built from an older version than package.json names is stale, with the rebuild instruction', () => {
  const s = bundleStaleness({ built: '0.142.2', current: '0.143.1', home: checkout(), compiled: false });
  assert.equal(s?.kind, 'version');
  assert.equal(s?.builtVersion, '0.142.2');
  assert.match(s!.message, /0\.142\.2/);
  assert.match(s!.message, /npm run build/);
});

test('equal versions but source newer than the bundle is stale', () => {
  const s = bundleStaleness({ built: '0.143.1', current: '0.143.1', home: checkout({ bundleAt: 2000, srcAt: 5000 }), compiled: false });
  assert.equal(s?.kind, 'source');
  assert.match(s!.message, /npm run build/);
});

test('a current bundle is silent', () => {
  assert.equal(bundleStaleness({ built: '0.143.1', current: '0.143.1', home: checkout(), compiled: false }), null);
});

test('silent when running from source (no injected version)', () => {
  assert.equal(bundleStaleness({ built: null, current: '0.143.1', home: checkout({ srcAt: 5000 }), compiled: false }), null);
});

test('silent for an npm install (no src/ beside the bundle) even if versions differ', () => {
  assert.equal(bundleStaleness({ built: '0.1.0', current: '0.2.0', home: checkout({ src: false }), compiled: false }), null);
});

test('silent for a compiled binary', () => {
  assert.equal(bundleStaleness({ built: '0.1.0', current: '0.2.0', home: checkout(), compiled: true }), null);
});
