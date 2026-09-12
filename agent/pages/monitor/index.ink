<script def>
{
  "navigationBarTitleText": "WorkHealthier",
  "description": "Open the posture and screen-distance monitor. Invoke when the user says things like start posture monitoring, watch my posture, remind me to keep my distance from the screen, I keep looking down, or open WorkHealthier. Pass demo=true for 'show me a demo'; pass calibrateCm for 'calibrate at 60 cm'.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["both", "posture", "distance"],
          "default": "both",
          "description": "What to monitor: both posture and screen distance, posture only (head pose), or distance only."
        },
        "demo": {
          "type": "boolean",
          "description": "When true, play scripted data through every alert state instead of using the sensor and camera."
        },
        "calibrateCm": {
          "type": "integer",
          "minimum": 30,
          "maximum": 120,
          "description": "Known eye-to-marker distance in centimetres the user will calibrate at, for example 60."
        }
      }
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import { createPostureMonitor, goodPercent } from '../../lib/posture.js';
import { createDistanceMonitor, DISTANCE_DEFAULTS } from '../../lib/distance.js';
import { createSession, formatClock } from '../../lib/session.js';
import { createTempleInput } from '../../lib/temple.js';
import { demoSample, demoLabel } from '../../lib/demo.js';
import { captureMarkerSample, captureErrorCode } from '../../lib/capture.js';
import { decodeWebP } from '../../lib/webp.js';
import { DEFAULT_AXIS_MAP } from '../../lib/quat.js';
import {
  describeRuntime,
  loadSettings,
  parseRuntimeUserAgent,
  readUserAgent,
  saveSettings,
  storageOrNull
} from '../../lib/env.js';

const TICK_MS = 500;
const BASELINE_COUNTDOWN_MS = 3000;
const CAPTURE_INTERVAL_MS = 20000;
const DEMO_DISTANCE_INTERVAL_MS = 2000;
const AUTO_DEMO_DELAY_MS = 1500;
const SENSOR_TIMEOUT_MS = 6000;
const TOAST_MS = 2500;
const SPEECH_GAP_MS = 20000;
const MAX_CAPTURE_FAILURES = 3;

const FOCUS_POSTURE = 0;
const FOCUS_DISTANCE = 1;
const FOCUS_CALIBRATE = 2;
const FOCUS_VOICE = 3;
const FOCUS_DEMO = 4;
const FOCUS_COUNT = 5;

const MARK = { off: '○', ok: '√', warn: '△', bad: '▲' };

const POSTURE_ALERTS = {
  'pitch-down': {
    title: 'Head down too long',
    body: 'Lift your head, tuck your chin, eyes level with the screen',
    speech: 'Head down too long. Please lift your head and relax your neck.'
  },
  'pitch-up': {
    title: 'Head up too long',
    body: 'Lower your gaze, or lower the screen a little',
    speech: 'Head up too long. Please lower your gaze.'
  },
  roll: {
    title: 'Head tilted',
    body: 'Straighten your head and level your shoulders',
    speech: 'Your head is tilted. Please straighten it.'
  }
};
const DISTANCE_ALERT = {
  title: 'Too close to the screen',
  body: 'Lean back and keep at least 50 cm',
  speech: 'You are too close to the screen. Please lean back.'
};
const SEDENTARY_ALERT = {
  title: 'Sitting for 45 minutes',
  body: 'Stand up for two minutes and look into the distance',
  speech: 'You have been sitting for forty-five minutes. Time to stand up and move.'
};

function parseQuery(query) {
  const input = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const mode = input.mode === 'posture' || input.mode === 'distance' ? input.mode : 'both';
  const demo = input.demo === true ? true : input.demo === false ? false : null;
  let calibrateCm = null;
  if (Number.isInteger(input.calibrateCm) && input.calibrateCm >= 30 && input.calibrateCm <= 120) {
    calibrateCm = input.calibrateCm;
  }
  return { mode, demo, calibrateCm };
}

function joinClass(parts) {
  return parts.filter(Boolean).join(' ');
}

function formatDeg(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return Math.round(Math.abs(value)) + '°';
}

function formatCm(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-- cm';
  return Math.round(value) + ' cm';
}

function ageText(now, at) {
  if (typeof at !== 'number') return 'not measured yet';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  return sec < 60 ? sec + ' s ago' : Math.round(sec / 60) + ' min ago';
}

function initialData() {
  return {
    phaseChip: 'STARTING',
    clock: '00:00',
    postureClass: 'tile tile-posture tone-off is-focus',
    postureMark: MARK.off,
    postureLabel: 'Starting',
    postureDetail: 'Connecting the pose sensor',
    distanceClass: 'tile tile-distance tone-off',
    distanceMark: MARK.off,
    distanceLabel: '-- cm',
    distanceDetail: 'Needs the marker on your monitor',
    detail1: '',
    detail2: '',
    calibrateClass: 'row',
    calibrateText: 'Calibrate distance at 60 cm',
    calibrateState: 'Not calibrated',
    voiceClass: 'row',
    voiceState: 'On',
    demoClass: 'row',
    demoState: 'Off',
    alertClass: 'alert alert-off',
    alertMark: MARK.bad,
    alertTitle: '',
    alertBody: '',
    hint: '',
    toast: '',
    envText: 'Runtime: unknown'
  };
}

