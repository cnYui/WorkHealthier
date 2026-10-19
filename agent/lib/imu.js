// IMU helpers for the Gyroscope and Accelerometer sensors.
//
// Pure math with no runtime dependency (like quat.js), so it can be unit-tested
// in Node. Frame convention, shared with quat.js and the official
// samples/gyroscope-test: X = right, Y = up, Z = toward the wearer, so the
// glasses look along -Z. Rotating about +X looks up, about +Y turns left.

const RAD_TO_DEG = 180 / Math.PI;

function finite3(x, y, z) {
  return [x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v));
}

// Counts events in a sliding window and reports the measured rate in Hz.
export function createRateMeter(windowMs) {
  const span = typeof windowMs === 'number' && windowMs > 0 ? windowMs : 2000;
  let stamps = [];
  let total = 0;
  let last = null;

  function prune(now) {
    while (stamps.length > 0 && now - stamps[0] > span) stamps.shift();
  }

  return {
    tick(now) {
      stamps.push(now);
      total += 1;
      last = now;
      prune(now);
    },
    hz(now) {
      prune(now);
      if (stamps.length < 2) return 0;
      const dt = stamps[stamps.length - 1] - stamps[0];
      return dt > 0 ? ((stamps.length - 1) * 1000) / dt : 0;
    },
    count() {
      return total;
    },
    lastAt() {
      return last;
    },
    ageMs(now) {
      return last === null ? Infinity : Math.max(0, now - last);
    },
    reset() {
      stamps = [];
      total = 0;
      last = null;
    }
  };
}

// Pitch and roll from a gravity ("up") vector measured in the device frame.
// Positive pitchDown = looking down, positive rollRight = right ear toward the
// right shoulder. Returns null for a zero or non-finite vector.
export function gravityAngles(ux, uy, uz) {
  if (!finite3(ux, uy, uz)) return null;
  const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (len === 0) return null;
  const x = ux / len;
  const y = uy / len;
  const z = uz / len;
  return {
    pitchDown: Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD_TO_DEG,
    rollRight: Math.atan2(-x, y) * RAD_TO_DEG
  };
}

export const GRAVITY_DEFAULTS = Object.freeze({
  warmupSamples: 8, // samples used to learn the resting gravity magnitude
  tolerance: 0.12, // reject samples whose magnitude differs from it by more
  smoothing: 0.25 // low-pass factor for the unit gravity vector (0..1)
});

// Accelerometer based tilt: works with any unit because only the direction of
// the vector and its relative magnitude matter. Samples taken while the head
// accelerates (magnitude far from the resting gravity) are ignored.
export function createGravityTilt(options) {
  const cfg = Object.assign({}, GRAVITY_DEFAULTS, options || {});
  let warm = [];
  let gRef = null;
  let up = null;
  let base = null;
  let accepted = 0;
  let rejected = 0;

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function normalize(v) {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len === 0 ? v : [v[0] / len, v[1] / len, v[2] / len];
  }

  return {
    config: cfg,

    push(x, y, z) {
      if (!finite3(x, y, z)) return false;
      const m = Math.sqrt(x * x + y * y + z * z);
      if (m < 1e-6) return false;
      if (gRef === null) {
        warm.push(m);
        if (warm.length >= cfg.warmupSamples) {
          gRef = median(warm);
          warm = [];
        }
      } else if (Math.abs(m - gRef) / gRef > cfg.tolerance) {
        rejected += 1;
        return false;
      } else {
        gRef += (m - gRef) * 0.02;
      }
      const n = [x / m, y / m, z / m];
      if (up === null) {
        up = n;
      } else {
        const a = Math.min(1, Math.max(0, cfg.smoothing));
        up = normalize([up[0] + (n[0] - up[0]) * a, up[1] + (n[1] - up[1]) * a, up[2] + (n[2] - up[2]) * a]);
      }
      accepted += 1;
      return true;
    },

    ready() {
      return up !== null && gRef !== null;
    },

    angles() {
      return up === null ? null : gravityAngles(up[0], up[1], up[2]);
    },

    setBaseline() {
      const a = this.angles();
      if (!a || gRef === null) return false;
      base = a;
      return true;
    },

    hasBaseline() {
      return base !== null;
    },

    // Angles relative to the baseline, positive pitch = down, roll = right.
    relative() {
      const a = this.angles();
      if (!a || !base) return null;
      return { pitch: a.pitchDown - base.pitchDown, roll: a.rollRight - base.rollRight };
    },

    magnitude() {
      return gRef;
    },

    stats() {
      return { accepted, rejected };
    },

    reset() {
      warm = [];
      gRef = null;
      up = null;
      base = null;
      accepted = 0;
      rejected = 0;
    }
  };
}

export const GYRO_DEFAULTS = Object.freeze({
  stillDps: 8, // below this smoothed speed the head counts as still
  smoothing: 0.3, // exponential smoothing factor for the speed
  unitScale: RAD_TO_DEG // raw -> deg/s; the Android convention is rad/s
});

// Gyroscope based head-motion tracker: smoothed angular speed in deg/s and how
// long the head has been still. The raw unit is not stated by the AIUI docs,
// so `rawMagnitude()` is exposed for checking it on the device.
export function createGyroMotion(options) {
  const cfg = Object.assign({}, GYRO_DEFAULTS, options || {});
  let speed = 0;
  let raw = 0;
  let has = false;
  let firstAt = null;
  let movingAt = null;

  return {
    config: cfg,

    push(x, y, z, now) {
      if (!finite3(x, y, z)) return false;
      raw = Math.sqrt(x * x + y * y + z * z);
      const dps = raw * cfg.unitScale;
      const a = Math.min(1, Math.max(0, cfg.smoothing));
      speed = has ? speed + (dps - speed) * a : dps;
      has = true;
      if (firstAt === null) firstAt = now;
      if (speed > cfg.stillDps) movingAt = now;
      return true;
    },

    hasReading() {
      return has;
    },

    speedDps() {
      return speed;
    },

    rawMagnitude() {
      return raw;
    },

    stillForMs(now) {
      if (!has) return 0;
      return Math.max(0, now - (movingAt === null ? firstAt : movingAt));
    },

    isStill(now, minMs) {
      return has && speed <= cfg.stillDps && this.stillForMs(now) >= (typeof minMs === 'number' ? minMs : 0);
    },

    reset() {
      speed = 0;
      raw = 0;
      has = false;
      firstAt = null;
      movingAt = null;
    }
  };
}
