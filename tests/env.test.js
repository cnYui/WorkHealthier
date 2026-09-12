import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  describeRuntime,
  loadSettings,
  parseRuntimeUserAgent,
  saveSettings,
  SETTINGS_KEY
} from '../agent/lib/env.js';

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map)
  };
}

test('parseRuntimeUserAgent reads the AIUI UA format and tolerates junk', () => {
  const info = parseRuntimeUserAgent('AIUI/0.17.2 (YodaOS Sprite; arm64-v8a) Ink/0.17.2-rc-12');
  assert.equal(info.aiuiVersion, '0.17.2');
  assert.equal(info.systemName, 'YodaOS Sprite');
  assert.equal(info.architecture, 'arm64-v8a');
  assert.equal(info.inkVersion, '0.17.2-rc-12');
  assert.equal(describeRuntime(info), '运行环境：AIUI 0.17.2 · YodaOS Sprite');
  const none = parseRuntimeUserAgent('Mozilla/5.0');
  assert.equal(none.aiuiVersion, '');
  assert.equal(describeRuntime(none), '运行环境：未知');
  assert.equal(parseRuntimeUserAgent(undefined).aiuiVersion, '');
});

test('loadSettings validates every field and falls back to defaults', () => {
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage({ [SETTINGS_KEY]: '{not json' })), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage({ [SETTINGS_KEY]: '[1,2]' })), DEFAULT_SETTINGS);
  const loaded = loadSettings(memoryStorage({
    [SETTINGS_KEY]: JSON.stringify({ kNorm: 0.5, voice: false, calibrationCm: 70, extra: 1 })
  }));
  assert.deepEqual(loaded, { kNorm: 0.5, voice: false, calibrationCm: 70 });
  const bad = loadSettings(memoryStorage({
    [SETTINGS_KEY]: JSON.stringify({ kNorm: -1, voice: 'yes', calibrationCm: 500 })
  }));
  assert.deepEqual(bad, DEFAULT_SETTINGS);
});

test('saveSettings round-trips and reports storage failures', () => {
  const storage = memoryStorage();
  assert.equal(saveSettings(storage, { kNorm: 0.41, voice: true, calibrationCm: 60 }), true);
  assert.deepEqual(loadSettings(storage), { kNorm: 0.41, voice: true, calibrationCm: 60 });
  assert.equal(saveSettings(null, {}), false);
  const broken = { setItem: () => { throw new Error('quota'); }, getItem: () => null };
  assert.equal(saveSettings(broken, {}), false);
});
