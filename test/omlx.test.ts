import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseOmlxSettings, interpretOmlxProbe, omlxModelPresent } from '../src/launcher.ts';

test('settings: host, port and model dirs are read; the auth block is never touched', () => {
  const text = JSON.stringify({
    server: { host: '127.0.0.1', port: 8111 },
    auth: { api_key: 'sk-secret' },
    model: { model_dirs: ['/Volumes/Extra/omlx/models'] },
  });
  const s = parseOmlxSettings(text)!;
  assert.deepEqual(s, { host: '127.0.0.1', port: 8111, modelDirs: ['/Volumes/Extra/omlx/models'] });
  assert.equal(JSON.stringify(s).includes('sk-secret'), false);
});

test('settings: a wildcard bind is probed on loopback; garbage or no port is undefined', () => {
  assert.equal(parseOmlxSettings('{"server":{"host":"0.0.0.0","port":9000}}')!.host, '127.0.0.1');
  assert.equal(parseOmlxSettings('not json'), undefined);
  assert.equal(parseOmlxSettings('{"server":{}}'), undefined);
});

test('probe: 401 means up and key required; no answer or a 5xx is down', () => {
  assert.deepEqual(interpretOmlxProbe(401), { up: true, detail: 'up (key required)' });
  assert.equal(interpretOmlxProbe(200).up, true);
  assert.equal(interpretOmlxProbe(undefined).up, false);
  assert.equal(interpretOmlxProbe(500).up, false);
});

test('model presence is a directory listing of the model dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omlx-models-'));
  mkdirSync(join(dir, 'Qwen3.8-27B-4bit'));
  assert.equal(omlxModelPresent('Qwen3.8-27B-4bit', [dir]), true);
  assert.equal(omlxModelPresent('Other', [dir]), false);
  assert.equal(omlxModelPresent('Qwen3.8-27B-4bit', ['/nonexistent-dir']), false);
});
