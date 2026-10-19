// Sensor hub: owns the AbsoluteOrientationSensor, Gyroscope and Accelerometer
// instances and turns them into one head-pose source with a fallback chain.
//
//   1. orientation, page-private sensor from Page.enableWorldAwareness()
//   2. orientation, global `new AbsoluteOrientationSensor()` (the form the
//      official samples/gyroscope-test uses on the glasses)
//   3. accelerometer gravity tilt (pitch and roll only)
//
// The Gyroscope runs next to the orientation sensor and tells the page when
// the head is still, which is when a posture baseline is worth capturing.
// Constructors and the page are injected, so everything here runs in Node
// against fake sensors; the Page passes the real globals.

import { createGravityTilt, createGyroMotion, createRateMeter } from './imu.js';
import { isQuaternion } from './quat.js';

export const SENSOR_DEFAULTS = Object.freeze({
  oriHz: 30,
  gyroHz: 20,
  accelHz: 20,
  oriTimeoutMs: 3000, // no reading this long after a start: try the next source
  freshMs: 2000 // a reading older than this no longer counts as live
});

const STATES = Object.freeze(['idle', 'missing', 'waiting', 'active', 'silent', 'error']);

function errorText(value, fallback) {
  if (value && typeof value === 'object') {
    if (value.error && value.error.message) return String(value.error.message);
    if (value.message) return String(value.message);
  }
  return value ? String(value) : fallback;
}

function makeChannel(name) {
  return {
    name,
    state: 'idle',
    source: '',
    error: '',
    sensor: null,
    owned: false,
    startedAt: 0,
    meter: createRateMeter(2000),
    detach: null
  };
}

