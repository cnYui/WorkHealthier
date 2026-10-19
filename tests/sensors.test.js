import test from 'node:test';
import assert from 'node:assert/strict';
import { createSensorHub, describeSensors } from '../agent/lib/sensors.js';

// A fake sensor with the Generic-Sensor surface the AIUI docs describe.
class FakeSensor {
  constructor(options) {
    this.options = options;
    this.listeners = {};
    this.started = false;
    this.quaternion = null;
    this.x = null;
    this.y = null;
    this.z = null;
    this.stable = undefined;
  }
  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  emit(name, event) {
    (this.listeners[name] || []).forEach((fn) => fn(event || {}));
  }
  listenerCount() {
    return Object.values(this.listeners).reduce((n, list) => n + list.length, 0);
  }
}

function fixture(overrides) {
  const clock = { t: 0 };
  const logs = [];
  const created = { ori: [], gyro: [], accel: [] };
  const track = (list) => {
    const Cls = class extends FakeSensor {
      constructor(options) {
        super(options);
        list.push(this);
      }
    };
    return Cls;
  };
  const page = {
    worldOn: false,
    orientationSensor: new FakeSensor({ page: true }),
    enableWorldAwareness() {
      this.worldOn = true;
    },
    disableWorldAwareness() {
      this.worldOn = false;
    }
  };
  const env = Object.assign(
    {
      page,
      now: () => clock.t,
      log: (m) => logs.push(m),
      AbsoluteOrientationSensor: track(created.ori),
      Gyroscope: track(created.gyro),
      Accelerometer: track(created.accel)
    },
    overrides || {}
  );
  return { clock, logs, created, page, env, hub: createSensorHub(env) };
}

test('page-private orientation sensor is used first and the gyroscope starts beside it', () => {
  const f = fixture();
  assert.equal(f.hub.start(), true);
  assert.equal(f.page.worldOn, true);
  assert.equal(f.created.gyro.length, 1);
  assert.equal(f.created.gyro[0].options.frequency, 20);
  assert.equal(f.created.gyro[0].started, true);
  assert.equal(f.created.accel.length, 0); // only on demand
  assert.equal(f.created.ori.length, 0); // the global sensor is not needed yet

  const s = f.page.orientationSensor;
  for (let i = 0; i < 10; i += 1) {
    f.clock.t += 50;
    s.quaternion = [0, 0, 0, 1];
    s.emit('reading');
  }
  const pose = f.hub.pose();
  assert.equal(pose.source, 'ori');
  assert.deepEqual(pose.quaternion, [0, 0, 0, 1]);
  const st = f.hub.status();
  assert.equal(st.ori.state, 'active');
  assert.equal(st.ori.source, 'page');
  assert.equal(st.ori.hz, 20);
});

test('a silent page sensor falls back to the global orientation sensor', () => {
  const f = fixture();
  f.hub.start();
  f.clock.t = 2999;
  f.hub.update();
  assert.equal(f.created.ori.length, 0);
  f.clock.t = 3000;
  f.hub.update();
  assert.equal(f.created.ori.length, 1);
  assert.equal(f.created.accel.length, 1); // fallback armed in parallel
  assert.equal(f.created.ori[0].options.frequency, 30);
  assert.equal(f.created.ori[0].started, true);
  assert.equal(f.page.orientationSensor.listenerCount(), 0);
  assert.equal(f.page.worldOn, true); // head gestures keep working

  f.clock.t = 3100;
  f.created.ori[0].quaternion = [0.1, 0, 0, 0.995];
  f.created.ori[0].emit('reading');
  assert.equal(f.hub.pose().source, 'ori');
  assert.equal(f.hub.status().ori.source, 'global');
});

