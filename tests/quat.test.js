import test from 'node:test';
import assert from 'node:assert/strict';
import {
  angleBetweenDegrees,
  DEFAULT_AXIS_MAP,
  headAnglesFromRelative,
  multiplyQuaternions,
  normalizeQuaternion,
  quaternionFromAxisAngle,
  relativeQuaternion,
  rotationVectorDegrees
} from '../agent/lib/quat.js';

const IDENTITY = [0, 0, 0, 1];

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('normalizeQuaternion rejects invalid input and normalizes magnitude', () => {
  assert.equal(normalizeQuaternion(null), null);
  assert.equal(normalizeQuaternion([1, 2]), null);
  assert.equal(normalizeQuaternion([0, 0, 0, 0]), null);
  assert.equal(normalizeQuaternion([Number.NaN, 0, 0, 1]), null);
  const n = normalizeQuaternion([0, 0, 0, 2]);
  assert.deepEqual(n, [0, 0, 0, 1]);
});

test('multiplying by the identity leaves a rotation unchanged', () => {
  const q = quaternionFromAxisAngle([1, 0, 0], 30);
  const r = multiplyQuaternions(q, IDENTITY);
  q.forEach((v, i) => near(r[i], v));
});

test('relativeQuaternion recovers the rotation applied after the baseline', () => {
  const base = quaternionFromAxisAngle([0, 1, 0], 40); // arbitrary heading
  const delta = quaternionFromAxisAngle([1, 0, 0], -20); // nod down 20 deg about X
  const current = multiplyQuaternions(base, delta);
  const rel = relativeQuaternion(base, current);
  const vec = rotationVectorDegrees(rel);
  near(vec.x, -20, 1e-6);
  near(vec.y, 0, 1e-6);
  near(vec.z, 0, 1e-6);
  near(vec.angle, 20, 1e-6);
});

test('headAnglesFromRelative applies the axis map and sign conventions', () => {
  const down = quaternionFromAxisAngle([1, 0, 0], -15);
  const a = headAnglesFromRelative(down, DEFAULT_AXIS_MAP);
  near(a.pitch, 15, 1e-6); // positive pitch = looking down
  near(a.roll, 0, 1e-6);

  const tilt = quaternionFromAxisAngle([0, 0, 1], 10);
  const b = headAnglesFromRelative(tilt, DEFAULT_AXIS_MAP);
  near(b.roll, 10, 1e-6);
  near(b.pitch, 0, 1e-6);

  const custom = headAnglesFromRelative(down, { pitch: 'x', yaw: 'y', roll: 'z', pitchDownSign: 1, rollRightSign: -1 });
  near(custom.pitch, -15, 1e-6);
});

test('angleBetweenDegrees is symmetric and zero for equal poses', () => {
  const a = quaternionFromAxisAngle([0, 1, 0], 25);
  const b = quaternionFromAxisAngle([0, 1, 0], 55);
  near(angleBetweenDegrees(a, a), 0, 1e-9);
  near(angleBetweenDegrees(a, b), 30, 1e-6);
  near(angleBetweenDegrees(b, a), 30, 1e-6);
  assert.equal(angleBetweenDegrees(a, null), null);
});

test('rotationVectorDegrees handles the negative-w double cover', () => {
  const q = quaternionFromAxisAngle([1, 0, 0], 20);
  const flipped = q.map((v) => -v);
  const a = rotationVectorDegrees(q);
  const b = rotationVectorDegrees(flipped);
  near(a.x, b.x, 1e-9);
  near(a.angle, 20, 1e-6);
});
