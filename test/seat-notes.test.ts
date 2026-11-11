import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startControlServer } from '../src/control-api.ts';
import { State } from '../src/state.ts';
import { withSeatNotes } from '../src/agent.ts';
import { addSeatNote, waitingSeatNotes } from '../src/seat-notes.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'sn-'));

test('a note posted for an idle seat is spooled and the seat\'s next brief carries it once (CREW-3249)', async (t) => {
  const state = dir();
  const srv = (await startControlServer({
    stateDir: state, state: new State(state), auth: { verify: async () => 'ok' },
    status: async () => ({}), doctor: async () => ({}), scheduler: () => ({ accepted: false, detail: 'none' }),
  }))!;
  t.after(() => srv.close());
  const post = (path: string, body: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ socketPath: srv.path, method: 'POST', path, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  const any = await post('/seats/dev/notes', { text: 'check the migration', author: 'Brad' });
  assert.equal(any.status, 200);
  assert.equal(any.json.state, 'carried_forward');
  assert.equal(any.json.carriedForward, true);
  await post('/seats/dev/notes', { text: 'only for 3249', ticket: 'CREW-3249' });
  await post('/seats/qa/notes', { text: 'qa only' });

  assert.equal((await post('/seats/nobody/notes', { text: 'x' })).status, 400);
  assert.equal((await post('/seats/dev/notes', { text: '  ' })).status, 400);
  assert.equal((await post('/seats/dev/notes', { text: 'x', ticket: 5 })).status, 400);

  mkdirSync(join(state, 'streams'), { recursive: true });
  const base = { role: 'dev', prompt: 'BRIEF', promptBytes: 5, streamPath: join(state, 'streams', 'r.jsonl') } as any;
  const other = withSeatNotes({ ...base, ticket: 'CREW-1' });
  assert.match(other.prompt, /^BRIEF\n\n## Notes left for this seat/);
  assert.match(other.prompt, /Brad: check the migration/);
  assert.doesNotMatch(other.prompt, /only for 3249/);
  assert.equal(other.promptBytes, Buffer.byteLength(other.prompt));

  const mine = withSeatNotes({ ...base, ticket: 'crew-3249' });
  assert.match(mine.prompt, /only for 3249/);
  assert.doesNotMatch(mine.prompt, /check the migration/, 'consumed by the earlier run');

  assert.equal(withSeatNotes(base), base, 'nothing waiting leaves the plan as it is');
  assert.equal(existsSync(join(state, 'seat-notes', 'dev.jsonl')), false);
  assert.equal(waitingSeatNotes(state, 'qa').length, 1, 'another seat\'s notes stay');
});

test('a ticketed note waits when the run\'s ticket is unknown', () => {
  const state = dir();
  addSeatNote(state, { role: 'dev', text: 't', ticket: 'CREW-9' });
  assert.equal(waitingSeatNotes(state, 'dev').length, 0);
  assert.equal(waitingSeatNotes(state, 'dev', 'CREW-9').length, 1);
});
