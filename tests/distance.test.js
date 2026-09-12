import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDistance,
  createDistanceMonitor,
  DISTANCE_DEFAULTS,
  distanceCmFrom,
  kNormFrom,
  markerSideNormalized,
  parseMarkerPayload,
  selectMarker
} from '../agent/lib/distance.js';

test('parseMarkerPayload accepts WH:<mm> and rejects everything else', () => {
  assert.equal(parseMarkerPayload('WH:50'), 50);
  assert.equal(parseMarkerPayload('  WH:80 '), 80);
  assert.equal(parseMarkerPayload('WH:5'), null);
  assert.equal(parseMarkerPayload('WH:abc'), null);
  assert.equal(parseMarkerPayload('https://example.com'), null);
  assert.equal(parseMarkerPayload(undefined), null);
});

test('markerSideNormalized uses the longest quadrilateral side, then the bounding box', () => {
  const corners = [{ x: 100, y: 100 }, { x: 180, y: 104 }, { x: 178, y: 184 }, { x: 98, y: 180 }];
  const side = markerSideNormalized({ cornerPoints: corners }, 640);
  assert.ok(side > 80 / 640 && side < 82 / 640);
  const box = markerSideNormalized({ boundingBox: { width: 64, height: 60 } }, 640);
  assert.equal(box, 0.1);
  assert.equal(markerSideNormalized({}, 640), null);
  assert.equal(markerSideNormalized({ boundingBox: { width: 64 } }, 0), null);
});

test('distance formula and calibration are inverses', () => {
  const k = DISTANCE_DEFAULTS.defaultKNorm;
  const cm = distanceCmFrom(0.05, 50, k);
  assert.ok(Math.abs(cm - 44.6) < 0.05);
  const recovered = kNormFrom(0.05, 50, cm);
  assert.ok(Math.abs(recovered - k) < 1e-9);
  assert.equal(distanceCmFrom(0, 50, k), null);
  assert.equal(kNormFrom(0.05, 50, 0), null);
});

test('classifyDistance bands', () => {
  assert.equal(classifyDistance(30), 'too-close');
  assert.equal(classifyDistance(48), 'close');
  assert.equal(classifyDistance(60), 'good');
  assert.equal(classifyDistance(120), 'far');
  assert.equal(classifyDistance(Number.NaN), 'unknown');
});

test('selectMarker prefers the largest WH marker and ignores other codes', () => {
  const picked = selectMarker([
    { rawValue: 'https://x', boundingBox: { width: 300 } },
    { rawValue: 'WH:30', boundingBox: { width: 40 } },
    { rawValue: 'WH:50', boundingBox: { width: 90 } }
  ]);
  assert.equal(picked.markerMm, 50);
  assert.equal(selectMarker([{ rawValue: 'nope' }]), null);
  assert.equal(selectMarker(null), null);
});

function sampleAt(cm, k = DISTANCE_DEFAULTS.defaultKNorm, mm = 50) {
  return { found: true, sideNorm: (k * mm) / (cm * 10), markerMm: mm };
}

test('too-close needs sustained samples before alerting and recovers when far enough', () => {
  const m = createDistanceMonitor({ smoothing: 1 });
  let t = 0;
  m.update(sampleAt(62), t);
  assert.equal(m.snapshot().level, 'good');
  assert.equal(Math.round(m.snapshot().cm), 62);

  t += 20000;
  m.update(sampleAt(38), t);
  assert.equal(m.snapshot().level, 'too-close');
  assert.equal(m.snapshot().alert.active, false, 'one sample is not enough');

  t += DISTANCE_DEFAULTS.dwellMs;
  m.update(sampleAt(38), t);
  assert.equal(m.snapshot().alert.active, true);
  assert.equal(m.snapshot().stats.alerts, 1);

  t += 20000;
  m.update(sampleAt(49), t); // still "close": alert stays
  assert.equal(m.snapshot().alert.active, true);
  t += 20000;
  m.update(sampleAt(60), t);
  assert.equal(m.snapshot().alert.active, false);
});

test('dismissing a distance alert applies a cooldown', () => {
  const m = createDistanceMonitor({ smoothing: 1 });
  let t = 0;
  m.update(sampleAt(35), t);
  t += DISTANCE_DEFAULTS.dwellMs;
  m.update(sampleAt(35), t);
  assert.equal(m.snapshot().alert.active, true);
  assert.equal(m.dismissAlert(t), true);
  t += DISTANCE_DEFAULTS.dwellMs + 1000;
  m.update(sampleAt(35), t);
  t += 1000;
  m.update(sampleAt(35), t);
  assert.equal(m.snapshot().alert.active, false);
  t += DISTANCE_DEFAULTS.cooldownMs;
  m.update(sampleAt(35), t);
  t += DISTANCE_DEFAULTS.dwellMs;
  m.update(sampleAt(35), t);
  assert.equal(m.snapshot().alert.active, true);
});

test('missing marker flips to missing after the miss limit and keeps the last reading', () => {
  const m = createDistanceMonitor({ smoothing: 1 });
  m.update(sampleAt(70), 0);
  m.update({ found: false }, 1);
  m.update({ found: false }, 2);
  assert.equal(m.snapshot().markerState, 'found');
  m.update({ found: false }, 3);
  const s = m.snapshot();
  assert.equal(s.markerState, 'missing');
  assert.equal(s.cm, null);
  assert.equal(Math.round(s.lastCm), 70);
  assert.equal(s.level, 'unknown');
  m.update(sampleAt(65), 4);
  assert.equal(m.snapshot().markerState, 'found');
});

test('calibration replaces K, marks the monitor calibrated, and persists through setKNorm', () => {
  const m = createDistanceMonitor({ smoothing: 1 });
  const k = m.calibrate(0.04, 50, 60);
  assert.ok(k > 0);
  assert.equal(m.snapshot().calibrated, true);
  assert.equal(m.snapshot().cm, 60);
  m.update({ found: true, sideNorm: 0.08, markerMm: 50 }, 10);
  assert.equal(Math.round(m.snapshot().cm), 30);
  assert.equal(m.calibrate(0, 50, 60), null);

  const other = createDistanceMonitor();
  assert.equal(other.setKNorm(k, true), true);
  assert.equal(other.setKNorm(-1, true), false);
  assert.equal(other.snapshot().calibrated, true);
});

test('readings are clamped to a sane range and smoothed', () => {
  const m = createDistanceMonitor();
  m.update(sampleAt(1), 0);
  assert.equal(m.snapshot().cm, DISTANCE_DEFAULTS.minCm);
  m.update(sampleAt(1000), 1);
  assert.ok(m.snapshot().cm < DISTANCE_DEFAULTS.maxCm);
});
