import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorktreeIntel, type WorktreeIntelDeps } from '../src/intel-worktree.ts';
import { attachFilePath, readAttachFile, writeAttachFile } from '../src/intel-bridge.ts';
import type { IntelOutcome } from '../src/intel.ts';

function deps(over: Partial<WorktreeIntelDeps> & { stateDir: string }): WorktreeIntelDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    worktree: '/wt', route: 'ws/proj', number: '7', ticketTag: 'CREW-7', branch: 'crew-7', startupSeconds: 1,
    prepare: async () => { calls.push('setup'); return null; },
    runHook: async (name) => { calls.push(name); return name === 'ports' ? { code: 0, output: 'PORT=9\n' } : { code: 0, output: 'http://127.0.0.1:9/mcp\n' }; },
    probe: async (_d, env) => { calls.push(`probe PORT=${env.PORT}`); return { state: 'ready', url: 'http://127.0.0.1:9/mcp', tools: ['find_symbol'] } as IntelOutcome; },
    ...over, calls,
  } as WorktreeIntelDeps & { calls: string[] };
}

test('runs setup then ports then the probe, and writes the attach file', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'iw-'));
  try {
    const d = deps({ stateDir });
    const text = await startWorktreeIntel(d);
    assert.deepEqual(d.calls, ['setup', 'ports', 'probe PORT=9']);
    assert.equal(readAttachFile(attachFilePath(stateDir, 'ws/proj', '7')), 'http://127.0.0.1:9/mcp');
    assert.match(text, /find_symbol/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a service that still answers at the recorded URL is reused, not restarted', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'iw-'));
  try {
    writeAttachFile(attachFilePath(stateDir, 'ws/proj', '7'), 'http://127.0.0.1:9/mcp');
    const d = deps({ stateDir });
    await startWorktreeIntel(d);
    assert.deepEqual(d.calls, ['probe PORT=undefined']);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a failed setup or probe leaves no attach file and says why; it never throws', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'iw-'));
  try {
    const bad = await startWorktreeIntel(deps({ stateDir, prepare: async () => ({ code: 3, output: '' }) }));
    assert.match(bad, /setup exited 3/);
    const boom = await startWorktreeIntel(deps({ stateDir, probe: async () => { throw new Error('nope'); } }));
    assert.match(boom, /nope/);
    assert.equal(readAttachFile(attachFilePath(stateDir, 'ws/proj', '7')), undefined);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
