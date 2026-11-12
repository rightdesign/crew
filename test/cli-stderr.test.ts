// CREW-3286: a command's messages go through the Emitter (`die`, `emit.warn`, `emit.error`,
// `emit.note`) so they are logged, rendered like every other event and, for errors, end with
// a suggested fix. A direct `process.stderr.write` in src/cli.ts is allowed only where the
// output is not a message: a pipe-bound result, a usage line, a relayed child stream, an
// interactive prompt, or the machinery the Emitter itself renders through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lines = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8').split('\n');

// Matched against the call's own line, plus the two after it when the call opens a multi-line argument.
const ALLOWED: Array<{ match: string; count: number; reason: string }> = [
  { match: 'process.stderr.write(r.stderr)', count: 1, reason: 'relays the scheduler command\'s own stderr verbatim' },
  { match: 'process.stderr.write(res.stderr)', count: 3, reason: 'relays the scheduler command\'s own stderr verbatim' },
  { match: 'console: (l) => process.stderr.write(', count: 3, reason: 'the Emitter\'s own console sink (the module one, the daemon\'s per-route one, the sandbox build\'s)' },
  { match: "if (flag('verbose')) process.stderr.write(", count: 1, reason: 'the routine-note mechanism (`routineLine`) itself' },
  { match: 'crew agents prompt <role> [route]', count: 2, reason: 'usage text' },
  { match: 'crew agents sync [route] [--force]', count: 1, reason: 'usage text' },
  { match: 'crew skills sync [route]', count: 1, reason: 'usage text' },
  { match: 'crew ship rename NAME', count: 1, reason: 'usage text' },
  { match: 'crew repos add [workspace/project]', count: 1, reason: 'usage text' },
  { match: 'crew logbook list [route]', count: 1, reason: 'usage text' },
  { match: 'crew logbook show [route] <entryId>', count: 1, reason: 'usage text' },
  { match: 'crew connect [<workspace>[/<project>]] --key K', count: 1, reason: 'usage text' },
  { match: 'crew periscope up [[route] REPO]', count: 1, reason: 'usage text' },
  { match: 'crew periscope down [[route] NNN]', count: 1, reason: 'usage text' },
  { match: 'crew periscope list [route] [--json]', count: 1, reason: 'usage text' },
  { match: 'crew sandbox policy --route ROUTE', count: 1, reason: 'usage text' },
  { match: 'No API key given', count: 1, reason: 'interactive device-authorization prompt, an unterminated line the user answers in a browser' },
  { match: "process.stderr.write('\\n')", count: 2, reason: 'ends the device-authorization prompt line' },
  { match: 'capabilities for this key:', count: 1, reason: 'the capability report is connect\'s result; stdout is reserved for --json' },
  { match: 'describeCapability(i)', count: 1, reason: 'the capability report is connect\'s result; stdout is reserved for --json' },
  { match: '(dry run) would write', count: 2, reason: 'a dry run\'s preview is its result' },
  { match: 'nextSteps({', count: 1, reason: 'connect\'s closing next-steps are its result' },
  { match: 'Also set operator in', count: 1, reason: 'part of connect\'s closing next-steps' },
  { match: 'Paste the block above under routes:', count: 2, reason: 'part of connect\'s closing next-steps' },
  { match: 'JSON.stringify({ ...data, event, message })', count: 1, reason: 'periscope\'s --json event stream is written to stderr' },
];

test('src/cli.ts writes to stderr directly only where the output is not a message', () => {
  const emitterLine = lines.findIndex((l) => l.startsWith('const emit = new Emitter('));
  assert.ok(emitterLine > 0, 'the module-level Emitter moved; update this test');
  const used = new Map<string, number>();
  const stray: string[] = [];
  lines.forEach((text, i) => {
    if (!text.includes('process.stderr.write')) return;
    // Writes made before the Emitter exists (config errors, the usage screen, pool-member) have nothing to go through.
    if (i < emitterLine) return;
    const window = /[([]$/.test(text.trimEnd()) ? lines.slice(i, i + 3).join('\n') : text;
    const hit = ALLOWED.find((a) => window.includes(a.match));
    if (!hit) stray.push(`${i + 1}: ${text.trim().slice(0, 120)}`);
    else used.set(hit.match, (used.get(hit.match) ?? 0) + 1);
  });
  assert.deepEqual(stray, [], 'convert these to die()/emit.warn()/emit.error()/emit.note(), or allowlist them with a reason');
  for (const a of ALLOWED) {
    assert.equal(used.get(a.match) ?? 0, a.count, `allowlist entry "${a.match}" (${a.reason}) matched a different number of calls`);
  }
});
