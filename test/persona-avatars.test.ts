import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncPersonaAvatars, personaAvatarFile, routeAvatarFailures } from '../src/persona-avatars.ts';
import type { Route } from '../src/config.ts';

function route(files: string[]): Route {
  const prompts = mkdtempSync(join(tmpdir(), 'crew-avatars-'));
  mkdirSync(join(prompts, 'personas'), { recursive: true });
  for (const f of files) writeFileSync(join(prompts, 'personas', f), '<svg/>');
  return { route: 'issues/test', baseUrl: 'https://example.test', apiKey: 'sk_test', promptsDir: prompts, resolved: { workspaceId: 'ws-1' } } as unknown as Route;
}

function stubFetch(respond: (url: string) => Response) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; file?: string }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, file: ((init?.body as FormData).get('file') as File).name });
    return respond(url);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const personas = { dev: { agentId: 'a-dev' }, qa: { agentId: 'a-qa' } };

test('CREW-3117: uploads each bundled image to the sync route and reports the server verdict', async (t) => {
  const { calls, restore } = stubFetch((u) => json({ status: u.includes('a-dev') ? 'updated' : 'skipped', reason: 'customized' }));
  t.after(restore);
  const out = await syncPersonaAvatars(route(['lane-dev.svg', 'lane-qa.png']), personas, {});
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.file]), [
    ['PUT', 'https://example.test/api/workspaces/ws-1/agents/personas/a-dev/avatar', 'lane-dev.svg'],
    ['PUT', 'https://example.test/api/workspaces/ws-1/agents/personas/a-qa/avatar', 'lane-qa.png'],
  ]);
  assert.deepEqual(out.map((o) => [o.role, o.status]), [['dev', 'updated'], ['qa', 'skipped']]);
});

test('CREW-3117: a failed upload is an outcome, not a throw; roles without an image or row are not offered', async (t) => {
  const { calls, restore } = stubFetch(() => json({ message: 'nope' }, 500));
  t.after(restore);
  const out = await syncPersonaAvatars(route(['lane-dev.svg', 'lane-design.svg']), personas, {});
  assert.equal(calls.length, 1);
  assert.equal(out[0]!.status, 'failed');
  assert.match(out[0]!.detail!, /^500/);
});

test('CREW-3117: a preset with no images makes no calls; png wins over svg', async () => {
  assert.deepEqual(await syncPersonaAvatars(route([]), personas, {}), []);
  assert.equal(personaAvatarFile(route(['lane-dev.svg', 'lane-dev.png']).promptsDir, 'dev')!.mimeType, 'image/png');
  assert.deepEqual(routeAvatarFailures('/nonexistent', 'x'), []);
});
