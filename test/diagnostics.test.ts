import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDiagnostics, redactText, redactValue, REDACTED, type DiagnosticsDeps, type Exec } from '../src/diagnostics.ts';

test('redactText: sk_ keys, bearer credentials, authorization headers and key=value secrets', () => {
  assert.equal(redactText('using sk_abcDEF123456 now'), `using ${REDACTED} now`);
  assert.equal(redactText('Authorization: Bearer abc.def-123'), `Authorization: ${REDACTED}`);
  assert.equal(redactText('sent bearer abc123xyz to relay'), `sent bearer ${REDACTED} to relay`);
  assert.equal(redactText('token=abc123 ok'), `token=${REDACTED} ok`);
  assert.equal(redactText('{"api_key": "abc123"}'), `{"api_key": "${REDACTED}"}`);
  assert.equal(redactText('password: hunter2'), `password: ${REDACTED}`);
  assert.equal(redactText('MCP_SECRET=zzz'), `MCP_SECRET=${REDACTED}`);
  assert.equal(redactText('plain line, nothing to hide'), 'plain line, nothing to hide');
});

test('redactValue: sensitive key names at any depth, and strings inside', () => {
  const out = redactValue({
    ok: 1, mcpSecret: 's', nested: { Authorization: 'x', apiKey: 'k', password: 'p', accessToken: 't', list: [{ secret: 1 }, 'sk_aaaaaaaa'] }, empty: { token: null },
  }) as Record<string, any>;
  assert.equal(out.ok, 1);
  assert.equal(out.mcpSecret, REDACTED);
  assert.equal(out.nested.Authorization, REDACTED);
  assert.equal(out.nested.apiKey, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.equal(out.nested.accessToken, REDACTED);
  assert.equal(out.nested.list[0].secret, REDACTED);
  assert.equal(out.nested.list[1], REDACTED);
  assert.equal(out.empty.token, null);
});

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  const stateDir = mkdtempSync(join(tmpdir(), 'dg-'));
  mkdirSync(join(stateDir, 'passengers'));
  writeFileSync(join(stateDir, 'passengers', 'ws1.json'), JSON.stringify({ workspaceId: 'ws1', status: 'connected', mcpSecret: 'topsecret' }));
  const exec: Exec = async (bin, args) => {
    if (bin === 'journalctl') return { stdout: 'a line\nAuthorization: Bearer abcdefgh\nkey sk_live_123456\n', code: 0 };
    if (bin === 'systemctl') return { stdout: 'ActiveState=active\nSubState=running\n', code: 0 };
    return { stdout: 'NAME\nbox1\n', code: 0 };
  };
  return {
    stateDir, workspaceIds: ['ws1'], runner: 'sandbox', unitStems: ['crew.abc'], userScope: true,
    doctor: async () => ({ problems: [], detail: 'token=leak123' }), exec, ...over,
  };
}

test('bundle: every section present and redacted', async () => {
  const b = await collectDiagnostics(deps()) as { sections: Record<string, any> };
  assert.deepEqual(Object.keys(b.sections).sort(), ['doctor', 'journal', 'sandbox', 'tunnel', 'units']);
  for (const s of Object.values(b.sections)) assert.equal(s.ok, true);
  const text = JSON.stringify(b);
  for (const leak of ['topsecret', 'leak123', 'abcdefgh', 'sk_live_123456']) assert.ok(!text.includes(leak), leak);
  assert.equal(b.sections.tunnel.data.ws1.mcpSecret, REDACTED);
  assert.equal(b.sections.units.data['crew.abc.service'].ActiveState, 'active');
});

test('bundle: one failing section does not sink the rest, and its error is redacted', async () => {
  const b = await collectDiagnostics(deps({
    doctor: async () => null,
    exec: async (bin) => { if (bin === 'journalctl') throw new Error('boom token=abc999'); return { stdout: 'x=y\n', code: 0 }; },
  })) as { sections: Record<string, any> };
  assert.equal(b.sections.doctor.ok, false);
  assert.equal(b.sections.journal.ok, false);
  assert.ok(!b.sections.journal.error.includes('abc999'));
  assert.equal(b.sections.tunnel.ok, true);
});

test('bundle: a section still running at the budget is reported timed out', async () => {
  const b = await collectDiagnostics(deps({ budgetMs: 50, doctor: () => new Promise(() => {}) })) as { sections: Record<string, any> };
  assert.equal(b.sections.doctor.ok, false);
  assert.match(b.sections.doctor.error, /timed out/);
  assert.equal(b.sections.tunnel.ok, true);
});

test('bundle: a non-systemd host and a host runner say so per section', async () => {
  const b = await collectDiagnostics(deps({ unitStems: [], runner: 'host' })) as { sections: Record<string, any> };
  assert.equal(b.sections.units.ok, false);
  assert.equal(b.sections.journal.ok, false);
  assert.deepEqual(b.sections.sandbox.data, { runner: 'host' });
});
