// Posture monitor: turns head-pose angles into a posture level, sustained
// bad-posture alerts, and per-level time statistics.
//
// All timing comes from the `now` argument (milliseconds), never from
// Date.now() inside this module, so the state machine is deterministic.

import { headAnglesFromRelative, normalizeQuaternion, relativeQuaternion } from './quat.js';

export const POSTURE_DEFAULTS = Object.freeze({
  pitchWarnDeg: 10, // beyond this: "Watch" (warn)
  pitchBadDeg: 18, // beyond this: "Poor" (bad)
  rollWarnDeg: 7,
  rollBadDeg: 12,
  dwellMs: 8000, // bad posture must persist this long before an alert
  recoverMs: 2000, // posture must be non-bad this long to auto-clear an alert
  cooldownMs: 60000, // after a dismiss, no new posture alert for this long
  smoothing: 0.3, // exponential smoothing factor for angles (0..1)
  maxStatStepMs: 2000 // cap for time accounting after a gap (hide/show)
});

export const LEVELS = Object.freeze(['off', 'ok', 'warn', 'bad']);

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function levelForAngle(value, warnDeg, badDeg) {
  const a = Math.abs(value);
  if (a >= badDeg) return 'bad';
  if (a >= warnDeg) return 'warn';
  return 'ok';
}

function worstLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

export function classifyPosture(pitch, roll, cfg) {
  const c = cfg || POSTURE_DEFAULTS;
  const pitchLevel = levelForAngle(pitch, c.pitchWarnDeg, c.pitchBadDeg);
  const rollLevel = levelForAngle(roll, c.rollWarnDeg, c.rollBadDeg);
  const level = worstLevel(pitchLevel, rollLevel);
  let kind = 'none';
  if (level !== 'ok') {
    const pitchScore = Math.abs(pitch) / c.pitchBadDeg;
    const rollScore = Math.abs(roll) / c.rollBadDeg;
    if (pitchScore >= rollScore) kind = pitch > 0 ? 'pitch-down' : 'pitch-up';
    else kind = 'roll';
  }
  return { level, pitchLevel, rollLevel, kind };
}

export function createPostureMonitor(options) {
  const cfg = Object.assign({}, POSTURE_DEFAULTS, options || {});
  const state = {
    baseline: null,
    hasAngles: false,
    pitch: 0,
    roll: 0,
    yaw: 0,
    level: 'off',
    kind: 'none',
    badSince: null,
    goodSince: null,
    alertActive: false,
    alertKind: 'none',
    alertSince: null,
    dismissedUntil: 0,
    lastUpdateAt: null,
    stats: { okMs: 0, warnMs: 0, badMs: 0, alerts: 0, samples: 0 }
  };

  function snapshot() {
    return {
      hasBaseline: state.baseline !== null,
      hasAngles: state.hasAngles,
      pitch: state.pitch,
      roll: state.roll,
      yaw: state.yaw,
      level: state.level,
      kind: state.kind,
      alert: {
        active: state.alertActive,
        kind: state.alertKind,
        since: state.alertSince
      },
      stats: Object.assign({}, state.stats)
    };
  }

  function accountTime(now) {
    if (state.lastUpdateAt === null || state.level === 'off') {
      state.lastUpdateAt = now;
      return;
    }
    const dt = Math.min(cfg.maxStatStepMs, Math.max(0, now - state.lastUpdateAt));
    state.lastUpdateAt = now;
    if (state.level === 'ok') state.stats.okMs += dt;
    else if (state.level === 'warn') state.stats.warnMs += dt;
    else if (state.level === 'bad') state.stats.badMs += dt;
  }

  function evaluateAlert(now) {
    if (state.level === 'bad') {
      state.goodSince = null;
      if (state.badSince === null) state.badSince = now;
      const sustained = now - state.badSince >= cfg.dwellMs;
      if (!state.alertActive && sustained && now >= state.dismissedUntil) {
        state.alertActive = true;
        state.alertKind = state.kind;
        state.alertSince = now;
        state.stats.alerts += 1;
      }
      return;
    }
    state.badSince = null;
    if (state.goodSince === null) state.goodSince = now;
    if (state.alertActive && now - state.goodSince >= cfg.recoverMs) {
      state.alertActive = false;
      state.alertKind = 'none';
      state.alertSince = null;
    }
  }

  function updateAngles(pitch, roll, yaw, now) {
    if (![pitch, roll].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return snapshot();
    }
    const a = clamp01(cfg.smoothing);
    if (!state.hasAngles) {
      state.pitch = pitch;
      state.roll = roll;
      state.yaw = typeof yaw === 'number' ? yaw : 0;
      state.hasAngles = true;
    } else {
      state.pitch += (pitch - state.pitch) * a;
      state.roll += (roll - state.roll) * a;
      if (typeof yaw === 'number') state.yaw += (yaw - state.yaw) * a;
    }
    // Attribute the elapsed interval to the level that was in effect during it.
    accountTime(now);
    const cls = classifyPosture(state.pitch, state.roll, cfg);
    state.level = cls.level;
    state.kind = cls.kind;
    state.stats.samples += 1;
    evaluateAlert(now);
    return snapshot();
  }

  return {
    config: cfg,

    setBaseline(q, now) {
      const n = normalizeQuaternion(q);
      if (!n) return false;
      state.baseline = n;
      state.hasAngles = false;
      state.pitch = 0;
      state.roll = 0;
      state.yaw = 0;
      state.level = 'ok';
      state.kind = 'none';
      state.badSince = null;
      state.goodSince = null;
      state.alertActive = false;
      state.alertKind = 'none';
      state.alertSince = null;
      state.lastUpdateAt = typeof now === 'number' ? now : null;
      return true;
    },

    hasBaseline() {
      return state.baseline !== null;
    },

    // Feed a raw sensor quaternion; returns null when no baseline exists.
    updateQuaternion(q, now, axisMap) {
      if (state.baseline === null) return null;
      const rel = relativeQuaternion(state.baseline, q);
      if (!rel) return null;
      const angles = headAnglesFromRelative(rel, axisMap);
      if (!angles) return null;
      return updateAngles(angles.pitch, angles.roll, angles.yaw, now);
    },

    // Feed pre-computed angles (demo scenario or tests).
    updateAngles(pitch, roll, now) {
      if (state.level === 'off') state.level = 'ok';
      return updateAngles(pitch, roll, 0, now);
    },

    // Called on a tick without a new reading so dwell/recovery timers advance.
    tick(now) {
      if (state.level === 'off') return snapshot();
      accountTime(now);
      evaluateAlert(now);
      return snapshot();
    },

    dismissAlert(now) {
      if (!state.alertActive) return false;
      state.alertActive = false;
      state.alertKind = 'none';
      state.alertSince = null;
      state.badSince = null;
      state.dismissedUntil = now + cfg.cooldownMs;
      return true;
    },

    reset() {
      state.baseline = null;
      state.hasAngles = false;
      state.level = 'off';
      state.kind = 'none';
      state.badSince = null;
      state.goodSince = null;
      state.alertActive = false;
      state.alertKind = 'none';
      state.alertSince = null;
      state.dismissedUntil = 0;
      state.lastUpdateAt = null;
    },

    snapshot
  };
}

// Percentage of monitored time spent in a good posture (0..100).
export function goodPercent(stats) {
  const total = stats.okMs + stats.warnMs + stats.badMs;
  if (total <= 0) return 100;
  return Math.round((stats.okMs / total) * 100);
}