export default {
  data: initialData(),

  onLoad(query) {
    this._query = parseQuery(query);
    this._settings = loadSettings(storageOrNull());
    if (this._query.calibrateCm !== null) this._settings.calibrationCm = this._query.calibrateCm;
    this._posture = createPostureMonitor();
    this._distance = createDistanceMonitor();
    if (this._settings.kNorm !== null) this._distance.setKNorm(this._settings.kNorm, true);
    this._session = createSession();
    this._temple = createTempleInput({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (id) => clearTimeout(id),
      onLoneGlobalHook: () => this._primaryAction()
    });

    this._view = {};
    this._visible = false;
    this._tickTimer = null;
    this._tickStats = { count: 0, lastAt: 0, periodMs: 0 };
    this._captureTimer = null;
    this._toastTimer = null;
    this._autoDemoTimer = null;
    this._focus = FOCUS_POSTURE;
    this._phase = 'ready'; // ready | calibrating | monitoring
    this._baselineDueAt = null;
    this._sensor = null;
    this._sensorOwned = false; // true when this page created a standalone sensor
    this._sensorStartedAt = 0;
    this._sensorError = '';
    this._lastQuaternion = null;
    this._lastReadingAt = null;
    this._readingCount = 0;
    this._cameraCtx = null;
    this._cameraState = 'unknown'; // unknown | ready | unavailable | denied | manual | stopped
    this._cameraError = '';
    this._capturing = false;
    this._captureFailures = 0;
    this._lastCaptureAt = null;
    this._lastCaptureInfo = '';
    this._calibrationPending = false;
    this._demo = { active: false, startedAt: 0, lastDistanceAt: 0, label: '' };
    this._alertKey = '';
    this._lastSpokenAt = -Infinity;

    const runtime = parseRuntimeUserAgent(readUserAgent());
    this._push(Object.assign(initialData(), {
      envText: describeRuntime(runtime),
      calibrateText: 'Calibrate distance at ' + this._settings.calibrationCm + ' cm',
      calibrateState: this._settings.kNorm !== null ? 'Calibrated' : 'Not calibrated',
      voiceState: this._settings.voice ? 'On' : 'Off'
    }));

    if (this._query.demo === true) {
      this._enterDemo('Demo mode requested');
      return;
    }
    const sensorOk = this._query.mode === 'distance' ? false : this._startSensors();
    const cameraOk = this._query.mode === 'posture' ? false : this._probeCamera();
    if (sensorOk) {
      this._beginSession();
    } else if (this._query.mode !== 'distance') {
      this._phase = 'ready';
    }
    if (!sensorOk && !cameraOk && this._query.demo !== false) {
      this._autoDemoTimer = setTimeout(() => {
        this._autoDemoTimer = null;
        if (!this._demo.active) this._enterDemo('No sensor or camera here; entering demo mode');
      }, AUTO_DEMO_DELAY_MS);
    } else if (!sensorOk && cameraOk) {
      // Distance-only: the session starts on the first tap (camera needs a user interaction).
      this._phase = 'ready';
    }
    this._render(Date.now());
  },

  onShow() {
    this._visible = true;
    this._startTick();
    this._startCaptureLoop();
    this._render(Date.now());
  },

  onHide() {
    this._visible = false;
    this._stopTick();
    this._stopCaptureLoop();
  },

  onUnload() {
    this._visible = false;
    this._stopTick();
    this._stopCaptureLoop();
    if (this._autoDemoTimer !== null) clearTimeout(this._autoDemoTimer);
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    if (this._temple) this._temple.dispose();
    this._releaseSensors();
  },

  onHeadGesture(event) {
    if (!this._visible || !event || event.gesture !== 'nod') return;
    if (this._alertKey) this._dismissAlert();
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (code === 'Enter' || code === 'ArrowUp' || code === 'ArrowDown') {
      this._temple.gestureKeyDown();
    }
  },

  onKeyUp(event) {
    if (!event) return;
    const code = event.code;
    if (code === 'Enter') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this._temple.gestureKeyUp();
      this._primaryAction();
    } else if (code === 'ArrowUp') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this._temple.gestureKeyUp();
      this._moveFocus(-1);
    } else if (code === 'ArrowDown') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this._temple.gestureKeyUp();
      this._moveFocus(1);
    } else if (code === 'GlobalHook') {
      this._temple.globalHookUp();
    }
    // Backspace keeps the host default: go back / close the agent.
  },

  // ---- sensors -----------------------------------------------------------

  _startSensors() {
    this._releaseSensors();
    let sensor = null;
    try {
      if (typeof this.enableWorldAwareness === 'function') {
        this.enableWorldAwareness();
        if (this.orientationSensor && typeof this.orientationSensor.addEventListener === 'function') {
          sensor = this.orientationSensor;
        }
      }
    } catch (error) {
      this._sensorError = String(error);
    }
    if (!sensor && typeof AbsoluteOrientationSensor !== 'undefined') {
      try {
        sensor = new AbsoluteOrientationSensor({ frequency: 30 });
        this._sensorOwned = true;
      } catch (error) {
        this._sensorError = String(error);
        sensor = null;
      }
    }
    if (!sensor) {
      if (!this._sensorError) this._sensorError = 'No pose sensor in this runtime';
      return false;
    }
    this._sensor = sensor;
    this._sensorStartedAt = Date.now();
    this._onReading = () => {
      const q = sensor.quaternion;
      if (!q) return;
      this._lastQuaternion = [q[0], q[1], q[2], q[3]];
      this._lastReadingAt = Date.now();
      this._readingCount += 1;
    };
    this._onSensorError = (event) => {
      this._sensorError = event && event.message ? String(event.message) : 'Sensor read failed';
      this._lastQuaternion = null;
    };
    try {
      sensor.addEventListener('reading', this._onReading);
      sensor.addEventListener('error', this._onSensorError);
      if (this._sensorOwned) sensor.start();
    } catch (error) {
      this._sensorError = String(error);
      this._releaseSensors();
      return false;
    }
    this._sensorError = '';
    return true;
  },

  _releaseSensors() {
    const sensor = this._sensor;
    if (sensor) {
      try {
        if (this._onReading) sensor.removeEventListener('reading', this._onReading);
        if (this._onSensorError) sensor.removeEventListener('error', this._onSensorError);
        if (this._sensorOwned && typeof sensor.stop === 'function') sensor.stop();
      } catch (_) {}
    }
    if (!this._sensorOwned && sensor && typeof this.disableWorldAwareness === 'function') {
      try {
        this.disableWorldAwareness();
      } catch (_) {}
    }
    this._sensor = null;
    this._sensorOwned = false;
    this._lastQuaternion = null;
  },

  // ---- camera ------------------------------------------------------------

  _probeCamera() {
    try {
      const ctx = wx && wx.media && typeof wx.media.createCameraContext === 'function'
        ? wx.media.createCameraContext()
        : undefined;
      if (!ctx) {
        this._cameraState = 'unavailable';
        this._cameraError = 'No camera in this runtime';
        return false;
      }
      this._cameraCtx = ctx;
    } catch (error) {
      this._cameraState = 'unavailable';
      this._cameraError = String(error);
      return false;
    }
    if (typeof BarcodeDetector === 'undefined') {
      this._cameraState = 'unavailable';
      this._cameraError = 'No barcode detector in this runtime';
      return false;
    }
    try {
      this._detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (error) {
      try {
        this._detector = new BarcodeDetector();
      } catch (inner) {
        this._cameraState = 'unavailable';
        this._cameraError = String(inner);
        return false;
      }
    }
    this._cameraState = 'ready';
    this._cameraError = '';
    return true;
  },

  _startCaptureLoop() {
    if (this._captureTimer !== null || this._demo.active) return;
    if (this._cameraState !== 'ready' || this._phase === 'ready') return;
    this._captureTimer = setInterval(() => {
      this._captureOnce('interval');
    }, CAPTURE_INTERVAL_MS);
  },

  _stopCaptureLoop() {
    if (this._captureTimer === null) return;
    clearInterval(this._captureTimer);
    this._captureTimer = null;
  },

  _captureOnce(reason) {
    if (this._capturing || this._demo.active) return;
    if (this._cameraState !== 'ready' && this._cameraState !== 'manual') return;
    if (!this._cameraCtx || !this._detector) return;
    const ctx = this._cameraCtx;
    const detector = this._detector;
    this._capturing = true;
    this._render(Date.now());
    captureMarkerSample({
      now: () => Date.now(),
      takePhoto: () => ctx.takePhoto({ quality: 'low', enableSystemPreview: false }),
      decodeWebP,
      detect: (image) => detector.detect(image)
    }).then((sample) => {
      const now = Date.now();
      this._capturing = false;
      this._captureFailures = 0;
      this._lastCaptureAt = now;
      this._lastCaptureInfo = sample.imageWidth + '×' + sample.imageHeight + ' · photo ' +
        Math.round(sample.timings.photoMs) + ' ms · decode ' + Math.round(sample.timings.decodeMs) +
        ' ms · detect ' + Math.round(sample.timings.detectMs) + ' ms';
      if (this._calibrationPending) {
        this._calibrationPending = false;
        if (sample.found) {
          const k = this._distance.calibrate(sample.sideNorm, sample.markerMm, this._settings.calibrationCm);
          if (k !== null) {
            this._settings.kNorm = k;
            saveSettings(storageOrNull(), this._settings);
            this._toast('Calibrated: K = ' + k.toFixed(3));
          }
        } else {
          this._toast('No marker found; place it ' + this._settings.calibrationCm + ' cm away and try again');
        }
      } else {
        this._distance.update(sample, now);
        if (reason === 'tap') {
          this._toast(sample.found ? 'Measured ' + formatCm(this._distance.snapshot().cm) : 'No marker found');
        }
      }
      this._render(now);
    }).catch((error) => {
      const now = Date.now();
      this._capturing = false;
      this._calibrationPending = false;
      this._captureFailures += 1;
      const code = captureErrorCode(error);
      this._cameraError = String((error && error.message) || error);
      if (code === 'denied') {
        this._cameraState = 'denied';
        this._stopCaptureLoop();
        this._toast('Camera permission denied; distance measuring stopped');
      } else if (code === 'needs-tap') {
        this._cameraState = 'manual';
        this._stopCaptureLoop();
        this._toast('Automatic photos were rejected: tap the distance tile to measure');
      } else if (this._captureFailures >= MAX_CAPTURE_FAILURES) {
        this._cameraState = 'stopped';
        this._stopCaptureLoop();
        this._toast(MAX_CAPTURE_FAILURES + ' failures in a row; automatic measuring stopped');
      } else {
        this._toast('Measurement failed: ' + this._cameraError);
      }
      this._render(now);
    });
  },

  // ---- session / demo ----------------------------------------------------

  _beginSession() {
    const now = Date.now();
    this._session.start(now);
    this._phase = 'calibrating';
    this._baselineDueAt = now + BASELINE_COUNTDOWN_MS;
  },

  _enterDemo(message) {
    const now = Date.now();
    this._stopCaptureLoop();
    this._releaseSensors();
    this._demo = { active: true, startedAt: now, lastDistanceAt: 0, label: demoLabel(0) };
    this._posture.reset();
    this._distance.reset();
    if (!this._session.isStarted()) this._session.start(now);
    this._phase = 'monitoring';
    this._toast(message);
    this._render(now);
  },

  _exitDemo() {
    const now = Date.now();
    this._demo = { active: false, startedAt: 0, lastDistanceAt: 0, label: '' };
    this._posture.reset();
    this._distance.reset();
    if (this._settings.kNorm !== null) this._distance.setKNorm(this._settings.kNorm, true);
    const sensorOk = this._query.mode === 'distance' ? false : this._startSensors();
    if (this._cameraState === 'unknown' || this._cameraState === 'unavailable') this._probeCamera();
    if (sensorOk) {
      this._phase = 'calibrating';
      this._baselineDueAt = now + BASELINE_COUNTDOWN_MS;
    } else {
      this._phase = this._cameraState === 'ready' ? 'monitoring' : 'ready';
    }
    this._startCaptureLoop();
    this._toast(sensorOk ? 'Left demo; posture baseline in 3 s' : 'Left demo: ' + (this._sensorError || 'no sensor'));
    this._render(now);
  },

  _startTick() {
    if (this._tickTimer !== null) return;
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
  },

  _stopTick() {
    if (this._tickTimer === null) return;
    clearInterval(this._tickTimer);
    this._tickTimer = null;
  },

  _tick() {
    const now = Date.now();
    const stats = this._tickStats;
    if (stats.lastAt > 0) {
      const period = now - stats.lastAt;
      stats.periodMs = stats.periodMs === 0 ? period : stats.periodMs + (period - stats.periodMs) * 0.2;
    }
    stats.lastAt = now;
    stats.count += 1;

    if (this._demo.active) {
      const sample = demoSample(now - this._demo.startedAt);
      this._demo.label = demoLabel(sample.segmentIndex);
      this._posture.updateAngles(sample.pitchDeg, sample.rollDeg, now);
      if (now - this._demo.lastDistanceAt >= DEMO_DISTANCE_INTERVAL_MS) {
        this._demo.lastDistanceAt = now;
        const k = this._distance.snapshot().kNorm;
        const mm = DISTANCE_DEFAULTS.defaultMarkerMm;
        this._distance.update({
          found: sample.markerFound,
          sideNorm: (k * mm) / (sample.distanceCm * 10),
          markerMm: mm
        }, now);
      }
    } else {
      if (this._phase === 'calibrating' && this._baselineDueAt !== null && now >= this._baselineDueAt) {
        if (this._lastQuaternion && this._posture.setBaseline(this._lastQuaternion, now)) {
          this._phase = 'monitoring';
          this._baselineDueAt = null;
          this._startCaptureLoop();
          if (this._cameraState === 'ready') this._captureOnce('baseline');
        } else if (this._lastQuaternion === null && now - this._sensorStartedAt >= SENSOR_TIMEOUT_MS) {
          // The runtime exposed a sensor object but never delivered a reading
          // (the browser simulator does this): treat it as unavailable.
          this._releaseSensors();
          this._sensorError = 'No sensor data within ' + Math.round(SENSOR_TIMEOUT_MS / 1000) + ' s';
          this._phase = this._cameraState === 'ready' ? 'monitoring' : 'ready';
          this._baselineDueAt = null;
          if (this._query.demo !== false) {
            this._enterDemo('Sensor gave no data; entering demo mode');
            return;
          }
          this._toast(this._sensorError + '; tap the posture tile to retry');
        }
      }
      if (this._phase === 'monitoring' && this._lastQuaternion && this._posture.hasBaseline()) {
        this._posture.updateQuaternion(this._lastQuaternion, now, DEFAULT_AXIS_MAP);
      } else {
        this._posture.tick(now);
      }
    }
    this._session.tick(now);
    this._render(now);
  },

  // ---- input actions -----------------------------------------------------

  _primaryAction() {
    if (this._alertKey) {
      this._dismissAlert();
      return;
    }
    const now = Date.now();
    if (this._focus === FOCUS_POSTURE) {
      if (this._demo.active) {
        this._toast('Demo mode: posture is scripted');
      } else if (!this._sensor) {
        if (this._startSensors()) {
          if (!this._session.isStarted()) this._beginSession();
          else {
            this._phase = 'calibrating';
            this._baselineDueAt = now + BASELINE_COUNTDOWN_MS;
          }
          this._toast('Sensor connected; posture baseline in 3 s');
        } else {
          this._toast(this._sensorError || 'Pose sensor unavailable');
        }
      } else {
        this._phase = 'calibrating';
        this._baselineDueAt = now + BASELINE_COUNTDOWN_MS;
        this._toast('Sit up straight, look at the screen; baseline in 3 s');
      }
    } else if (this._focus === FOCUS_DISTANCE) {
      if (this._demo.active) {
        this._toast('Demo mode: distance is scripted');
      } else if (this._cameraState === 'ready' || this._cameraState === 'manual') {
        if (!this._session.isStarted()) this._session.start(now);
        if (this._phase === 'ready') this._phase = 'monitoring';
        this._captureOnce('tap');
        this._startCaptureLoop();
      } else if (this._cameraState === 'stopped') {
        this._cameraState = 'ready';
        this._captureFailures = 0;
        this._captureOnce('tap');
        this._startCaptureLoop();
      } else {
        this._toast(this._cameraError || 'Camera unavailable');
      }
    } else if (this._focus === FOCUS_CALIBRATE) {
      if (this._demo.active) {
        this._distance.calibrate(0.05, DISTANCE_DEFAULTS.defaultMarkerMm, this._settings.calibrationCm);
        this._toast('Demo mode: calibration simulated');
      } else if (this._cameraState === 'ready' || this._cameraState === 'manual' || this._cameraState === 'stopped') {
        this._cameraState = this._cameraState === 'stopped' ? 'ready' : this._cameraState;
        this._calibrationPending = true;
        this._toast('Calibrating: stay ' + this._settings.calibrationCm + ' cm from the marker and look at it');
        this._captureOnce('calibrate');
      } else {
        this._toast(this._cameraError || 'Camera unavailable; cannot calibrate');
      }
    } else if (this._focus === FOCUS_VOICE) {
      this._settings.voice = !this._settings.voice;
      saveSettings(storageOrNull(), this._settings);
      this._toast(this._settings.voice ? 'Voice reminders on' : 'Voice reminders off');
      if (this._settings.voice) this._speak('Voice reminders are on', true);
    } else if (this._focus === FOCUS_DEMO) {
      if (this._demo.active) this._exitDemo();
      else this._enterDemo('Entering demo mode');
      return;
    }
    this._render(now);
  },

  _moveFocus(delta) {
    this._focus = (this._focus + delta + FOCUS_COUNT) % FOCUS_COUNT;
    this._render(Date.now());
  },

  _dismissAlert() {
    const now = Date.now();
    this._posture.dismissAlert(now);
    this._distance.dismissAlert(now);
    this._session.dismissReminder(now);
    this._alertKey = '';
    this._toast('Alert dismissed');
    this._render(now);
  },

  _toast(text) {
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._push({ toast: text });
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      this._push({ toast: '' });
    }, TOAST_MS);
  },

  _speak(text, force) {
    if (!this._settings.voice) return;
    const now = Date.now();
    if (!force && now - this._lastSpokenAt < SPEECH_GAP_MS) return;
    try {
      if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance === 'function') {
        speechSynthesis.speak(new SpeechSynthesisUtterance(text), 'immediate');
        this._lastSpokenAt = now;
      }
    } catch (_) {}
  },

  // ---- view model --------------------------------------------------------

  // Sends only the keys whose value changed since the last push.
  _push(patch) {
    const changed = {};
    let any = false;
    Object.keys(patch).forEach((key) => {
      if (this._view[key] !== patch[key]) {
        this._view[key] = patch[key];
        changed[key] = patch[key];
        any = true;
      }
    });
    if (any) this.setData(changed);
  },

  _currentAlert() {
    const p = this._posture.snapshot();
    if (p.alert.active) {
      const content = POSTURE_ALERTS[p.alert.kind] || POSTURE_ALERTS['pitch-down'];
      return Object.assign({ key: 'posture:' + p.alert.kind + ':' + p.alert.since }, content);
    }
    const d = this._distance.snapshot();
    if (d.alert.active) return Object.assign({ key: 'distance:' + d.alert.since }, DISTANCE_ALERT);
    const s = this._session.snapshot(Date.now());
    if (s.reminder.active) return Object.assign({ key: 'sedentary:' + s.reminder.since }, SEDENTARY_ALERT);
    return null;
  },

  _render(now) {
    const p = this._posture.snapshot();
    const d = this._distance.snapshot();
    const s = this._session.snapshot(now);
    const demo = this._demo.active;
    const focus = this._focus;

    // Posture tile
    let postureTone = 'off';
    let postureLabel = 'Not ready';
    let postureDetail = this._sensorError || 'Connecting the pose sensor';
    if (demo || (this._phase === 'monitoring' && p.hasBaseline)) {
      postureTone = p.level === 'off' ? 'off' : p.level;
      postureLabel = p.level === 'ok' ? 'Good' : p.level === 'warn' ? 'Watch' : p.level === 'bad' ? 'Poor' : 'Waiting';
      const pitchWord = p.pitch >= 0 ? 'Down' : 'Up';
      const rollWord = p.roll >= 0 ? 'Tilt R' : 'Tilt L';
      postureDetail = pitchWord + ' ' + formatDeg(p.pitch) + ' · ' + rollWord + ' ' + formatDeg(p.roll);
    } else if (this._phase === 'calibrating') {
      const left = Math.max(0, Math.ceil(((this._baselineDueAt || now) - now) / 1000));
      postureLabel = 'Baseline ' + left;
      postureDetail = this._lastQuaternion ? 'Sit up straight, look at the screen' : (this._sensorError || 'Waiting for sensor data');
    } else if (this._query.mode === 'distance') {
      postureLabel = 'Off';
      postureDetail = 'Distance only this session';
    }

    // Distance tile
    let distanceTone = 'off';
    let distanceLabel = '-- cm';
    let distanceDetail = '';
    if (this._query.mode === 'posture') {
      distanceLabel = 'Off';
      distanceDetail = 'Posture only this session';
    } else if (demo || this._cameraState === 'ready' || this._cameraState === 'manual' || this._cameraState === 'stopped') {
      const calText = d.calibrated ? 'calibrated' : 'estimate';
      if (d.markerState === 'found' && d.cm !== null) {
        distanceLabel = formatCm(d.cm);
        distanceTone = d.level === 'too-close' ? 'bad' : d.level === 'close' ? 'warn' : 'ok';
        const levelText = d.level === 'too-close' ? 'Too close' : d.level === 'close' ? 'Close' : d.level === 'far' ? 'Far' : 'Good';
        distanceDetail = levelText + ' · ' + calText;
      } else if (d.markerState === 'missing') {
        distanceLabel = 'No marker';
        distanceDetail = d.lastCm !== null ? 'Last ' + formatCm(d.lastCm) : 'Show the marker on your monitor';
      } else if (this._capturing) {
        distanceLabel = 'Measuring';
        distanceDetail = 'Taking a photo and finding the marker';
      } else if (this._cameraState === 'manual') {
        distanceLabel = 'Tap to measure';
        distanceDetail = 'Automatic photos are not allowed here';
      } else if (this._cameraState === 'stopped') {
        distanceLabel = 'Stopped';
        distanceDetail = 'Tap the distance tile to retry';
      } else if (this._phase === 'ready') {
        distanceLabel = 'Tap to start';
        distanceDetail = 'Tap the distance tile to begin';
      } else {
        distanceLabel = 'Waiting';
        distanceDetail = 'One photo every 20 s';
      }
    } else if (this._cameraState === 'denied') {
      distanceLabel = 'No access';
      distanceDetail = 'Camera permission denied';
    } else {
      distanceLabel = 'Unavailable';
      distanceDetail = this._cameraError || 'Camera unavailable';
    }

    // Phase chip and clock
    let phaseChip = 'READY';
    if (demo) phaseChip = 'DEMO';
    else if (this._phase === 'calibrating') phaseChip = 'BASELINE';
    else if (this._phase === 'monitoring') phaseChip = 'MONITORING';
    const clock = formatClock(s.elapsedMs);

    // Alert
    const alert = this._currentAlert();
    if (alert && alert.key !== this._alertKey) {
      this._alertKey = alert.key;
      this._speak(alert.speech, false);
    } else if (!alert) {
      this._alertKey = '';
    }

    // Detail lines by focus
    let detail1 = '';
    let detail2 = '';
    if (focus === FOCUS_POSTURE) {
      const c = this._posture.config;
      detail1 = 'Alert when head down/up ≥ ' + c.pitchBadDeg + '° or tilt ≥ ' + c.rollBadDeg + '° for ' + Math.round(c.dwellMs / 1000) + ' s';
      detail2 = 'Good posture ' + goodPercent(p.stats) + '% · alerts ' + p.stats.alerts +
        (demo ? ' · ' + this._demo.label : ' · samples ' + this._readingCount);
    } else if (focus === FOCUS_DISTANCE) {
      const c = this._distance.config;
      detail1 = 'Alert under ' + c.tooCloseCm + ' cm for ' + Math.round(c.dwellMs / 1000) + ' s · one photo every ' + Math.round(CAPTURE_INTERVAL_MS / 1000) + ' s';
      detail2 = demo
        ? 'Alerts ' + d.stats.alerts + ' · ' + this._demo.label
        : 'Last measured ' + ageText(now, this._lastCaptureAt) + (this._lastCaptureInfo ? ' · ' + this._lastCaptureInfo : '');
    } else if (focus === FOCUS_CALIBRATE) {
      detail1 = 'Place the marker ' + this._settings.calibrationCm + ' cm from your eyes, look at it, then tap';
      detail2 = 'K = ' + d.kNorm.toFixed(3) + (d.calibrated ? ' (calibrated)' : ' (estimated from the camera field of view)');
    } else if (focus === FOCUS_VOICE) {
      detail1 = 'Speaks a short prompt when an alert appears';
      detail2 = 'Now: ' + (this._settings.voice ? 'on' : 'off') + ' · at least 20 s between prompts';
    } else {
      detail1 = 'Scripted data for runtimes without a sensor or camera';
      detail2 = 'Now: ' + (demo ? 'on · ' + this._demo.label : 'off') + ' · tick ' + Math.round(this._tickStats.periodMs) + ' ms';
    }

    // Hint
    let hint = '';
    if (alert) hint = 'Tap or nod: dismiss · Double tap: exit';
    else if (focus === FOCUS_POSTURE) hint = (this._sensor || demo ? 'Tap: reset posture baseline' : 'Tap: reconnect sensor') + ' · Swipe: switch · Double tap: exit';
    else if (focus === FOCUS_DISTANCE) hint = 'Tap: measure now · Swipe: switch · Double tap: exit';
    else if (focus === FOCUS_CALIBRATE) hint = 'Tap: calibrate · Swipe: switch · Double tap: exit';
    else if (focus === FOCUS_VOICE) hint = 'Tap: toggle voice reminders · Swipe: switch · Double tap: exit';
    else hint = 'Tap: toggle demo mode · Swipe: switch · Double tap: exit';

    this._push({
      phaseChip,
      clock,
      postureClass: joinClass(['tile', 'tile-posture', 'tone-' + postureTone, focus === FOCUS_POSTURE && 'is-focus']),
      postureMark: MARK[postureTone] || MARK.off,
      postureLabel,
      postureDetail,
      distanceClass: joinClass(['tile', 'tile-distance', 'tone-' + distanceTone, focus === FOCUS_DISTANCE && 'is-focus']),
      distanceMark: MARK[distanceTone] || MARK.off,
      distanceLabel,
      distanceDetail,
      detail1,
      detail2,
      calibrateClass: joinClass(['row', focus === FOCUS_CALIBRATE && 'is-focus']),
      calibrateText: 'Calibrate distance at ' + this._settings.calibrationCm + ' cm',
      calibrateState: d.calibrated ? 'Calibrated' : 'Not calibrated',
      voiceClass: joinClass(['row', focus === FOCUS_VOICE && 'is-focus']),
      voiceState: this._settings.voice ? 'On' : 'Off',
      demoClass: joinClass(['row', focus === FOCUS_DEMO && 'is-focus']),
      demoState: demo ? 'On' : 'Off',
      alertClass: joinClass(['alert', alert ? 'alert-on' : 'alert-off']),
      alertTitle: alert ? alert.title : '',
      alertBody: alert ? alert.body : '',
      hint
    });
  }
};
</script>

