import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  periscopesForStatus, portListening, readPeriscopeSidecars, removePeriscopeSidecar, urlPort, writePeriscopeSidecar,
  type PeriscopeSidecar,
} from '../src/periscope-state.ts';
import { duplicateLivePeriscopes, previewHostFinding, routePeriscopeProblems } from '../src/periscopes.ts';

const sc = (over: Partial<PeriscopeSidecar> = {}): PeriscopeSidecar => ({
  ticket: 'TABL-9', ticketRecordId: 'rec-1', periscopeRecordId: 'per-1', repo: 'synthesis', worktree: '/w', branch: 'tabl-9',
  url: 'http://h.local:4123/', host: 'h.local', state: 'live', isolated: false,
  startedAt: '2026-11-01T10:00:00.000Z', lastActivityAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-11-01T12:00:00.000Z', ...over,
});

test('sidecar is written on up, listed with a probed serving flag, and gone after remove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-peri-'));
  assert.deepEqual(await periscopesForStatus(dir), []);
  writePeriscopeSidecar(dir, sc());
  assert.equal(readPeriscopeSidecars(dir).length, 1);
  assert.equal((await periscopesForStatus(dir, async (p) => p === 4123))[0]!.serving, true);
  assert.equal((await periscopesForStatus(dir, async () => false))[0]!.serving, false);
  removePeriscopeSidecar(dir, 'rec-1');
  assert.deepEqual(await periscopesForStatus(dir), []);
});

test('portListening sees a real listener and then its absence', async () => {
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await portListening(port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await portListening(port), false);
});

test('portListening sees a listener bound to the IPv6 loopback only', async (t) => {
  const srv = createServer();
  const bound = await new Promise<boolean>((r) => { srv.once('error', () => r(false)); srv.listen(0, '::1', () => r(true)); });
  if (!bound) return t.skip('no IPv6 loopback on this machine');
  const port = (srv.address() as { port: number }).port;
  assert.equal(await portListening(port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await portListening(port), false);
});

test('urlPort', () => {
  assert.equal(urlPort('http://x:99/a'), 99);
  assert.equal(urlPort('https://x/'), 443);
  assert.equal(urlPort('nonsense'), undefined);
});

test('hosting findings: missing preview hook is a note, missing table a blocker, off is silent', () => {
  const repos = [{ name: 'a', hasPreviewHook: false }, { name: 'b', hasPreviewHook: true }];
  assert.deepEqual(routePeriscopeProblems({ route: 'r', hosts: false, repos, tablePresent: false }), []);
  const p = routePeriscopeProblems({ route: 'r', hosts: true, repos, tablePresent: false });
  assert.deepEqual(p.map((x) => [x.severity, x.kind, x.repo]), [['note', 'preview_hook_missing', 'a'], ['blocker', 'periscopes_table_missing', undefined]]);
  assert.equal(routePeriscopeProblems({ route: 'r', hosts: true, repos, tablePresent: undefined }).length, 1);
});

test('previewHostFinding: unresolvable is attention, unset stays a blocker', () => {
  assert.equal(previewHostFinding('ship.previewHost "x" does not resolve from this machine').kind, 'preview_host_unresolvable');
  assert.equal(previewHostFinding('ship.previewHost "x" does not resolve from this machine').severity, 'attention');
  assert.equal(previewHostFinding('ship.previewHost is not set').severity, 'blocker');
});

test('duplicateLivePeriscopes flags only an issue with two or more live rows, naming each', () => {
  const rows = [
    { id: 'p1', issue_id: 't1', ship_id: 's1', url: 'http://a' },
    { id: 'p2', issue_id: { id: 't1' }, ship_id: 's2', url: 'http://b' },
    { id: 'p3', issue_id: 't2', ship_id: 's1', url: 'http://c' },
  ];
  const out = duplicateLivePeriscopes(rows, (id) => `CREW-${id}`, (id) => `ship-${id}`, 'r');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'periscope_duplicate_live');
  assert.equal(out[0]!.severity, 'attention');
  assert.match(out[0]!.message, /CREW-t1.*p1 on ship-s1 http:\/\/a.*p2 on ship-s2 http:\/\/b/);
  assert.deepEqual(duplicateLivePeriscopes(rows.slice(2), (i) => i, (i) => String(i)), []);
});
