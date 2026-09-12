// Runtime environment helpers: user-agent parsing and safe storage access.

const UA_AIUI = /(?:^|\s)AIUI\/([0-9]+(?:\.[0-9]+){1,3})(?=\s|\(|$)/;
const UA_INK = /(?:^|\s)Ink\/([0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?)(?=\s|$)/;
const UA_PLATFORM = /AIUI\/[0-9]+(?:\.[0-9]+){1,3}\s*\(([^;()]+);\s*([^)]+)\)/;

export function parseRuntimeUserAgent(userAgent) {
  const source = typeof userAgent === 'string' ? userAgent.trim() : '';
  const aiui = source.match(UA_AIUI);
  const ink = source.match(UA_INK);
  const platform = source.match(UA_PLATFORM);
  return {
    aiuiVersion: aiui && aiui[1] ? aiui[1] : '',
    inkVersion: ink && ink[1] ? ink[1] : '',
    systemName: platform && platform[1] ? platform[1].trim() : '',
    architecture: platform && platform[2] ? platform[2].trim() : ''
  };
}

export function describeRuntime(info) {
  if (!info || !info.aiuiVersion) return 'Runtime: unknown';
  const parts = ['AIUI ' + info.aiuiVersion];
  if (info.systemName) parts.push(info.systemName);
  return 'Runtime: ' + parts.join(' · ');
}

export function readUserAgent() {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '';
  } catch (error) {
    return '';
  }
}

export function storageOrNull() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (error) {
    return null;
  }
}

export const SETTINGS_KEY = 'workhealthier.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  kNorm: null, // calibrated focal constant; null = use the built-in estimate
  voice: true,
  calibrationCm: 60
});

export function loadSettings(storage) {
  if (!storage) return Object.assign({}, DEFAULT_SETTINGS);
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (typeof raw !== 'string' || raw === '') return Object.assign({}, DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
    const settings = Object.assign({}, DEFAULT_SETTINGS);
    if (typeof parsed.kNorm === 'number' && Number.isFinite(parsed.kNorm) && parsed.kNorm > 0) {
      settings.kNorm = parsed.kNorm;
    }
    if (typeof parsed.voice === 'boolean') settings.voice = parsed.voice;
    if (Number.isInteger(parsed.calibrationCm) && parsed.calibrationCm >= 30 && parsed.calibrationCm <= 120) {
      settings.calibrationCm = parsed.calibrationCm;
    }
    return settings;
  } catch (error) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

export function saveSettings(storage, settings) {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    return false;
  }
}
