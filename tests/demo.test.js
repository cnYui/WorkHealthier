import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_LOOP_MS, DEMO_TIMELINE, demoLabel, demoSample } from '../agent/lib/demo.js';
import { createPostureMonitor } from '../agent/lib/posture.js';
import { createDistanceMonitor, DISTANCE_DEFAULTS } from '../agent/lib/distance.js';

test('the timeline is contiguous and covers the loop', () => {
  let cursor = 0;
  DEMO_TIMELINE.forEach((seg) => {
    assert.equal(seg[0], cursor);
    assert.ok(seg[1] > seg[0]);
    cursor = seg[1];
  });
  assert.equal(cursor * 1000, DEMO_LOOP_MS);
});

test('demoSample is deterministic and loops', () => {
  const a = demoSample(20000);
  const b = demoSample(20000 + DEMO_LOOP_MS);
  assert.deepEqual(a, b);
  assert.equal(a.segmentIndex, 1);
  assert.ok(a.pitchDeg > 20);
  assert.equal(demoSample(-5).segmentIndex, 0);
  assert.equal(demoLabel(1), 'Demo: head down');
  assert.equal(demoLabel(99), 'Demo');
});

test('replaying the scenario through the monitors raises each alert type', () => {
  const posture = createPostureMonitor();
  const distance = createDistanceMonitor();
  const seen = { posture: new Set(), distance: 0, missing: false };
  let lastDistanceAt = -Infinity;
  for (let t = 0; t < DEMO_LOOP_MS; t += 500) {
    const s = demoSample(t);
    const p = posture.updateAngles(s.pitchDeg, s.rollDeg, t);
    if (p.alert.active) seen.posture.add(p.alert.kind);
    if (t - lastDistanceAt >= 2000) {
      lastDistanceAt = t;
      const k = distance.snapshot().kNorm;
      const mm = DISTANCE_DEFAULTS.defaultMarkerMm;
      const d = distance.update({ found: s.markerFound, sideNorm: (k * mm) / (s.distanceCm * 10), markerMm: mm }, t);
      if (d.alert.active) seen.distance += 1;
      if (d.markerState === 'missing') seen.missing = true;
    }
  }
  assert.ok(seen.posture.has('pitch-down'));
  assert.ok(seen.posture.has('roll'));
  assert.ok(seen.distance > 0);
  assert.equal(seen.missing, true);
  assert.equal(posture.snapshot().alert.active, false, 'ends in a good state');
});