<page class="page">
  <view class="shell">
    <view class="topline">
      <text class="eyebrow">WORKHEALTHIER</text>
      <view class="topline-right">
        <text class="chip">{{phaseChip}}</text>
        <text class="clock">{{clock}}</text>
      </view>
    </view>

    <view class="tiles">
      <view class="{{postureClass}}">
        <view class="tile-head">
          <text class="tile-name">POSTURE</text>
          <text class="tile-mark">{{postureMark}}</text>
        </view>
        <text class="tile-value">{{postureLabel}}</text>
        <text class="tile-detail">{{postureDetail}}</text>
      </view>
      <view class="{{distanceClass}}">
        <view class="tile-head">
          <text class="tile-name">SCREEN DISTANCE</text>
          <text class="tile-mark">{{distanceMark}}</text>
        </view>
        <text class="tile-value">{{distanceLabel}}</text>
        <text class="tile-detail">{{distanceDetail}}</text>
      </view>
    </view>

    <view class="detail">
      <text class="detail-line">{{detail1}}</text>
      <text class="detail-line">{{detail2}}</text>
    </view>

    <view class="rows">
      <view class="{{calibrateClass}}">
        <text class="row-text">{{calibrateText}}</text>
        <text class="row-state">{{calibrateState}}</text>
      </view>
      <view class="{{voiceClass}}">
        <text class="row-text">Voice reminders</text>
        <text class="row-state">{{voiceState}}</text>
      </view>
      <view class="{{demoClass}}">
        <text class="row-text">Demo mode</text>
        <text class="row-state">{{demoState}}</text>
      </view>
    </view>

    <view class="footer">
      <text class="hint">{{hint}}</text>
      <text class="toast">{{toast}}</text>
    </view>

    <view class="{{alertClass}}">
      <view class="alert-head">
        <text class="alert-mark">{{alertMark}}</text>
        <text class="alert-title">{{alertTitle}}</text>
      </view>
      <text class="alert-body">{{alertBody}}</text>
      <text class="alert-hint">Tap the temple or nod to dismiss</text>
    </view>
  </view>