export function createSensorHub(env) {
  const cfg = Object.assign({}, SENSOR_DEFAULTS, (env && env.config) || {});
  const page = (env && env.page) || null;
  const now = (env && env.now) || (() => Date.now());
  const log = (env && env.log) || (() => {});
  const Ori = env && env.AbsoluteOrientationSensor;
  const Gyro = env && env.Gyroscope;
  const Accel = env && env.Accelerometer;

  const ori = makeChannel('ori');
  const gyro = makeChannel('gyro');
  const accel = makeChannel('accel');
  const motion = createGyroMotion();
  const tilt = createGravityTilt();
  let latestQuat = null;
  let latestQuatAt = null;
  let stable = null;
  let worldAwareness = false;
  let started = false;

  function setState(channel, state, error) {
    if (channel.state === state && (error === undefined || channel.error === error)) return;
    channel.state = state;
    if (error !== undefined) channel.error = error;
    log(channel.name + ' ' + state + (channel.source ? ' (' + channel.source + ')' : '') + (channel.error && state === 'error' ? ': ' + channel.error : ''));
  }

  // Wires `reading` / `error` listeners on a sensor and starts it when owned.
  function attach(channel, sensor, owned, onReading, extra) {
    channel.sensor = sensor;
    channel.owned = owned;
    channel.startedAt = now();
    channel.error = '';
    const handleReading = () => {
      const t = now();
      let accepted = true;
      try {
        accepted = onReading(sensor, t) !== false;
      } catch (_) {
        accepted = false;
      }
      if (!accepted) return;
      channel.meter.tick(t);
      if (channel.state !== 'active') setState(channel, 'active', '');
    };
    const handleError = (event) => {
      setState(channel, 'error', errorText(event, 'Sensor read failed'));
    };
    sensor.addEventListener('reading', handleReading);
    sensor.addEventListener('error', handleError);
    if (extra) sensor.addEventListener(extra.event, extra.handler);
    channel.detach = () => {
      try {
        sensor.removeEventListener('reading', handleReading);
        sensor.removeEventListener('error', handleError);
        if (extra) sensor.removeEventListener(extra.event, extra.handler);
      } catch (_) {}
      if (owned && typeof sensor.stop === 'function') {
        try {
          sensor.stop();
        } catch (_) {}
      }
    };
    if (owned) sensor.start();
    setState(channel, 'waiting', '');
  }

  function onOriReading(sensor, t) {
    const q = sensor.quaternion;
    if (!isQuaternion(q)) return false;
    latestQuat = [q[0], q[1], q[2], q[3]];
    latestQuatAt = t;
    if (typeof sensor.stable === 'boolean') stable = sensor.stable;
    return true;
  }

  const stabilityListener = {
    event: 'orientationstabilitychange',
    handler: (event) => {
      if (event && typeof event.stable === 'boolean') stable = event.stable;
    }
  };

  function startOriPage() {
    if (!page || typeof page.enableWorldAwareness !== 'function') return false;
    try {
      page.enableWorldAwareness();
      worldAwareness = true;
    } catch (error) {
      ori.error = errorText(error, 'World awareness failed');
      return false;
    }
    const sensor = page.orientationSensor;
    if (!sensor || typeof sensor.addEventListener !== 'function') return false;
    ori.source = 'page';
    attach(ori, sensor, false, onOriReading, stabilityListener);
    return true;
  }

  function startOriGlobal() {
    if (typeof Ori !== 'function') return false;
    let sensor;
    try {
      sensor = new Ori({ frequency: cfg.oriHz });
    } catch (error) {
      setState(ori, 'error', errorText(error, 'Cannot create the orientation sensor'));
      return false;
    }
    ori.source = 'global';
    try {
      attach(ori, sensor, true, onOriReading, stabilityListener);
    } catch (error) {
      setState(ori, 'error', errorText(error, 'Cannot start the orientation sensor'));
      return false;
    }
    return true;
  }

  function startGyro() {
    if (typeof Gyro !== 'function') {
      setState(gyro, 'missing', 'No Gyroscope in this runtime');
      return false;
    }
    try {
      const sensor = new Gyro({ frequency: cfg.gyroHz });
      gyro.source = 'global';
      attach(gyro, sensor, true, (s, t) => motion.push(s.x, s.y, s.z, t), null);
      return true;
    } catch (error) {
      setState(gyro, 'error', errorText(error, 'Cannot start the gyroscope'));
      return false;
    }
  }

  function startAccel() {
    if (accel.state !== 'idle' && accel.state !== 'missing') return accel.state === 'waiting' || accel.state === 'active';
    if (typeof Accel !== 'function') {
      setState(accel, 'missing', 'No Accelerometer in this runtime');
      return false;
    }
    try {
      const sensor = new Accel({ frequency: cfg.accelHz });
      accel.source = 'global';
      // A sample rejected as "accelerating" still proves the sensor is alive.
      attach(accel, sensor, true, (s) => {
        tilt.push(s.x, s.y, s.z);
        return Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z);
      }, null);
      return true;
    } catch (error) {
      setState(accel, 'error', errorText(error, 'Cannot start the accelerometer'));
      return false;
    }
  }

  function stopChannel(channel) {
    if (channel.detach) channel.detach();
    channel.detach = null;
    channel.sensor = null;
    channel.owned = false;
  }

  function oriFailed(t) {
    return ori.state === 'error' || (ori.state === 'waiting' && t - ori.startedAt >= cfg.oriTimeoutMs);
  }

  return {
    config: cfg,

    // Starts the orientation sensor (page-private first, then global) and the
    // gyroscope. The accelerometer starts on demand (fallback or probe).
    start(options) {
      if (started) this.stop();
      started = true;
      const probe = !!(options && options.probe);
      latestQuat = null;
      latestQuatAt = null;
      stable = null;
      motion.reset();
      tilt.reset();
      ori.source = '';
      log('start: ori=' + (typeof Ori) + ' gyro=' + (typeof Gyro) + ' accel=' + (typeof Accel) + ' worldAwareness=' + (page && typeof page.enableWorldAwareness));
      if (!startOriPage() && !startOriGlobal()) {
        if (ori.state === 'idle') setState(ori, 'missing', ori.error || 'No orientation sensor in this runtime');
      }
      startGyro();
      if (probe || ori.state === 'missing') startAccel();
      return ori.state === 'waiting' || accel.state === 'waiting';
    },

    // Advances the fallback chain; call it about twice a second.
    update() {
      if (!started) return;
      const t = now();
      if (oriFailed(t)) {
        if (ori.source === 'page' && typeof Ori === 'function') {
          const reason = ori.state === 'error' ? ori.error : 'no data in ' + Math.round(cfg.oriTimeoutMs / 1000) + ' s';
          log('page orientation sensor failed (' + reason + '); trying the global sensor');
          stopChannel(ori);
          ori.state = 'idle';
          startOriGlobal();
          startAccel(); // armed in parallel so the chain ends sooner
        } else {
          setState(ori, 'silent', ori.error);
          startAccel();
        }
      } else if (ori.state === 'active' && ori.meter.ageMs(t) > cfg.freshMs) {
        setState(ori, 'silent', '');
        startAccel();
      }
      for (const channel of [gyro, accel]) {
        if (channel.state === 'active' && channel.meter.ageMs(t) > cfg.freshMs) setState(channel, 'silent', '');
        else if (channel.state === 'waiting' && t - channel.startedAt >= cfg.oriTimeoutMs) setState(channel, 'silent', '');
      }
    },

    // The best live pose source right now, or null.
    pose() {
      const t = now();
      if (ori.state === 'active' && latestQuat && latestQuatAt !== null && t - latestQuatAt <= cfg.freshMs) {
        return { source: 'ori', quaternion: latestQuat.slice() };
      }
      if (accel.state === 'active' && tilt.ready()) return { source: 'accel', tilt };
      return null;
    },

    hasPendingSource() {
      return ori.state === 'waiting' || accel.state === 'waiting';
    },

    // True while the head has been still for `minMs`; null when the gyroscope
    // is not delivering, so callers can skip the gate.
    isHeadStill(minMs) {
      if (gyro.state !== 'active') return null;
      return motion.isStill(now(), minMs);
    },

    // True/false from the orientation sensor's stability flag, null if unknown.
    orientationStable() {
      return stable;
    },

    tilt() {
      return tilt;
    },

    status() {
      const t = now();
      const entry = (channel) => ({
        state: channel.state,
        source: channel.source,
        error: channel.error,
        hz: Math.round(channel.meter.hz(t)),
        count: channel.meter.count()
      });
      return {
        ori: entry(ori),
        gyro: Object.assign(entry(gyro), { dps: motion.speedDps(), raw: motion.rawMagnitude() }),
        accel: Object.assign(entry(accel), { gravity: tilt.magnitude(), samples: tilt.stats().accepted }),
        stable,
        worldAwareness
      };
    },

    stop() {
      stopChannel(ori);
      stopChannel(gyro);
      stopChannel(accel);
      for (const channel of [ori, gyro, accel]) {
        channel.state = 'idle';
        channel.source = '';
        channel.error = '';
        channel.meter.reset();
      }
      if (worldAwareness && page && typeof page.disableWorldAwareness === 'function') {
        try {
          page.disableWorldAwareness();
        } catch (_) {}
      }
      worldAwareness = false;
      latestQuat = null;
      latestQuatAt = null;
      started = false;
    }
  };
}