test('an error event on the page sensor falls back on the next update', () => {
  const f = fixture();
  f.hub.start();
  f.clock.t = 100;
  f.page.orientationSensor.emit('error', { error: { message: 'no capability' } });
  assert.equal(f.hub.status().ori.state, 'error');
  assert.equal(f.hub.status().ori.error, 'no capability');
  f.hub.update();
  assert.equal(f.created.ori.length, 1);
});

test('with no orientation data at all the accelerometer provides pitch and roll', () => {
  const f = fixture();
  f.hub.start();
  f.clock.t = 3000;
  f.hub.update(); // page -> global, accelerometer armed
  f.clock.t = 6000;
  f.hub.update(); // global silent too
  assert.equal(f.hub.status().ori.state, 'silent');
  assert.equal(f.created.accel.length, 1);
  assert.equal(f.hub.pose(), null); // accelerometer has not delivered yet

  const acc = f.created.accel[0];
  for (let i = 0; i < 20; i += 1) {
    f.clock.t += 50;
    acc.x = 0;
    acc.y = 9.8;
    acc.z = 0;
    acc.emit('reading');
  }
  const pose = f.hub.pose();
  assert.equal(pose.source, 'accel');
  assert.equal(pose.tilt.setBaseline(), true);
  // Look down 20 degrees.
  for (let i = 0; i < 60; i += 1) {
    f.clock.t += 50;
    acc.y = 9.8 * Math.cos((20 * Math.PI) / 180);
    acc.z = 9.8 * Math.sin((20 * Math.PI) / 180);
    acc.emit('reading');
  }
  const rel = f.hub.pose().tilt.relative();
  assert.ok(Math.abs(rel.pitch - 20) < 0.5, `pitch ${rel.pitch}`);
  assert.equal(f.hub.status().accel.state, 'active');
});

test('when every sensor stays silent nothing is pending and the pose stays empty', () => {
  const f = fixture();
  assert.equal(f.hub.start(), true);
  assert.equal(f.hub.hasPendingSource(), true);
  f.clock.t = 3000;
  f.hub.update();
  assert.equal(f.hub.hasPendingSource(), true); // global + accelerometer just started
  f.clock.t = 6000;
  f.hub.update();
  assert.equal(f.hub.hasPendingSource(), false);
  assert.equal(f.hub.pose(), null);
  const st = f.hub.status();
  assert.equal(st.ori.state, 'silent');
  assert.equal(st.accel.state, 'silent');
  assert.equal(st.gyro.state, 'silent');
});

test('a missing runtime reports every sensor as missing and has no pose', () => {
  const f = fixture({ page: null, AbsoluteOrientationSensor: undefined, Gyroscope: undefined, Accelerometer: undefined });
  assert.equal(f.hub.start(), false);
  const st = f.hub.status();
  assert.equal(st.ori.state, 'missing');
  assert.equal(st.gyro.state, 'missing');
  assert.equal(st.accel.state, 'missing');
  assert.equal(f.hub.pose(), null);
  assert.equal(f.hub.isHeadStill(100), null);
  f.hub.update(); // must not throw
});

test('without a page sensor the global orientation sensor is the first choice', () => {
  const f = fixture({ page: { enableWorldAwareness() {}, orientationSensor: null } });
  assert.equal(f.hub.start(), true);
  assert.equal(f.created.ori.length, 1);
  assert.equal(f.hub.status().ori.source, 'global');
});

test('probe mode starts the accelerometer even when orientation works', () => {
  const f = fixture();
  f.hub.start({ probe: true });
  assert.equal(f.created.accel.length, 1);
  assert.equal(f.created.accel[0].options.frequency, 20);
});

test('gyroscope readings gate the baseline: still head vs moving head', () => {
  const f = fixture();
  f.hub.start();
  assert.equal(f.hub.isHeadStill(500), null); // no gyro data yet
  const gyro = f.created.gyro[0];
  f.clock.t = 100;
  gyro.x = 1.2; gyro.y = 0; gyro.z = 0;
  gyro.emit('reading');
  assert.equal(f.hub.isHeadStill(500), false);
  for (let t = 200; t <= 1200; t += 100) {
    f.clock.t = t;
    gyro.x = 0.005; gyro.y = 0; gyro.z = 0.002;
    gyro.emit('reading');
  }
  assert.equal(f.hub.isHeadStill(500), true);
  const st = f.hub.status();
  assert.equal(st.gyro.state, 'active');
  assert.ok(st.gyro.dps < 5);
});

