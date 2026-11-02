import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLspPlugin, lspBinaryFound, lspFlavor, lspToolsParagraph, INTEL_FLAVORS } from '../src/intel.ts';
import { claudeAdapter } from '../src/adapters/claude.ts';
import { codexAdapter } from '../src/adapters/codex.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'crew-lsp-'));
const lspJson = (dir: string) => JSON.parse(readFileSync(join(dir, '.lsp.json'), 'utf8')) as Record<string, { command: string; args: string[]; extensionToLanguage: Record<string, string> }>;

test('lspFlavor recognizes typescript-lsp only', () => {
  assert.equal(lspFlavor('typescript-lsp'), 'typescript-lsp');
  assert.equal(lspFlavor('serena'), undefined);
  assert.equal(lspFlavor('scripts/dev-intel.sh'), undefined);
  assert.equal(INTEL_FLAVORS['typescript-lsp'].implemented, true);
});

test('ensureLspPlugin writes the official definition with a bare command when the checkout has no server', () => {
  const state = tmp(); const main = tmp();
  const dir = ensureLspPlugin(state, 'typescript-lsp', main);
  assert.equal(dir, join(state, 'intel', 'plugins', 'typescript-lsp'));
  const def = lspJson(dir)['typescript-language-server']!;
  assert.equal(def.command, 'typescript-language-server');
  assert.deepEqual(def.args, ['--stdio']);
  assert.equal(def.extensionToLanguage['.tsx'], 'typescriptreact');
  assert.equal(def.extensionToLanguage['.cjs'], 'javascript');
  assert.equal(Object.keys(def.extensionToLanguage).length, 8);
});

test('ensureLspPlugin prefers the checkout\'s own server, and leaves unchanged files alone', () => {
  const state = tmp(); const main = tmp();
  mkdirSync(join(main, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(main, 'node_modules', '.bin', 'typescript-language-server'), '');
  const dir = ensureLspPlugin(state, 'typescript-lsp', main);
  assert.equal(lspJson(dir)['typescript-language-server']!.command, '${CLAUDE_PROJECT_DIR}/node_modules/.bin/typescript-language-server');
  const before = statSync(join(dir, '.lsp.json')).mtimeMs;
  ensureLspPlugin(state, 'typescript-lsp', main);
  assert.equal(statSync(join(dir, '.lsp.json')).mtimeMs, before);
});

test('lspBinaryFound: checkout, PATH, or neither', () => {
  const main = tmp();
  assert.equal(lspBinaryFound('typescript-lsp', main, () => false), false);
  assert.equal(lspBinaryFound('typescript-lsp', main, (b) => b === 'typescript-language-server'), true);
  mkdirSync(join(main, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(main, 'node_modules', '.bin', 'typescript-language-server'), '');
  assert.equal(lspBinaryFound('typescript-lsp', main, () => false), true);
});

test('the Claude adapter appends --plugin-dir; codex ignores it', () => {
  const spec = { bin: 'claude', args: [], env: {}, maxThinkingTokens: 0 } as never;
  const on = claudeAdapter.invocation(spec, { role: 'dev', model: 'm', pluginDirs: ['/p/x'] }).args;
  assert.equal(on[on.indexOf('--plugin-dir') + 1], '/p/x');
  assert.ok(!claudeAdapter.invocation(spec, { role: 'dev', model: 'm' }).args.includes('--plugin-dir'));
  assert.ok(!codexAdapter.invocation(spec, { role: 'dev', model: 'm', pluginDirs: ['/p/x'] }).args.includes('--plugin-dir'));
});

test('lspToolsParagraph by harness and launcher', () => {
  assert.match(lspToolsParagraph('claude'), /`LSP` tool is active.*call hierarchy/);
  assert.match(lspToolsParagraph('codex'), /No symbol service is available for this harness/);
  assert.match(lspToolsParagraph('claude', true), /off for this launcher/);
});
