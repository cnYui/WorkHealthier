import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, formatClock, formatMinutes, SESSION_DEFAULTS } from '../agent/lib/session.js';

test('formatClock and formatMinutes', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(65000), '01:05');
  assert.equal(formatClock(3600000 + 61000), '1:01:01');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(undefined), '00:00');
  assert.equal(formatMinutes(90000), '2 min');
  assert.equal(formatMinutes(3600000), '1 h');
  assert.equal(formatMinutes(3900000), '1 h 5 min');
});

test('elapsed time excludes paused intervals', () => {
  const s = createSession();
  assert.equal(s.elapsed(100), 0);
  assert.equal(s.start(1000), true);
  assert.equal(s.start(2000), false);
  assert.equal(s.elapsed(4000), 3000);
  assert.equal(s.pause(4000), true);
  assert.equal(s.elapsed(9000), 3000);
  assert.equal(s.resume(9000), true);
  assert.equal(s.resume(9000), false);
  assert.equal(s.elapsed(10000), 4000);
  assert.equal(s.isRunning(), true);
});

test('sedentary reminder fires once, resets on dismiss, and honours the cooldown', () => {
  const s = createSession();
  s.start(0);
  assert.equal(s.tick(SESSION_DEFAULTS.sedentaryMs - 1).active, false);
  assert.equal(s.tick(SESSION_DEFAULTS.sedentaryMs).active, true);
  assert.equal(s.snapshot(SESSION_DEFAULTS.sedentaryMs).reminders, 1);
  const dismissedAt = SESSION_DEFAULTS.sedentaryMs + 5000;
  assert.equal(s.dismissReminder(dismissedAt), true);
  assert.equal(s.dismissReminder(dismissedAt), false);
  assert.equal(s.sittingMs(dismissedAt + 1000), 1000);
  assert.equal(s.tick(dismissedAt + SESSION_DEFAULTS.sedentaryMs - 1).active, false);
  assert.equal(s.tick(dismissedAt + SESSION_DEFAULTS.sedentaryMs).active, true);
});

test('tick does nothing before start or while paused', () => {
  const s = createSession({ sedentaryMs: 1000 });
  assert.equal(s.tick(5000).active, false);
  s.start(0);
  s.pause(10);
  assert.equal(s.tick(5000).active, false);
  s.resume(5000);
  assert.equal(s.tick(6000).active, true);
});
