// Screen-distance estimation from a QR marker seen by the glasses camera.
//
// Rokid Glasses expose no rangefinder to AIUI, so distance is derived from
// the apparent size of a marker of known physical width:
//
//     distance = K * markerMm / sideNorm
//
// where `sideNorm` is the marker's longest side in the photo divided by the
// photo width (resolution independent) and `K` is the camera focal length
// expressed in image widths. `K` defaults to a value derived from the Rokid
// Glasses camera field of view and can be replaced by a one-tap calibration
// at a known distance, which also cancels any error in the marker size.

export const DISTANCE_DEFAULTS = Object.freeze({
  tooCloseCm: 45, // sustained: alert
  closeCm: 52, // warn band
  farCm: 85, // info only
  dwellMs: 15000, // too-close must persist this long before an alert
  minDwellSamples: 2, // and at least this many consecutive samples
  cooldownMs: 60000,
  smoothing: 0.5,
  missLimit: 3, // consecutive frames without marker before "no marker"
  defaultKNorm: 0.446, // focal length / image width for ~96 deg horizontal FOV
  defaultMarkerMm: 50,
  minCm: 15,
  maxCm: 300,
  calibrationCm: 60
});

export const MARKER_PREFIX = 'WH:';

export function parseMarkerPayload(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const text = rawValue.trim();
  if (!text.startsWith(MARKER_PREFIX)) return null;
  const mm = Number.parseInt(text.slice(MARKER_PREFIX.length), 10);
  if (!Number.isFinite(mm) || mm < 10 || mm > 500) return null;
  return mm;
}

function pointDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Longest side of the detected quadrilateral, normalized by image width.
export function markerSideNormalized(barcode, imageWidth) {
  if (!barcode || typeof imageWidth !== 'number' || imageWidth <= 0) return null;
  const pts = barcode.cornerPoints;
  let side = 0;
  if (Array.isArray(pts) && pts.length >= 4 && pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
    for (let i = 0; i < 4; i += 1) {
      side = Math.max(side, pointDistance(pts[i], pts[(i + 1) % 4]));
    }
  } else if (barcode.boundingBox && Number.isFinite(barcode.boundingBox.width)) {
    side = Math.max(barcode.boundingBox.width, barcode.boundingBox.height || 0);
  }
  if (!(side > 0)) return null;
  return side / imageWidth;
}

export function selectMarker(barcodes) {
  if (!Array.isArray(barcodes)) return null;
  let best = null;
  let bestSize = 0;
  barcodes.forEach((b) => {
    const mm = parseMarkerPayload(b && b.rawValue);
    if (mm === null) return;
    const size = b.boundingBox && Number.isFinite(b.boundingBox.width) ? b.boundingBox.width : 1;
    if (best === null || size > bestSize) {
      best = { barcode: b, markerMm: mm };
      bestSize = size;
    }
  });
  return best;
}

export function distanceCmFrom(sideNorm, markerMm, kNorm) {
  if (!(sideNorm > 0) || !(markerMm > 0) || !(kNorm > 0)) return null;
  return (kNorm * markerMm) / sideNorm / 10;
}

export function kNormFrom(sideNorm, markerMm, knownDistanceCm) {
  if (!(sideNorm > 0) || !(markerMm > 0) || !(knownDistanceCm > 0)) return null;
  return (knownDistanceCm * 10 * sideNorm) / markerMm;
}

export function classifyDistance(cm, cfg) {
  const c = cfg || DISTANCE_DEFAULTS;
  if (typeof cm !== 'number' || !Number.isFinite(cm)) return 'unknown';
  if (cm < c.tooCloseCm) return 'too-close';
  if (cm < c.closeCm) return 'close';
  if (cm > c.farCm) return 'far';
  return 'good';
}