function channelLabel(label, channel) {
  switch (channel.state) {
    case 'active':
      return label + ' ' + channel.hz + 'Hz';
    case 'waiting':
      return label + ' …';
    case 'missing':
      return label + ' –';
    case 'error':
      return label + ' !';
    case 'silent':
      return label + ' ?';
    default:
      return label + ' off';
  }
}

function fixed(value, digits) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

// Short texts for the "Sensor check" row and its two detail lines.
export function describeSensors(status, poseSource) {
  const { ori, gyro, accel } = status;
  const row = [channelLabel('ORI', ori), channelLabel('GYR', gyro), channelLabel('ACC', accel)].join(' · ');
  let pose = 'none yet';
  if (poseSource === 'ori') pose = 'orientation sensor (' + (ori.source || '?') + ')';
  else if (poseSource === 'accel') pose = 'accelerometer tilt';
  const failing = [ori, gyro, accel].find((c) => c.state === 'error' || c.state === 'missing');
  const line1 = 'Head pose: ' + pose + (status.stable === false ? ' · settling' : '');
  const line2 =
    'Gyro ' + fixed(gyro.dps, 1) + '°/s (raw ' + fixed(gyro.raw, 3) + ') · gravity ' + fixed(accel.gravity, 2) +
    (failing && failing.error ? ' · ' + failing.error : '');
  return { row, line1, line2 };
}

export { STATES as SENSOR_STATES };
