import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempleInput, GESTURE_ECHO_MS, GLOBAL_HOOK_HOLD_MS } from '../agent/lib/temple.js';

function harness() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const taps = [];
  const input = createTempleInput({
    now: () => now,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    cancel: (id) => timers.delete(id),
    onLoneGlobalHook: () => taps.push(now)
  });
  function advance(ms) {
    now += ms;
    for (const [id, t] of [...timers.entries()]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  }
  return { input, advance, taps };
}

test('a GlobalHook followed by Enter (simulator tap) does not double-fire', () => {
  const h = harness();
  assert.equal(h.input.globalHookUp(), true);
  h.advance(30);
  h.input.gestureKeyDown();
  h.input.gestureKeyUp();
  h.advance(GLOBAL_HOOK_HOLD_MS + 10);
  assert.deepEqual(h.taps, [], 'the gesture key cancelled the pending hook tap');
  assert.equal(h.input.isPending(), false);
});

test('a lone GlobalHook (physical glasses) becomes one tap after the hold', () => {
  const h = harness();
  h.input.globalHookUp();
  h.advance(GLOBAL_HOOK_HOLD_MS - 1);
  assert.deepEqual(h.taps, []);
  h.advance(1);
  assert.deepEqual(h.taps, [GLOBAL_HOOK_HOLD_MS]);
});

test('a GlobalHook echo right after a gesture key is ignored', () => {
  const h = harness();
  h.input.gestureKeyUp();
  h.advance(GESTURE_ECHO_MS - 50);
  assert.equal(h.input.globalHookUp(), false);
  h.advance(GESTURE_ECHO_MS);
  assert.equal(h.input.globalHookUp(), true);
});

test('dispose cancels a pending tap', () => {
  const h = harness();
  h.input.globalHookUp();
  h.input.dispose();
  h.advance(GLOBAL_HOOK_HOLD_MS + 5);
  assert.deepEqual(h.taps, []);
});
