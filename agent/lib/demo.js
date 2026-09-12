// Scripted demo scenario for environments without sensors (AIUI Studio's
// browser simulator has neither an IMU nor a camera). The scenario is a pure
// function of elapsed demo time so it is deterministic and testable.

export const DEMO_LOOP_MS = 150000;

// Each segment: [startSec, endSec, pitchDeg, rollDeg, distanceCm, markerFound]
export const DEMO_TIMELINE = Object.freeze([
  [0, 15, 2, 1, 62, true], // good posture, good distance
  [15, 45, 24, 2, 60, true], // head down -> alert after dwell
  [45, 60, 3, 0, 61, true], // recovered
  [60, 90, 4, 1, 38, true], // too close to the screen -> alert
  [90, 105, 2, 0, 66, true], // recovered
  [105, 125, 3, 16, 64, true], // head tilted sideways -> alert
  [125, 135, 1, 1, 58, false], // marker not visible
  [135, 150, 1, 0, 70, true] // good again
]);

const DEMO_LABELS = Object.freeze([
  'Demo: good posture',
  'Demo: head down',
  'Demo: posture recovered',
  'Demo: too close to the screen',
  'Demo: distance recovered',
  'Demo: head tilted',
  'Demo: marker out of view',
  'Demo: all good'
]);

function segmentAt(sec) {
  for (let i = 0; i < DEMO_TIMELINE.length; i += 1) {
    const s = DEMO_TIMELINE[i];
    if (sec >= s[0] && sec < s[1]) return s;
  }
  return DEMO_TIMELINE[DEMO_TIMELINE.length - 1];
}

// Small deterministic wobble so values look alive without randomness.
function wobble(sec, amplitude, period) {
  return Math.sin((sec / period) * Math.PI * 2) * amplitude;
}

export function demoSample(elapsedMs) {
  const sec = ((Math.max(0, elapsedMs) / 1000) % (DEMO_LOOP_MS / 1000));
  const seg = segmentAt(sec);
  return {
    pitchDeg: seg[2] + wobble(sec, 1.2, 4),
    rollDeg: seg[3] + wobble(sec, 0.6, 5),
    distanceCm: seg[4] + wobble(sec, 1.5, 7),
    markerFound: seg[5],
    segmentIndex: DEMO_TIMELINE.indexOf(seg),
    loopSec: sec
  };
}

// Human-readable description of what the demo is currently showing.
export function demoLabel(segmentIndex) {
  return DEMO_LABELS[segmentIndex] || 'Demo';
}
