import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPosture, createPostureMonitor, goodPercent, POSTURE_DEFAULTS } from '../agent/lib/posture.js';
import { multiplyQuaternions, quaternionFromAxisAngle } from '../agent/lib/quat.js';

const NO_SMOOTHING = { smoothing: 1 };

test('classifyPosture picks the worst level and the dominant kind', () => {
  assert.equal(classifyPosture(0, 0).level, 'ok');
  assert.equal(classifyPosture(12, 0).level, 'warn');
  assert.deepEqual(classifyPosture(20, 0).kind, 'pitch-down');
  assert.deepEqual(classifyPosture(-20, 0).kind, 'pitch-up');
  assert.deepEqual(classifyPosture(0, 13).kind, 'roll');
  assert.equal(classifyPosture(0, 13).level, 'bad');
  assert.equal(classifyPosture(12, 8).level, 'warn');
});

test('an alert needs sustained bad posture and clears after recovery', () => {
  const m = createPostureMonitor(NO_SMOOTHING);
  let t = 1000;
  m.updateAngles(0, 0, t);
  assert.equal(m.snapshot().level, 'ok');

  // Bad posture for less than the dwell: no alert yet.
  t += 500;
  m.updateAngles(25, 0, t);
  t += POSTURE_DEFAULTS.dwellMs - 100;
  m.updateAngles(25, 0, t);
  assert.equal(m.snapshot().alert.active, false);

  // Crossing the dwell raises exactly one alert.
  t += 200;
  m.updateAngles(25, 0, t);
  assert.equal(m.snapshot().alert.active, true);
  assert.equal(m.snapshot().alert.kind, 'pitch-down');
  assert.equal(m.snapshot().stats.alerts, 1);
  t += 5000;
  m.updateAngles(25, 0, t);
  assert.equal(m.snapshot().stats.alerts, 1);

  // Recovery clears the alert after recoverMs without a cooldown.
  t += 500;
  m.updateAngles(0, 0, t);
  assert.equal(m.snapshot().alert.active, true);
  t += POSTURE_DEFAULTS.recoverMs;
  m.updateAngles(0, 0, t);
  assert.equal(m.snapshot().alert.active, false);
});

test('dismissing an alert starts a cooldown during which no new alert fires', () => {
  const m = createPostureMonitor(NO_SMOOTHING);
  let t = 0;
  m.updateAngles(25, 0, t);
  t += POSTURE_DEFAULTS.dwellMs;
  m.updateAngles(25, 0, t);
  assert.equal(m.snapshot().alert.active, true);
  assert.equal(m.dismissAlert(t), true);
  assert.equal(m.dismissAlert(t), false);
  assert.equal(m.snapshot().alert.active, false);

  t += POSTURE_DEFAULTS.dwellMs + 1000;
  m.updateAngles(25, 0, t);
  assert.equal(m.snapshot().alert.active, false, 'still inside cooldown');

  t += POSTURE_DEFAULTS.cooldownMs;
  m.updateAngles(25, 0, t);
  t += POSTURE_DEFAULTS.dwellMs;
  m.updateAngles(25, 0, t);
  assert.equal(m.snapshot().alert.active, true, 'alerts again after cooldown');
  assert.equal(m.snapshot().stats.alerts, 2);
});

test('tick advances dwell timers without a new reading', () => {
  const m = createPostureMonitor(NO_SMOOTHING);
  m.updateAngles(0, 14, 0);
  m.tick(POSTURE_DEFAULTS.dwellMs + 1);
  assert.equal(m.snapshot().alert.active, true);
  assert.equal(m.snapshot().alert.kind, 'roll');
});

test('statistics accumulate per level with capped steps', () => {
  const m = createPostureMonitor(NO_SMOOTHING);
  m.updateAngles(0, 0, 0);
  m.updateAngles(0, 0, 1000); // 1 s ok
  m.updateAngles(12, 0, 2000); // the step is attributed to the previous level (ok)
  m.updateAngles(12, 0, 3000); // 1 s warn
  m.updateAngles(12, 0, 60000); // huge gap capped to 2 s
  const stats = m.snapshot().stats;
  assert.equal(stats.okMs, 2000);
  assert.equal(stats.warnMs, 3000);
  assert.equal(stats.badMs, 0);
  assert.equal(goodPercent(stats), 40);
  assert.equal(goodPercent({ okMs: 0, warnMs: 0, badMs: 0 }), 100);
});

test('quaternion readings are measured relative to the baseline', () => {
  const m = createPostureMonitor(NO_SMOOTHING);
  const base = quaternionFromAxisAngle([0, 1, 0], 70);
  assert.equal(m.updateQuaternion(base, 0), null, 'no baseline yet');
  assert.equal(m.setBaseline(base, 0), true);
  assert.equal(m.setBaseline([0, 0, 0, 0], 0), false);

  const same = m.updateQuaternion(base, 500);
  assert.equal(Math.abs(Math.round(same.pitch)), 0);
  assert.equal(same.level, 'ok');

  const down = multiplyQuaternions(base, quaternionFromAxisAngle([1, 0, 0], -22));
  const snap = m.updateQuaternion(down, 1000);
  assert.equal(Math.round(snap.pitch), 22);
  assert.equal(snap.level, 'bad');
  assert.equal(snap.kind, 'pitch-down');
});

test('smoothing damps a single spike', () => {
  const m = createPostureMonitor({ smoothing: 0.3 });
  m.updateAngles(0, 0, 0);
  const s = m.updateAngles(30, 0, 100);
  assert.ok(s.pitch < 10);
  assert.equal(s.level, 'ok');
});

test('invalid angles are ignored and reset clears everything', () => {
  const m = createPostureMonitor(NO_SMOOTHING);
  m.updateAngles(20, 0, 0);
  m.updateAngles(Number.NaN, 0, 100);
  assert.equal(m.snapshot().pitch, 20);
  m.reset();
  assert.equal(m.snapshot().level, 'off');
  assert.equal(m.hasBaseline(), false);
});
