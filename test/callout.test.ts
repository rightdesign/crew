import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calloutHeader } from '../src/callout.ts';
import { FAILURE_ALERT_MARKER } from '../src/failure-alert.ts';
import { BUILD_FAILURE_MARKER } from '../src/build-failure.ts';
import { GATE_RED_MARKER } from '../src/gate-red.ts';
import { BOUNCE_MARKER } from '../src/conflict.ts';
import { HANDOFF_BOUNCED_MARKER, STRAY_HANDOFF_MARKER } from '../src/handoff-guard.ts';
import { STRANDED_MARKER } from '../src/stranded-verified.ts';
import { STALLED_MARKER } from '../src/stalled.ts';
import { INTERRUPTED_MARKER } from '../src/interrupted.ts';

test('every crew post marker is a callout header, never an HTML comment', () => {
  const cases: [string, 'NOTE' | 'WARNING' | 'CAUTION', string][] = [
    [FAILURE_ALERT_MARKER, 'CAUTION', 'Failure Alert'],
    [BUILD_FAILURE_MARKER, 'CAUTION', 'Build Failure'],
    [GATE_RED_MARKER, 'CAUTION', 'Test Gate Red'],
    [BOUNCE_MARKER, 'WARNING', 'Merge Conflict'],
    [HANDOFF_BOUNCED_MARKER, 'WARNING', 'Hand-off Bounced'],
    [STRAY_HANDOFF_MARKER, 'WARNING', 'Stray Hand-off'],
    [STRANDED_MARKER, 'WARNING', 'Stranded Verified'],
    [STALLED_MARKER, 'WARNING', 'Stalled'],
    [INTERRUPTED_MARKER, 'NOTE', 'Interrupted'],
  ];
  for (const [marker, kind, label] of cases) {
    assert.equal(marker, `> [!${kind}]\n> **Crew** — ${label}`);
    assert.equal(marker, calloutHeader(kind, label));
    assert.ok(!marker.includes('<!--'));
  }
});
