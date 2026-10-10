import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pairBlock, upsertPairBlock, removePairBlock, hasPairBlock, pairBlockIsBroken, upsertTomlTable, removeTomlTable, codexTable,
  codexPair, geminiPair, copilotPair, isPairHarness, harnessPromptNote, PAIR_BLOCK_START,
} from '../src/pair-install.ts';

const URL = 'https://app.example.test/api/mcp';
const home = () => mkdtempSync(join(tmpdir(), 'pair-'));
const put = (h: string, rel: string, text: string) => {
  const p = join(h, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const read = (h: string, rel: string) => readFileSync(join(h, rel), 'utf8');

test('block: insert into empty, append after foreign content, replace in place, remove restores', () => {
  const b = pairBlock('codex');
  assert.equal(upsertPairBlock('', b), `${b}\n`);
  const foreign = '# My notes\n\nUse tabs.\n';
  const added = upsertPairBlock(foreign, b);
  assert.ok(added.startsWith(foreign.trimEnd()));
  assert.ok(hasPairBlock(added));
  assert.equal(upsertPairBlock(added, b), added);
  const stale = added.replace('pair --harness codex', 'pair --harness old');
  assert.equal(upsertPairBlock(stale, b), added);
  assert.equal(removePairBlock(added), foreign);
  assert.equal(removePairBlock(`${b}\n`).trim(), '');
});

test('block: content around the block survives a replace', () => {
  const b = pairBlock('gemini');
  const text = `before\n\n${b}\n\nafter\n`;
  assert.equal(upsertPairBlock(text, b), text);
  assert.equal(removePairBlock(text), 'before\n\nafter\n');
});

test('block: an unmatched marker is reported broken', () => {
  assert.ok(pairBlockIsBroken(`x\n${PAIR_BLOCK_START}\ny\n`));
  assert.ok(!pairBlockIsBroken(pairBlock('codex')));
});

test('toml: upsert adds a table, replaces only that table, remove leaves the rest', () => {
  const orig = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.tablation]\nurl = "old"\n\n[profiles.a]\nk = 1\n';
  const next = upsertTomlTable(orig, 'mcp_servers.tablation', codexTable(URL));
  assert.match(next, /\[mcp_servers\.tablation\]\nurl = "https:\/\/app\.example\.test\/api\/mcp"\nbearer_token_env_var = "CREW_API_KEY"\n\n\[profiles\.a\]/);
  assert.ok(next.startsWith('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n'));
  const gone = removeTomlTable(next, 'mcp_servers.tablation');
  assert.equal(gone, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.a]\nk = 1\n');
  assert.equal(upsertTomlTable('', 'mcp_servers.tablation', codexTable(URL)), `${codexTable(URL).join('\n')}\n`);
  assert.equal(removeTomlTable(codexTable(URL).join('\n') + '\n', 'mcp_servers.tablation'), '');
});

test('codex: install twice changes nothing, key never written, foreign config kept, disconnect removes only ours', () => {
  const h = home();
  put(h, '.codex/AGENTS.md', '# Mine\n');
  put(h, '.codex/config.toml', 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  assert.match(codexPair.installPair({ home: h, url: URL, key: 'sk_secret' }), /installed/);
  const a1 = read(h, '.codex/AGENTS.md'), c1 = read(h, '.codex/config.toml');
  assert.match(codexPair.installPair({ home: h, url: URL, key: 'sk_secret' }), /already installed/);
  assert.equal(read(h, '.codex/AGENTS.md'), a1);
  assert.equal(read(h, '.codex/config.toml'), c1);
  assert.ok(!a1.includes('sk_secret') && !c1.includes('sk_secret'));
  assert.match(c1, /bearer_token_env_var = "CREW_API_KEY"/);
  assert.deepEqual(codexPair.verifyPair({ home: h, url: URL }), { ok: true, detail: join(h, '.codex/AGENTS.md') + ', ' + join(h, '.codex/config.toml') });
  codexPair.removePair({ home: h, url: URL });
  assert.equal(read(h, '.codex/AGENTS.md'), '# Mine\n');
  assert.equal(read(h, '.codex/config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  assert.equal(codexPair.verifyPair({ home: h, url: URL }).ok, false);
  assert.match(codexPair.removePair({ home: h, url: URL }), /nothing to remove/);
});

test('codex: a different tablation server is left alone unless replace; dry run writes nothing', () => {
  const h = home();
  put(h, '.codex/config.toml', '[mcp_servers.tablation]\nurl = "http://localhost:3000/api/mcp"\n');
  const msg = codexPair.installPair({ home: h, url: URL });
  assert.match(msg, /left .* alone/);
  assert.ok(!existsSync(join(h, '.codex/AGENTS.md')));
  assert.equal(codexPair.verifyPair({ home: h, url: URL }).ok, false);
  codexPair.installPair({ home: h, url: URL, replace: true, dryRun: true });
  assert.match(read(h, '.codex/config.toml'), /localhost:3000/);
  codexPair.installPair({ home: h, url: URL, replace: true });
  assert.ok(codexPair.verifyPair({ home: h, url: URL }).ok);
});

test('codex: files this install created are deleted again by disconnect', () => {
  const h = home();
  codexPair.installPair({ home: h, url: URL });
  codexPair.removePair({ home: h, url: URL });
  assert.ok(!existsSync(join(h, '.codex/AGENTS.md')));
  assert.ok(!existsSync(join(h, '.codex/config.toml')));
});

test('gemini: JSON round-trip keeps the operator\'s other keys and servers; env var only; idempotent', () => {
  const h = home();
  put(h, '.gemini/settings.json', JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
  put(h, '.gemini/GEMINI.md', 'Be terse.\n');
  geminiPair.installPair({ home: h, url: URL, key: 'sk_secret' });
  const s1 = read(h, '.gemini/settings.json'), g1 = read(h, '.gemini/GEMINI.md');
  assert.ok(!s1.includes('sk_secret') && !g1.includes('sk_secret'));
  const j = JSON.parse(s1);
  assert.deepEqual(j.mcpServers.tablation, { httpUrl: URL, headers: { Authorization: 'Bearer $CREW_API_KEY' } });
  assert.deepEqual(j.mcpServers.other, { command: 'x' });
  assert.equal(j.theme, 'dark');
  assert.match(geminiPair.installPair({ home: h, url: URL }), /already installed/);
  assert.equal(read(h, '.gemini/settings.json'), s1);
  assert.ok(geminiPair.verifyPair({ home: h, url: URL }).ok);
  geminiPair.removePair({ home: h, url: URL });
  assert.deepEqual(JSON.parse(read(h, '.gemini/settings.json')), { theme: 'dark', mcpServers: { other: { command: 'x' } } });
  assert.equal(read(h, '.gemini/GEMINI.md'), 'Be terse.\n');
});

test('gemini: a settings.json that is not an object is never overwritten', () => {
  const h = home();
  put(h, '.gemini/settings.json', '{ not json');
  assert.match(geminiPair.installPair({ home: h, url: URL }), /not a JSON object/);
  assert.equal(read(h, '.gemini/settings.json'), '{ not json');
});

test('gemini: a first install on an empty home, then disconnect, leaves nothing behind', () => {
  const h = home();
  geminiPair.installPair({ home: h, url: URL });
  geminiPair.removePair({ home: h, url: URL });
  assert.ok(!existsSync(join(h, '.gemini/settings.json')));
  assert.ok(!existsSync(join(h, '.gemini/GEMINI.md')));
});

test('registry and prompt note', () => {
  assert.ok(isPairHarness('claude') && isPairHarness('codex') && isPairHarness('gemini'));
  assert.ok(isPairHarness('copilot') && !isPairHarness('nope'));
  assert.match(harnessPromptNote('codex'), /Codex/);
  assert.equal(harnessPromptNote('nope'), '');
  assert.equal(harnessPromptNote(undefined), '');
});

test('codex: disconnect leaves a tablation server it did not add, but still removes the managed block', () => {
  const h = home();
  const foreign = '[mcp_servers.tablation]\nurl = "https://app.tablation.com/api/mcp"\nbearer_token_env_var = "OLD"\n';
  put(h, '.codex/config.toml', foreign);
  put(h, '.codex/AGENTS.md', `${pairBlock('codex')}\n`);
  const msg = codexPair.removePair({ home: h, url: URL });
  assert.match(msg, /left the existing tablation server alone/);
  assert.equal(read(h, '.codex/config.toml'), foreign);
  assert.ok(!existsSync(join(h, '.codex/AGENTS.md')));
});

test('codex: removing our server also removes its sub-tables, not a sibling', () => {
  const h = home();
  codexPair.installPair({ home: h, url: URL });
  const p = join(h, '.codex/config.toml');
  writeFileSync(p, `${readFileSync(p, 'utf8')}\n[mcp_servers.tablation.env]\nX = "1"\n\n[mcp_servers.other]\nurl = "http://o"\n`);
  codexPair.removePair({ home: h, url: URL });
  assert.equal(read(h, '.codex/config.toml'), '[mcp_servers.other]\nurl = "http://o"\n');
});

test('gemini: disconnect leaves a tablation server it did not add', () => {
  const h = home();
  const foreign = `${JSON.stringify({ mcpServers: { tablation: { httpUrl: 'http://localhost:3000/api/mcp' } } }, null, 2)}\n`;
  put(h, '.gemini/settings.json', foreign);
  put(h, '.gemini/GEMINI.md', `${pairBlock('gemini')}\n`);
  const msg = geminiPair.removePair({ home: h, url: URL });
  assert.match(msg, /left the existing tablation server alone/);
  assert.equal(read(h, '.gemini/settings.json'), foreign);
  assert.ok(!existsSync(join(h, '.gemini/GEMINI.md')));
});

// ── Copilot (VS Code) ───────────────────────────────────────────────────────

const MAC = 'Library/Application Support/Code/User';
const INSIDERS = 'Library/Application Support/Code - Insiders/User';
const copilotOpts = (h: string) => ({ home: h, url: URL, platform: 'darwin' as const });

test('copilot: install is idempotent, keeps other servers and inputs, never writes the key', () => {
  const h = home();
  put(h, `${MAC}/mcp.json`, JSON.stringify({ inputs: [{ id: 'x' }], servers: { other: { type: 'stdio', command: 'x' } } }));
  const first = copilotPair.installPair({ ...copilotOpts(h), key: 'sk_secret' });
  assert.match(first, /installed the Pair instructions/);
  const mcp = JSON.parse(read(h, `${MAC}/mcp.json`));
  assert.deepEqual(mcp.servers.tablation, { type: 'http', url: URL, headers: { Authorization: 'Bearer ${env:CREW_API_KEY}' } });
  assert.deepEqual(mcp.inputs, [{ id: 'x' }]);
  assert.ok(mcp.servers.other);
  assert.ok(!read(h, `${MAC}/mcp.json`).includes('sk_secret'));
  const instr = read(h, `${MAC}/prompts/crew-pair.instructions.md`);
  assert.ok(instr.startsWith('---\napplyTo: "**"\n---'));
  assert.ok(instr.includes('crew agents prompt pair --harness copilot'));
  const snapshot = [read(h, `${MAC}/mcp.json`), instr];
  assert.match(copilotPair.installPair(copilotOpts(h)), /already installed/);
  assert.deepEqual([read(h, `${MAC}/mcp.json`), read(h, `${MAC}/prompts/crew-pair.instructions.md`)], snapshot);
  assert.equal(Object.keys(JSON.parse(read(h, `${MAC}/mcp.json`)).servers).length, 2);
  assert.deepEqual(copilotPair.verifyPair(copilotOpts(h)).ok, true);
});

test('copilot: remove takes out exactly what install added', () => {
  const h = home();
  put(h, `${MAC}/mcp.json`, JSON.stringify({ servers: { other: { type: 'stdio', command: 'x' } } }));
  copilotPair.installPair(copilotOpts(h));
  assert.match(copilotPair.removePair(copilotOpts(h)), /removed the Pair instructions and tablation server/);
  assert.deepEqual(JSON.parse(read(h, `${MAC}/mcp.json`)), { servers: { other: { type: 'stdio', command: 'x' } } });
  assert.ok(!existsSync(join(h, MAC, 'prompts', 'crew-pair.instructions.md')));
  assert.equal(copilotPair.verifyPair(copilotOpts(h)).ok, false);
  assert.match(copilotPair.removePair(copilotOpts(h)), /nothing to remove/);
});

test('copilot: removing from a fresh install deletes both files; operator text in the instructions file survives', () => {
  const h = home();
  copilotPair.installPair(copilotOpts(h));
  copilotPair.removePair(copilotOpts(h));
  assert.ok(!existsSync(join(h, MAC, 'mcp.json')));
  assert.ok(!existsSync(join(h, MAC, 'prompts', 'crew-pair.instructions.md')));
  const h2 = home();
  const p = put(h2, `${MAC}/prompts/crew-pair.instructions.md`, '---\napplyTo: "**"\n---\n\nMy own rule.\n');
  copilotPair.installPair(copilotOpts(h2));
  copilotPair.removePair(copilotOpts(h2));
  assert.equal(readFileSync(p, 'utf8'), '---\napplyTo: "**"\n---\n\nMy own rule.\n');
});

test('copilot: a different tablation server is left alone unless replace; comments in mcp.json block the write', () => {
  const h = home();
  const other = JSON.stringify({ servers: { tablation: { type: 'http', url: 'https://elsewhere/api/mcp' } } });
  put(h, `${MAC}/mcp.json`, other);
  assert.match(copilotPair.installPair(copilotOpts(h)), /left .* alone/);
  assert.equal(read(h, `${MAC}/mcp.json`), other);
  assert.match(copilotPair.removePair(copilotOpts(h)), /left the existing tablation server alone/);
  assert.equal(read(h, `${MAC}/mcp.json`), other);
  copilotPair.installPair({ ...copilotOpts(h), replace: true });
  assert.equal(JSON.parse(read(h, `${MAC}/mcp.json`)).servers.tablation.url, URL);
  const h2 = home();
  const jsonc = '// mine\n{ "servers": {} }\n';
  put(h2, `${MAC}/mcp.json`, jsonc);
  assert.match(copilotPair.installPair(copilotOpts(h2)), /not a plain JSON object/);
  assert.equal(read(h2, `${MAC}/mcp.json`), jsonc);
});

test('copilot: Insiders is installed too when present; Linux and dry-run paths', () => {
  const h = home();
  mkdirSync(join(h, MAC), { recursive: true });
  mkdirSync(join(h, INSIDERS), { recursive: true });
  copilotPair.installPair(copilotOpts(h));
  assert.ok(existsSync(join(h, INSIDERS, 'mcp.json')));
  assert.ok(existsSync(join(h, MAC, 'prompts', 'crew-pair.instructions.md')));
  const h2 = home();
  assert.match(copilotPair.installPair({ home: h2, url: URL, platform: 'linux', dryRun: true }), /dry run/);
  assert.ok(!existsSync(join(h2, '.config')));
  copilotPair.installPair({ home: h2, url: URL, platform: 'linux' });
  assert.ok(existsSync(join(h2, '.config/Code/User/mcp.json')));
});

test('copilot: warns on macOS when the login environment lacks the key', () => {
  const base = { url: URL, platform: 'darwin' as const };
  assert.match(copilotPair.envWarning!({ ...base, loginEnv: () => undefined })!, /launchctl setenv CREW_API_KEY/);
  assert.equal(copilotPair.envWarning!({ ...base, loginEnv: () => 'sk_x' }), undefined);
  assert.equal(copilotPair.envWarning!({ url: URL, platform: 'linux' }), undefined);
  assert.ok(isPairHarness('copilot'));
});