export function createDistanceMonitor(options) {
  const cfg = Object.assign({}, DISTANCE_DEFAULTS, options || {});
  const state = {
    kNorm: cfg.defaultKNorm,
    calibrated: false,
    hasReading: false,
    cm: null,
    lastCm: null,
    level: 'unknown', // unknown | too-close | close | good | far
    markerState: 'idle', // idle | found | missing
    misses: 0,
    closeSince: null,
    closeSamples: 0,
    alertActive: false,
    alertSince: null,
    dismissedUntil: 0,
    stats: { samples: 0, found: 0, alerts: 0, minCm: null, maxCm: null }
  };

  function snapshot() {
    return {
      kNorm: state.kNorm,
      calibrated: state.calibrated,
      hasReading: state.hasReading,
      cm: state.cm,
      lastCm: state.lastCm,
      level: state.level,
      markerState: state.markerState,
      alert: { active: state.alertActive, since: state.alertSince },
      stats: Object.assign({}, state.stats)
    };
  }

  function clearAlert() {
    state.alertActive = false;
    state.alertSince = null;
    state.closeSince = null;
    state.closeSamples = 0;
  }

  return {
    config: cfg,

    setKNorm(kNorm, calibrated) {
      if (!(kNorm > 0)) return false;
      state.kNorm = kNorm;
      state.calibrated = !!calibrated;
      return true;
    },

    // A detection result: `found` false means no marker in this frame.
    update(sample, now) {
      state.stats.samples += 1;
      if (!sample || !sample.found) {
        state.misses += 1;
        if (state.misses >= cfg.missLimit) {
          state.markerState = 'missing';
          state.lastCm = state.cm !== null ? state.cm : state.lastCm;
          state.cm = null;
          state.level = 'unknown';
          state.closeSince = null;
          state.closeSamples = 0;
        }
        return snapshot();
      }
      const raw = distanceCmFrom(sample.sideNorm, sample.markerMm, state.kNorm);
      if (raw === null) {
        return snapshot();
      }
      const cm = Math.min(cfg.maxCm, Math.max(cfg.minCm, raw));
      state.misses = 0;
      state.markerState = 'found';
      state.stats.found += 1;
      if (!state.hasReading || state.cm === null) {
        state.cm = cm;
        state.hasReading = true;
      } else {
        state.cm += (cm - state.cm) * cfg.smoothing;
      }
      state.lastCm = state.cm;
      state.stats.minCm = state.stats.minCm === null ? state.cm : Math.min(state.stats.minCm, state.cm);
      state.stats.maxCm = state.stats.maxCm === null ? state.cm : Math.max(state.stats.maxCm, state.cm);
      state.level = classifyDistance(state.cm, cfg);

      if (state.level === 'too-close') {
        if (state.closeSince === null) state.closeSince = now;
        state.closeSamples += 1;
        const sustained =
          now - state.closeSince >= cfg.dwellMs && state.closeSamples >= cfg.minDwellSamples;
        if (!state.alertActive && sustained && now >= state.dismissedUntil) {
          state.alertActive = true;
          state.alertSince = now;
          state.stats.alerts += 1;
        }
      } else {
        state.closeSince = null;
        state.closeSamples = 0;
        if (state.alertActive && state.level !== 'close') clearAlert();
      }
      return snapshot();
    },

    // Calibrate from the current frame at a known distance; returns the new K.
    calibrate(sideNorm, markerMm, knownDistanceCm) {
      const k = kNormFrom(sideNorm, markerMm, knownDistanceCm);
      if (k === null) return null;
      state.kNorm = k;
      state.calibrated = true;
      state.cm = knownDistanceCm;
      state.lastCm = knownDistanceCm;
      state.hasReading = true;
      state.markerState = 'found';
      state.misses = 0;
      state.level = classifyDistance(knownDistanceCm, cfg);
      clearAlert();
      return k;
    },

    dismissAlert(now) {
      if (!state.alertActive) return false;
      clearAlert();
      state.dismissedUntil = now + cfg.cooldownMs;
      return true;
    },

    reset() {
      state.hasReading = false;
      state.cm = null;
      state.lastCm = null;
      state.level = 'unknown';
      state.markerState = 'idle';
      state.misses = 0;
      state.dismissedUntil = 0;
      clearAlert();
    },

    snapshot
  };
}
