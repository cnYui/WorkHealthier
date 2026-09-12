// Quaternion helpers for AbsoluteOrientationSensor readings.
//
// AIUI exposes the pose as `[x, y, z, w]` (Android TYPE_ROTATION_VECTOR).
// Everything here is pure math with no runtime dependency, so it can be
// unit-tested in Node and reused by the demo scenario.

const RAD_TO_DEG = 180 / Math.PI;

export function isQuaternion(q) {
  return (
    Array.isArray(q) &&
    q.length >= 4 &&
    q.slice(0, 4).every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

export function normalizeQuaternion(q) {
  if (!isQuaternion(q)) return null;
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const mag = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!Number.isFinite(mag) || mag === 0) return null;
  return [x / mag, y / mag, z / mag, w / mag];
}

export function invertQuaternion(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

// Hamilton product in [x, y, z, w] order: R(a ⊗ b) = R(a) · R(b).
export function multiplyQuaternions(a, b) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

// Rotation from `base` to `current`, expressed in the base device frame.
export function relativeQuaternion(base, current) {
  const b = normalizeQuaternion(base);
  const c = normalizeQuaternion(current);
  if (!b || !c) return null;
  return normalizeQuaternion(multiplyQuaternions(invertQuaternion(b), c));
}

// Axis-angle form scaled to degrees: {x, y, z} are the rotation-vector
// components about the device axes, `angle` is the total rotation.
export function rotationVectorDegrees(q) {
  const n = normalizeQuaternion(q);
  if (!n) return null;
  const sign = n[3] < 0 ? -1 : 1;
  const x = n[0] * sign;
  const y = n[1] * sign;
  const z = n[2] * sign;
  const w = Math.min(1, Math.max(-1, n[3] * sign));
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len === 0) return { x: 0, y: 0, z: 0, angle: 0 };
  const angle = 2 * Math.atan2(len, w) * RAD_TO_DEG;
  return {
    x: (x / len) * angle,
    y: (y / len) * angle,
    z: (z / len) * angle,
    angle
  };
}

// Total rotation angle (degrees) between two orientations.
export function angleBetweenDegrees(a, b) {
  const rel = relativeQuaternion(a, b);
  if (!rel) return null;
  return rotationVectorDegrees(rel).angle;
}

// Build a quaternion from an axis and an angle in degrees (test/demo helper).
export function quaternionFromAxisAngle(axis, angleDeg) {
  const len = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  if (len === 0) return [0, 0, 0, 1];
  const half = (angleDeg / RAD_TO_DEG) / 2;
  const s = Math.sin(half) / len;
  return normalizeQuaternion([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]);
}

// Device-frame convention used by this project (see README "轴向约定"):
// X = lateral axis (rotation = pitch, nodding), Y = vertical axis (yaw,
// turning), Z = fore-aft axis (roll, tilting the head sideways). The sign of
// `pitchDownSign` decides which rotation direction counts as "looking down";
// it only affects labels, never whether a deviation is detected.
export const DEFAULT_AXIS_MAP = Object.freeze({
  pitch: 'x',
  yaw: 'y',
  roll: 'z',
  pitchDownSign: -1,
  rollRightSign: 1
});

export function headAnglesFromRelative(rel, axisMap) {
  const map = axisMap || DEFAULT_AXIS_MAP;
  const vec = rotationVectorDegrees(rel);
  if (!vec) return null;
  return {
    // Positive pitch = head tilted forward/down, positive roll = tilted right.
    pitch: vec[map.pitch] * map.pitchDownSign,
    roll: vec[map.roll] * map.rollRightSign,
    yaw: vec[map.yaw],
    angle: vec.angle
  };
}
