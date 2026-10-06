import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaserFor, nonReleaserNote, missingReleaserWarning } from '../src/release-ship.ts';
import type { ShipRow } from '../src/tracker.ts';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ship = (name: string, hoursAgo: number): ShipRow =>
  ({ id: name, name, last_seen: new Date(NOW - hoursAgo * 3_600_000).toISOString() }) as ShipRow;

test('a repo with no release.ship lets every ship release', () => {
  assert.deepEqual(releaserFor({ ship: null, mode: 'local' }, 'Studio'), { releases: true, releaser: null });
});

test('only the named ship releases a local or integrate repo; others are told who does', () => {
  assert.equal(releaserFor({ ship: 'Mini', mode: 'local' }, 'Mini').releases, true);
  const other = releaserFor({ ship: 'Mini', mode: 'integrate' }, 'Studio');
  assert.equal(other.releases, false);
  assert.equal(nonReleaserNote('crew', other.releaser as string), 'release for crew runs on Mini');
});

test('CI-mode repos keep multi-ship releasing even if a ship is named', () => {
  assert.equal(releaserFor({ ship: 'Mini', mode: 'ci_auto' }, 'Studio').releases, true);
});

test('doctor warns for a local repo with no releaser when several ships were seen in the last day', () => {
  const ships = [ship('Mini', 1), ship('Studio', 5), ship('Old', 72)];
  const w = missingReleaserWarning('crew', { ship: null, mode: 'local' }, ships, NOW);
  assert.match(w ?? '', /crew: .*2 ships seen in the last day \(Mini, Studio\)/);
});

test('no warning with one live ship, a named releaser, or a CI-mode repo', () => {
  assert.equal(missingReleaserWarning('crew', { ship: null, mode: 'local' }, [ship('Mini', 1), ship('Old', 72)], NOW), null);
  assert.equal(missingReleaserWarning('crew', { ship: 'Mini', mode: 'local' }, [ship('A', 1), ship('B', 1)], NOW), null);
  assert.equal(missingReleaserWarning('crew', { ship: null, mode: 'ci_auto' }, [ship('A', 1), ship('B', 1)], NOW), null);
});