test('orientation stability flag is tracked from the sensor and its event', () => {
  const f = fixture();
  f.hub.start();
  assert.equal(f.hub.orientationStable(), null);
  const s = f.page.orientationSensor;
  s.listeners.orientationstabilitychange[0]({ stable: false });
  assert.equal(f.hub.orientationStable(), false);
  f.clock.t = 100;
  s.quaternion = [0, 0, 0, 1];
  s.stable = true;
  s.emit('reading');
  assert.equal(f.hub.orientationStable(), true);
});

test('invalid orientation readings are ignored and never become a pose', () => {
  const f = fixture();
  f.hub.start();
  const s = f.page.orientationSensor;
  f.clock.t = 100;
  s.quaternion = null;
  s.emit('reading');
  s.quaternion = [NaN, 0, 0, 1];
  s.emit('reading');
  assert.equal(f.hub.pose(), null);
  assert.equal(f.hub.status().ori.state, 'waiting');
});

test('stop detaches listeners, stops owned sensors and disables world awareness', () => {
  const f = fixture();
  f.hub.start({ probe: true });
  f.hub.stop();
  assert.equal(f.page.worldOn, false);
  assert.equal(f.page.orientationSensor.listenerCount(), 0);
  assert.equal(f.created.gyro[0].started, false);
  assert.equal(f.created.gyro[0].listenerCount(), 0);
  assert.equal(f.created.accel[0].started, false);
  assert.equal(f.hub.status().ori.state, 'idle');
  assert.equal(f.hub.pose(), null);
  // start again after a stop
  assert.equal(f.hub.start(), true);
});

test('a stale orientation reading stops counting as a live pose', () => {
  const f = fixture();
  f.hub.start();
  const s = f.page.orientationSensor;
  f.clock.t = 100;
  s.quaternion = [0, 0, 0, 1];
  s.emit('reading');
  assert.equal(f.hub.pose().source, 'ori');
  f.clock.t = 2200;
  assert.equal(f.hub.pose(), null);
  f.hub.update();
  assert.equal(f.hub.status().ori.state, 'silent');
  assert.equal(f.created.accel.length, 1); // fallback armed
  // A late reading brings it back.
  f.clock.t = 2300;
  s.emit('reading');
  assert.equal(f.hub.pose().source, 'ori');
});

test('describeSensors summarises every channel for the Sensor check row', () => {
  const f = fixture();
  f.hub.start();
  f.clock.t = 100;
  const s = f.page.orientationSensor;
  for (let i = 0; i < 10; i += 1) {
    f.clock.t += 50;
    s.quaternion = [0, 0, 0, 1];
    s.emit('reading');
  }
  const gyro = f.created.gyro[0];
  gyro.x = 0.1; gyro.y = 0; gyro.z = 0;
  gyro.emit('reading');
  const text = describeSensors(f.hub.status(), 'ori');
  assert.equal(text.row, 'ORI 20Hz · GYR 0Hz · ACC off');
  assert.equal(text.line1, 'Head pose: orientation sensor (page)');
  assert.match(text.line2, /^Gyro 5\.7°\/s \(raw 0\.100\) · gravity --$/);

  const none = createSensorHub({ page: null, now: () => 0 });
  none.start();
  const missing = describeSensors(none.status(), '');
  assert.equal(missing.row, 'ORI – · GYR – · ACC –');
  assert.match(missing.line1, /none yet/);
  assert.match(missing.line2, /No orientation sensor in this runtime/);
});
