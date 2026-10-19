import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGravityTilt,
  createGyroMotion,
  createRateMeter,
  gravityAngles
} from '../agent/lib/imu.js';

function near(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);
}

const RAD = Math.PI / 180;

// Gravity "up" vector in the device frame (X right, Y up, Z toward the wearer)
// for a head pitched down by `down` degrees and tilted right by `right` degrees.
function upVector(down, right, g) {
  const m = g === undefined ? 9.80665 : g;
  const d = down * RAD;
  const r = right * RAD;
  return [-Math.sin(r) * Math.cos(d) * m, Math.cos(r) * Math.cos(d) * m, Math.sin(d) * m];
}

test('gravityAngles: upright is zero, looking down is positive pitch, tilting right is positive roll', () => {
  const upright = gravityAngles(0, 9.8, 0);
  near(upright.pitchDown, 0, 1e-9);
  near(upright.rollRight, 0, 1e-9);

  const down = gravityAngles(0, Math.cos(20 * RAD), Math.sin(20 * RAD));
  near(down.pitchDown, 20, 1e-6);
  near(down.rollRight, 0, 1e-6);

  const right = gravityAngles(-Math.sin(15 * RAD), Math.cos(15 * RAD), 0);
  near(right.rollRight, 15, 1e-6);
  near(right.pitchDown, 0, 1e-6);

  assert.equal(gravityAngles(0, 0, 0), null);
  assert.equal(gravityAngles(NaN, 1, 1), null);
});

test('gravity tilt: relative angles follow the head regardless of unit', () => {
  for (const g of [9.80665, 1]) {
    const tilt = createGravityTilt();
    for (let i = 0; i < 12; i += 1) tilt.push(...upVector(2, 1, g));
    assert.equal(tilt.ready(), true);
    assert.equal(tilt.setBaseline(), true);

    for (let i = 0; i < 60; i += 1) tilt.push(...upVector(2 + 20, 1 + 9, g));
    const rel = tilt.relative();
    near(rel.pitch, 20, 0.5);
    near(rel.roll, 9, 0.5);
  }
});

test('gravity tilt ignores samples while the head accelerates', () => {
  const tilt = createGravityTilt();
  for (let i = 0; i < 12; i += 1) tilt.push(...upVector(0, 0));
  tilt.setBaseline();
  // A jolt: the magnitude is 40 % above gravity, the direction would read 45 deg.
  const jolt = upVector(45, 0, 9.80665 * 1.4);
  assert.equal(tilt.push(...jolt), false);
  near(tilt.relative().pitch, 0, 1e-6);
  assert.equal(tilt.stats().rejected, 1);
});

test('gravity tilt needs a warm-up and a baseline before it reports', () => {
  const tilt = createGravityTilt({ warmupSamples: 4 });
  assert.equal(tilt.ready(), false);
  assert.equal(tilt.setBaseline(), false);
  assert.equal(tilt.relative(), null);
  for (let i = 0; i < 4; i += 1) tilt.push(0, 9.8, 0);
  assert.equal(tilt.ready(), true);
  assert.equal(tilt.relative(), null);
  assert.equal(tilt.push('a', 1, 2), false);
  assert.equal(tilt.push(0, 0, 0), false);
});

test('gyro motion: speed in deg/s and how long the head has been still', () => {
  const gyro = createGyroMotion({ stillDps: 10, smoothing: 1 });
  assert.equal(gyro.isStill(0, 0), false); // nothing measured yet
  // 0.5 rad/s is about 28.6 deg/s: moving.
  gyro.push(0.5, 0, 0, 1000);
  near(gyro.speedDps(), 0.5 * (180 / Math.PI), 1e-9);
  assert.equal(gyro.isStill(1000, 0), false);
  // Quiet samples from 1200 ms on; stillness counts from the last moving sample.
  gyro.push(0.01, 0.01, 0, 1200);
  assert.equal(gyro.stillForMs(1700), 700);
  assert.equal(gyro.isStill(1700, 600), true);
  assert.equal(gyro.isStill(1700, 800), false);
  // A new movement restarts the timer.
  gyro.push(0, 0.4, 0, 2000);
  assert.equal(gyro.stillForMs(2100), 100);
  near(gyro.rawMagnitude(), 0.4, 1e-12);
  assert.equal(gyro.push(NaN, 0, 0, 2200), false);
});

test('rate meter reports Hz over a sliding window and forgets old events', () => {
  const meter = createRateMeter(1000);
  assert.equal(meter.hz(0), 0);
  assert.equal(meter.ageMs(0), Infinity);
  for (let t = 0; t <= 1000; t += 50) meter.tick(t);
  near(meter.hz(1000), 20, 0.01);
  assert.equal(meter.count(), 21);
  assert.equal(meter.lastAt(), 1000);
  assert.equal(meter.ageMs(1300), 300);
  assert.equal(meter.hz(5000), 0);
  meter.reset();
  assert.equal(meter.count(), 0);
});
