import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoctorReport, renderDoctor, verdictLine, fixPhaseNothingToOffer } from '../src/doctor-report.ts';

const HEAD = ['ship Mini (macos) · route a/b · crew 1.0.0'];

function clean(): DoctorReport {
  const r = new DoctorReport();
  r.line('ship:              Mini (macos)\nroutes:            a/b\n');
  r.line('contract:          consistent\n');
  r.line('git:               OK (/usr/bin/git)\n');
  return r;
}

test('a clean route prints the header, the passed count and an all-clear verdict', () => {
  const out = renderDoctor(clean(), HEAD, false);
  assert.match(out, /^ship Mini/);
  assert.match(out, /4 checks passed/);
  assert.match(out, /verdict: all clear/);
  assert.ok(out.trimEnd().split('\n').length < 6);
});

test('findings are listed most severe first, healthy checks are hidden', () => {
  const r = clean();
  r.line('role concurrency: WARN too high\n');
  r.line('bundle:            BLOCKER stale bundle — run `npm run build`\n');
  r.line('authorship:       missing filed_by_id — update the Issues template\n');
  r.line('daemon config:     WARN crew.yaml changed — run `crew reload`\n');
  const out = renderDoctor(r, HEAD, false);
  const lines = out.split('\n');
  const idx = (s: string) => lines.findIndex((l) => l.includes(s));
  assert.ok(idx('stale bundle') < idx('too high'));
  assert.ok(idx('too high') < idx('authorship') || idx('crew.yaml changed') < idx('authorship'));
  assert.match(out, /run `npm run build`/);
  assert.doesNotMatch(out, /contract/);
  assert.match(out, /verdict: needs action — 1 blocker, 2 warnings, 1 note/);
  assert.ok(out.trimEnd().endsWith(lines.filter(Boolean).at(-1)!));
});

test('the same warning on three repositories prints once, naming them', () => {
  const r = new DoctorReport();
  for (const name of ['alpha', 'beta', 'gamma']) {
    r.repo = name;
    r.line(`repo ${name}:         /x/${name}\n                   WARNING no release ship named\n`);
    r.line('                   base main: ERROR — diverged\n');
  }
  r.repo = undefined;
  const out = renderDoctor(r, HEAD, false);
  assert.equal(out.split('\n').filter((l) => l.includes('no release ship named')).length, 1);
  assert.match(out, /alpha, beta, gamma/);
  assert.match(out, /1 blocker/);
});

test('verdict wording: warnings only, notes only', () => {
  assert.match(verdictLine({ blocker: 0, warning: 2, note: 0, passed: 4 }), /usable, with warnings — 2 warnings; 4 checks passed/);
  assert.match(verdictLine({ blocker: 0, warning: 0, note: 1, passed: 1 }), /ok, with notes — 1 note; 1 check passed/);
  assert.match(verdictLine({ blocker: 1, warning: 0, note: 0, passed: 0 }), /needs action — 1 blocker/);
});

test('--verbose keeps every check under section headings, labels always separated', () => {
  const r = clean();
  r.line('a very long label here that goes: WARN something\n');
  r.line('seat identity:    dev writes as the ship\n');
  r.line('host passengers:   off\n');
  const out = renderDoctor(r, HEAD, true);
  for (const s of ['Ship', 'Tracker', 'Seats', 'Tools', 'Periscopes, passengers and sandbox']) assert.match(out, new RegExp(`^${s}$`, 'm'));
  for (const l of ['routes:', 'contract:', 'git:', 'seat identity:', 'host passengers:']) assert.ok(out.includes(l), l);
  for (const line of out.split('\n')) assert.doesNotMatch(line, /\w:\S/, line);
  assert.match(out.trimEnd().split('\n').at(-1)!, /^verdict:/);
});

test('fix phase: silent without --fix, explicit with it', () => {
  assert.deepEqual(fixPhaseNothingToOffer({ notes: [], fixFlag: false, blockers: 1, warnings: 2 }), []);
  assert.deepEqual(fixPhaseNothingToOffer({ notes: ['n1'], fixFlag: false, blockers: 0, warnings: 0 }), ['fix: n1']);
  assert.match(fixPhaseNothingToOffer({ notes: [], fixFlag: true, blockers: 1, warnings: 2 }).join(), /no automatic fix applies; the 3 findings above need action/);
  assert.match(fixPhaseNothingToOffer({ notes: [], fixFlag: true, blockers: 0, warnings: 0 }).join(), /nothing needs one/);
});

// QA bounce: the real multi-line shape of a repository block, without setting `repo` by hand.
test('a severity-marked line after a healthy base line is its own finding', () => {
  const r = new DoctorReport();
  for (const name of ['alpha', 'beta']) {
    r.repo = name;
    r.line(`${`repo ${name}:`.padEnd(19)}/work/${name}\n                   worktrees at ../x\n`);
    r.line('                   base main: main is level with origin/main\n');
    r.line(`                   WARNING ${name}: release.mode "integrate" with no release.ship\n`);
  }
  r.repo = undefined;
  const out = renderDoctor(r, HEAD, false);
  assert.doesNotMatch(out, /level with origin/);
  const warnings = out.split('\n').filter((l) => /^WARNING/.test(l));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\[repositories alpha, beta\]/);
});

test('per-repository notes outside a repo block group by the repository they name, with one marker', () => {
  const r = new DoctorReport();
  r.repoNames = ['alpha', 'beta', 'gamma'];
  for (const n of r.repoNames) r.line(`periscopes:      NOTE issues/issues/${n}: hostPeriscopes is on but ${n} declares no \`preview\` hook\n`);
  for (const n of r.repoNames) r.line(`pull requests:    discovery unavailable for ${n}: no forge token stored for github.com\n`);
  const out = renderDoctor(r, HEAD, false);
  const notes = out.split('\n').filter((l) => /^NOTE/.test(l));
  assert.equal(notes.length, 2);
  assert.doesNotMatch(notes[0]!, /NOTE.*NOTE/);
  assert.match(out, /verdict: ok, with notes — 2 notes/);
});

test('--verbose separates a long label from its value and lists each repository under its own heading', () => {
  const r = new DoctorReport();
  r.repo = 'crew-host-image';
  r.line(`${'repo crew-host-image:'.padEnd(19)}/Users/brad/crew-host-image\n`);
  r.line('                   release self-repair: off\n');
  r.repo = undefined;
  const out = renderDoctor(r, HEAD, true);
  assert.match(out, /\n {2}crew-host-image\n/);
  assert.doesNotMatch(out, /:\/Users/);
  for (const l of out.split('\n').filter((x) => /: /.test(x) && /^\s{4}/.test(x))) assert.match(l, /\S:\s+\S/);
});

test('ship-attention items (lowercase `attention:` label) are warnings and shown by default', () => {
  const r = new DoctorReport();
  r.line('attention:         worktree_held — synthesis: worktree /x/tabl-2124 is not swept: uncommitted changes (since 2026-11-12)\n');
  r.line('attention:         noop_runs — TABL-3153: dev run ended 2 times in a row with nothing pushed (since 2026-11-12)\n');
  const out = renderDoctor(r, HEAD, false);
  assert.match(out, /worktree_held/);
  assert.match(out, /noop_runs/);
  assert.match(out, /verdict: usable, with warnings — 2 warnings/);
});