</page>

<style>
.page {
  width: 100%;
  height: 100%;
  color: rgba(64, 255, 94, 0.72);
  background-color: #000000;
}

.shell {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 12px 16px;
  box-sizing: border-box;
}

.topline {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  height: 18px;
}

.topline-right {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.eyebrow {
  font-size: 12px;
  line-height: 16px;
  letter-spacing: 0.08em;
  color: rgba(64, 255, 94, 0.48);
}

.chip {
  padding: 1px 6px;
  border: 1px solid rgba(64, 255, 94, 0.32);
  border-radius: 4px;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.04em;
  color: rgba(64, 255, 94, 0.72);
}

.clock {
  margin-left: 8px;
  font-size: 12px;
  line-height: 16px;
  font-family: monospace;
  color: rgba(64, 255, 94, 0.72);
}

.tiles {
  display: flex;
  flex-direction: row;
  flex-shrink: 0;
  margin-top: 8px;
}

.tile {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid rgba(64, 255, 94, 0.32);
  border-radius: 6px;
  box-sizing: border-box;
}

.tile-distance {
  margin-left: 8px;
}

.tile.is-focus {
  border-color: #40ff5e;
  box-shadow: inset 0 0 0 1px #40ff5e;
  background-color: rgba(64, 255, 94, 0.08);
}

.tile.tone-bad {
  border-style: dashed;
  border-color: rgba(64, 255, 94, 0.72);
}

.tile.tone-off {
  border-style: dotted;
}

.tile-head {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.tile-name {
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.06em;
  color: rgba(64, 255, 94, 0.48);
}

.tile-mark {
  font-size: 14px;
  line-height: 16px;
  color: #40ff5e;
}

.tile-value {
  margin-top: 2px;
  font-size: 26px;
  line-height: 32px;
  font-weight: 500;
  color: #40ff5e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile-detail {
  margin-top: 2px;
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  margin-top: 8px;
  padding: 0 2px;
}

.detail-line {
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.48);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rows {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  margin-top: 6px;
}

.row {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid rgba(0, 0, 0, 0);
  border-radius: 4px;
}

.row.is-focus {
  border-color: #40ff5e;
  box-shadow: inset 0 0 0 1px #40ff5e;
  background-color: rgba(64, 255, 94, 0.12);
}

.row-text {
  font-size: 13px;
  line-height: 17px;
  color: rgba(64, 255, 94, 0.72);
}

.row-state {
  font-size: 13px;
  line-height: 17px;
  color: #40ff5e;
}

.footer {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  justify-content: flex-end;
  min-height: 0;
  margin-top: 4px;
}

.hint,
.toast {
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hint {
  color: rgba(64, 255, 94, 0.48);
}

.toast {
  margin-top: 2px;
  color: #40ff5e;
}

.alert {
  position: absolute;
  left: 16px;
  right: 16px;
  top: 118px;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border: 2px dashed #40ff5e;
  border-radius: 6px;
  box-sizing: border-box;
  background-color: #000000;
}

.alert-off {
  display: none;
}

.alert-head {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.alert-mark {
  margin-right: 8px;
  font-size: 18px;
  line-height: 22px;
  color: #40ff5e;
}

.alert-title {
  font-size: 18px;
  line-height: 22px;
  font-weight: 500;
  color: #40ff5e;
}

.alert-body {
  margin-top: 4px;
  font-size: 14px;
  line-height: 18px;
  color: rgba(64, 255, 94, 0.72);
}

.alert-hint {
  margin-top: 6px;
  font-size: 11px;
  line-height: 14px;
  color: rgba(64, 255, 94, 0.48);
}

@media (max-height: 240px) {
  .shell {
    padding: 6px 10px;
  }
  .tiles {
    margin-top: 4px;
  }
  .tile {
    padding: 4px 8px;
  }
  .tile-value {
    font-size: 22px;
    line-height: 26px;
  }
  .detail {
    display: none;
  }
  .rows {
    display: none;
  }
  .footer {
    display: none;
  }
  .alert {
    left: 10px;
    right: 10px;
    top: 26px;
    padding: 6px 10px;
  }
  .alert-hint {
    display: none;
  }
}
</style>
