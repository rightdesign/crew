import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkGuards, planMerge, requestedBump, renderChangelogSection,
  insertChangelogSection, decideRelease, renderTag, describeUnplaceable,
} from '../src/release.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { branchForIssue } from '../src/git.ts';
import type { Ticket } from '../src/tracker.ts';
import { resolveRepoConfig } from '../src/repo-config.ts';
import { existingBranchForTicket } from '../src/ticket-branch.ts';

/** A real repository — the guards are about git's actual behaviour. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-git-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '.');
  g('commit', '-qm', 'initial');
  return { dir, g };
}

const T = (issue_id: string, over: Partial<Ticket> = {}): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z', ...over }) as Ticket;

test('a checkout not on main is refused, by name', () => {
  const { dir, g } = repo();
  g('checkout', '-qb', 'wip');
  const b = checkGuards(dir);
  assert.equal(b?.kind, 'branch');
  assert.match(b!.detail, /on 'wip', not main/);
});

test('a clean main passes', () => {
  const { dir } = repo();
  assert.equal(checkGuards(dir), null);
});

test('a dirty tree is refused and the files are NAMED, not just counted', () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'scratch.md'), 'x');       // untracked — the surprising case
  writeFileSync(join(dir, 'README.md'), 'changed');  // modified
  const b = checkGuards(dir);
  assert.equal(b?.kind, 'dirty');
  assert.match(b!.detail, /2 change\(s\)/);
  assert.match(b!.detail, /1 untracked/);
  assert.match(b!.detail, /scratch\.md|README\.md/);  // the ten-second fix
});

test('more than three changes are summarised without hiding the count', () => {
  const { dir } = repo();
  for (const n of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(dir, `${n}.txt`), 'x');
  assert.match(checkGuards(dir)!.detail, /5 change\(s\).*\+2 more/);
});

test('a branch is found whether or not the issue number was zero-padded', () => {
  const { dir, g } = repo();
  g('branch', 'issue-45');
  assert.equal(branchForIssue(dir, 'ISSUE-045'), 'issue-45');
  assert.equal(branchForIssue(dir, 'ISSUE-45'), 'issue-45');
  assert.equal(branchForIssue(dir, 'ISSUE-99'), null);
});

test('Changelog: lines are read off the branch before the squash flattens it', () => {
  const { dir, g } = repo();
  g('checkout', '-qb', 'issue-7');
  writeFileSync(join(dir, 'f.txt'), '1');
  g('add', '.');
  g('commit', '-qm', 'work\n\nChangelog: Records can now be starred\nBump: minor');
  g('checkout', '-q', 'main');
  const [c] = planMerge(dir, [T('ISSUE-7')], DEFAULT_CONTRACT, null);
  assert.equal(c!.branch, 'issue-7');
  assert.deepEqual(c!.entries, ['Records can now be starred']);
  assert.equal(c!.usedFallback, false);
});

test('a branch with no Changelog: line falls back to the ticket title, and says so', () => {
  const { dir, g } = repo();
  g('checkout', '-qb', 'issue-8');
  writeFileSync(join(dir, 'g.txt'), '1');
  g('add', '.');
  g('commit', '-qm', 'just a commit');
  g('checkout', '-q', 'main');
  const [c] = planMerge(dir, [T('ISSUE-8', { title: 'Fixed the thing' })], DEFAULT_CONTRACT, null);
  assert.deepEqual(c!.entries, ['Fixed the thing (ISSUE-8)']);
  assert.equal(c!.usedFallback, true);
});

test('verified with no branch: already-merged and never-built are told apart', () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, 'h.txt'), '1');
  g('add', '.');
  g('commit', '-qm', 'shipped ISSUE-10 earlier');
  const last = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim();
  const plan = planMerge(dir, [T('ISSUE-10'), T('ISSUE-11')], DEFAULT_CONTRACT, last);
  assert.equal(plan[0]!.skipReason, 'already-merged');  // named in a commit past the last release
  assert.equal(plan[1]!.skipReason, 'never-built');     // nobody wrote code for it
});

test('merges are ordered oldest ticket first', () => {
  const { dir, g } = repo();
  for (const n of [30, 4, 12]) g('branch', `issue-${n}`);
  const plan = planMerge(dir, [T('ISSUE-30'), T('ISSUE-4'), T('ISSUE-12')], DEFAULT_CONTRACT, null);
  assert.deepEqual(plan.map((c) => c.ticket.issue_id), ['ISSUE-4', 'ISSUE-12', 'ISSUE-30']);
});

test('major is never reachable from a commit message — it is the operator\'s call', () => {
  assert.deepEqual(requestedBump('Bump: patch'), { size: 'patch', majorRequested: false });
  assert.deepEqual(requestedBump('Bump: minor'), { size: 'minor', majorRequested: false });
  assert.deepEqual(requestedBump('nothing here'), { size: 'patch', majorRequested: false });
  // honoured as minor AND reported, rather than silently treated as patch
  assert.deepEqual(requestedBump('Bump: major'), { size: 'minor', majorRequested: true });
});

test('the strongest bump across several branches wins', () => {
  assert.equal(requestedBump('Bump: patch\n---\nBump: minor').size, 'minor');
});

test('a changelog section is Keep-a-Changelog style, newest first', () => {
  const section = renderChangelogSection('0.58.0', '2026-08-23', ['Thing one', 'Thing two']);
  assert.match(section, /^## \[0\.58\.0\] — 2026-08-23\n\n- Thing one\n- Thing two\n$/);
  const existing = '# Changelog\n\nSome preamble.\n\n## [0.57.1] — 2026-08-22\n\n- Older\n';
  const out = insertChangelogSection(existing, section);
  assert.ok(out.indexOf('## [0.58.0]') < out.indexOf('## [0.57.1]'));
  assert.ok(out.startsWith('# Changelog'));
});

test('a changelog with no releases yet is appended to, not corrupted', () => {
  const out = insertChangelogSection('# Changelog\n', renderChangelogSection('0.1.0', 'd', ['First']));
  assert.match(out, /^# Changelog\n\n## \[0\.1\.0\]/);
});

test('a prose section above the releases is not split open', () => {
  // The project's real CHANGELOG.md has "## How this file is maintained"
  // before any release. Anchoring on the first `##` inserted the new release
  // between that heading and its body.
  const existing = [
    '# Changelog', '', 'Preamble.', '',
    '## How this file is maintained', '', 'Some rules.', '',
    '## [1.0.0] — 2026-01-01', '', '- Old', '',
  ].join('\n');
  const out = insertChangelogSection(existing, renderChangelogSection('1.1.0', 'd', ['New']));
  assert.ok(out.indexOf('## How this file is maintained') < out.indexOf('## [1.1.0]'));
  assert.ok(out.indexOf('Some rules.') < out.indexOf('## [1.1.0]'));
  assert.ok(out.indexOf('## [1.1.0]') < out.indexOf('## [1.0.0]'));
});

test('an Unreleased section at the top keeps its place, and the release goes below', () => {
  const existing = ['# Changelog', '', '## [Unreleased]', '', '- Pending thing', '',
    '## [1.0.0] — 2026-01-01', '', '- Old', ''].join('\n');
  const out = insertChangelogSection(existing, renderChangelogSection('1.1.0', 'd', ['New']));
  assert.ok(out.indexOf('## [Unreleased]') < out.indexOf('## [1.1.0]'));
  assert.ok(out.indexOf('- Pending thing') < out.indexOf('## [1.1.0]'));
  assert.ok(out.indexOf('## [1.1.0]') < out.indexOf('## [1.0.0]'));
});

test('a STALE Unreleased section buried below the releases is ignored', () => {
  // The project's real file has one 600 lines down. Preferring it would put
  // every new release in the middle of the history.
  const existing = ['# Changelog', '',
    '## [2.0.0] — 2026-02-01', '', '- Recent', '',
    '## [Unreleased]', '', '- ancient note', '',
    '## [1.0.0] — 2026-01-01', '', '- Old', ''].join('\n');
  const out = insertChangelogSection(existing, renderChangelogSection('2.1.0', 'd', ['New']));
  assert.ok(out.indexOf('## [2.1.0]') < out.indexOf('## [2.0.0]'), 'must go to the top');
  assert.ok(out.indexOf('## [2.1.0]') < out.indexOf('## [Unreleased]'));
});

test('the whole decision is made without touching the checkout', () => {
  const { dir, g } = repo();
  g('branch', 'issue-5');
  const d = decideRelease(dir, [T('ISSUE-5')], DEFAULT_CONTRACT);
  assert.equal(d.block, null);
  assert.equal(d.merges.length, 1);
  assert.equal(d.lastTag, null);           // never released
  assert.equal(d.unseeded, true);          // and must not treat all history as unreleased
  assert.equal(checkGuards(dir), null);    // the tree is still clean
});

test('the last release comes from a tag — durable and shareable, not a private ref', () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, 'a.txt'), '1'); g('add', '.'); g('commit', '-qm', 'Release v1.0.0');
  g('tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0');
  writeFileSync(join(dir, 'b.txt'), '1'); g('add', '.'); g('commit', '-qm', 'later work');

  const d = decideRelease(dir, [], DEFAULT_CONTRACT);
  assert.equal(d.lastTag, 'v1.0.0');
  assert.equal(d.unseeded, false);
  assert.equal(d.unreleasedCommits, 1);
  assert.equal(d.upToDate, false);
});

test('an unseeded repo is flagged rather than treated as all-unreleased', () => {
  const { dir } = repo();
  const d = decideRelease(dir, [], DEFAULT_CONTRACT);
  assert.equal(d.unseeded, true);
  assert.equal(d.unreleasedCommits, 0);   // NOT "every commit in history"
});

test('a custom tag pattern is honoured', () => {
  const { dir, g } = repo();
  g('tag', '-a', 'release-2.0', '-m', 'r');
  assert.equal(decideRelease(dir, [], DEFAULT_CONTRACT, { tagPattern: 'v*' }).lastTag, null);
  assert.equal(decideRelease(dir, [], DEFAULT_CONTRACT, { tagPattern: 'release-*' }).lastTag, 'release-2.0');
});

test('renderTag substitutes only the version', () => {
  assert.equal(renderTag('v{version}', '1.2.3'), 'v1.2.3');
  assert.equal(renderTag('release-{version}', '1.2.3'), 'release-1.2.3');
});

test('the integration branch is not assumed to be main', () => {
  const { dir, g } = repo();
  g('branch', '-m', 'main', 'develop');       // an org that integrates on develop
  assert.equal(checkGuards(dir)!.kind, 'branch');            // refused against the default
  assert.match(checkGuards(dir)!.detail, /on 'develop', not main/);
  assert.equal(checkGuards(dir, 'develop'), null);           // fine once told
  assert.equal(decideRelease(dir, [], DEFAULT_CONTRACT, { base: 'develop' }).block, null);
});

test('changelog lines are read against the configured base, not main', () => {
  const { dir, g } = repo();
  g('branch', '-m', 'main', 'master');
  g('checkout', '-qb', 'issue-3');
  writeFileSync(join(dir, 'x.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'work\n\nChangelog: Did a thing');
  g('checkout', '-q', 'master');
  const [c] = planMerge(dir, [T('ISSUE-3')], DEFAULT_CONTRACT, null,
    (t) => branchForIssue(dir, t.issue_id), 'master');
  assert.deepEqual(c!.entries, ['Did a thing']);   // would be empty against a nonexistent `main`
});

// ISSUE-351. Three states were one list, reported with a sentence true of
// only the first — so a well-formed ticket for another ship's repository
// warned, every cycle, that it "names no repository".
const stranded = (issue_id: string, reason: string, repo?: string) =>
  ({ ticket: { issue_id, status: 'verified' } as never, reason, repo });

test('each unplaceable state is reported in words that are true of it', () => {
  const notes = describeUnplaceable(
    [
      stranded('ISSUE-1', 'no-repo'),
      stranded('ISSUE-2', 'unknown-repo'),
      stranded('ISSUE-3', 'not-served-here', 'crew'),
      stranded('ISSUE-4', 'not-served-here', 'crew'),
    ],
    'verified',
  );
  const warn = notes.filter((n) => n.level === 'warn');
  assert.equal(warn.length, 2);
  assert.match(warn[0]!.message, /ISSUE-1/);
  assert.match(warn[0]!.message, /name no repository/);
  // A stale repo list is a config problem with its own fix, not a board problem.
  assert.match(warn[1]!.message, /ISSUE-2/);
  assert.match(warn[1]!.message, /crew connect/);

  // The correct state is reported once, plainly, and never as a warning.
  const info = notes.filter((n) => n.level === 'info');
  assert.equal(info.length, 1);
  assert.match(info[0]!.message, /another ship releases them/);
  assert.match(info[0]!.message, /crew \(ISSUE-3, ISSUE-4\)/);
  assert.doesNotMatch(info[0]!.message, /ISSUE-1|ISSUE-2/);
});

test('a repository this ship does not serve produces no warning at all', () => {
  const notes = describeUnplaceable([stranded('ISSUE-9', 'not-served-here', 'crew')], 'verified');
  assert.deepEqual(notes.filter((n) => n.level === 'warn'), []);
});

test('only verified tickets are reported — an open one is nobody\'s release problem', () => {
  const notes = describeUnplaceable(
    [{ ticket: { issue_id: 'ISSUE-5', status: 'accepted' } as never, reason: 'no-repo' }],
    'verified',
  );
  assert.deepEqual(notes, []);
});

// ISSUE-977. The digest found `tabl-961`, QA verified it, and then the
// release phase — still looking only for `issue-961` — called it stranded
// and bounced it to a person. Twelve tickets in one afternoon.
test('decideRelease finds a tagged ticket on its {prefix}-{number} branch', () => {
  const { dir, g } = repo();
  g('checkout', '-qb', 'tabl-961');
  writeFileSync(join(dir, 'x.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'work\n\nChangelog: Moved the launcher (TABL-961)');
  g('checkout', '-q', 'main');
  const ticket = T('ISSUE-961', { issue_tag: 'TABL-961', project_issue_prefix: 'TABL' });
  const cfg = resolveRepoConfig(null, undefined, dir);

  const bare = decideRelease(dir, [ticket], DEFAULT_CONTRACT);
  assert.equal(bare.merges[0]!.branch, null);   // the bug, pinned: the default lookup cannot see it

  const d = decideRelease(dir, [ticket], DEFAULT_CONTRACT, {
    branchFor: (t) => existingBranchForTicket(dir, cfg, t),
  });
  assert.equal(d.merges[0]!.branch, 'tabl-961');
  assert.deepEqual(d.merges[0]!.entries, ['Moved the launcher (TABL-961)']);
});

test('existingBranchForTicket: an untagged ticket still resolves to issue-{number}', () => {
  const { dir, g } = repo();
  g('branch', 'issue-12');
  assert.equal(existingBranchForTicket(dir, resolveRepoConfig(null, undefined, dir), T('ISSUE-12')), 'issue-12');
});

// CREW-1327. A branch survives its own squash-merge until the stamp; once a
// later commit deleted a file it added, replaying the squash conflicted and
// bounced a ticket whose work was live.
test('a branch already squash-merged stays already-merged after later commits touch its files', () => {
  const { dir, g } = repo();
  const last = g('rev-parse', 'HEAD').toString().trim();
  g('checkout', '-qb', 'issue-20');
  writeFileSync(join(dir, 'bind.txt'), 'v1\n'); g('add', '.');
  g('commit', '-qm', 'work\n\nChangelog: Bind');
  g('checkout', '-q', 'main');
  g('merge', '--squash', 'issue-20');
  g('commit', '-qm', 'Bind (ISSUE-20)\n\nCloses ISSUE-20.');
  g('rm', '-q', 'bind.txt');
  g('commit', '-qm', 'unrelated: delete the file');
  const [c] = planMerge(dir, [T('ISSUE-20')], DEFAULT_CONTRACT, last);
  assert.equal(c!.skipReason, 'already-merged');
  assert.ok(c!.mergedSha);
});

test('an unmerged branch whose ticket is named by an unrelated commit is still merged', () => {
  const { dir, g } = repo();
  const last = g('rev-parse', 'HEAD').toString().trim();
  g('checkout', '-qb', 'issue-21');
  writeFileSync(join(dir, 'k.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'work\n\nChangelog: K');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'other.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'mentions ISSUE-21 in passing');
  const [c] = planMerge(dir, [T('ISSUE-21')], DEFAULT_CONTRACT, last);
  assert.equal(c!.branch, 'issue-21');
});
