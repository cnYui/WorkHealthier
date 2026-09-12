<script def>
{
  "navigationBarTitleText": "健康工位",
  "description": "打开坐姿与屏幕距离监测面板。用户说“开始坐姿监测”“提醒我别离屏幕太近”“打开健康工位”“我总是低头”时调用；说“演示一下”时传 demo=true；说“在 60 厘米处校准”时传 calibrateCm=60。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["both", "posture", "distance"],
          "default": "both",
          "description": "监测内容：both 同时监测坐姿和屏幕距离，posture 只看头部姿态，distance 只看屏幕距离。"
        },
        "demo": {
          "type": "boolean",
          "description": "为 true 时用脚本数据演示各种提醒状态，不使用传感器和相机。"
        },
        "calibrateCm": {
          "type": "integer",
          "minimum": 30,
          "maximum": 120,
          "description": "用户准备用来校准距离的已知距离（厘米），例如 60。"
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
  'pitch-down': { title: '低头太久了', body: '请抬头、收下巴，让视线与屏幕齐平', speech: '低头太久了，请抬头放松颈部' },
  'pitch-up': { title: '仰头太久了', body: '请放低视线，或把屏幕调低一些', speech: '仰头太久了，请放低视线' },
  roll: { title: '头部歪斜', body: '请把头摆正，肩膀放平', speech: '头歪了，请把头摆正' }
};
const DISTANCE_ALERT = { title: '离屏幕太近', body: '请向后靠，保持 50 厘米以上', speech: '离屏幕太近了，请向后靠一点' };
const SEDENTARY_ALERT = { title: '已久坐 45 分钟', body: '起身活动两分钟，看看远处', speech: '已经坐了四十五分钟，起来活动一下吧' };

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
  if (typeof at !== 'number') return '尚未测量';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  return sec < 60 ? sec + ' 秒前' : Math.round(sec / 60) + ' 分钟前';
}

function initialData() {
  return {
    phaseChip: '准备中',
    clock: '00:00',
    postureClass: 'tile tile-posture tone-off is-focus',
    postureMark: MARK.off,
    postureLabel: '准备中',
    postureDetail: '正在连接姿态传感器',
    distanceClass: 'tile tile-distance tone-off',
    distanceMark: MARK.off,
    distanceLabel: '-- cm',
    distanceDetail: '需要屏幕上的标记',
    detail1: '',
    detail2: '',
    calibrateClass: 'row',
    calibrateText: '在 60 cm 处校准距离',
    calibrateState: '未校准',
    voiceClass: 'row',
    voiceState: '开',
    demoClass: 'row',
    demoState: '关',
    alertClass: 'alert alert-off',
    alertMark: MARK.bad,
    alertTitle: '',
    alertBody: '',
    hint: '',
    toast: '',
    envText: '运行环境：未知'
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

    this._visible = false;
    this._tickTimer = null;
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
    this.setData(Object.assign(initialData(), {
      envText: describeRuntime(runtime),
      calibrateText: '在 ' + this._settings.calibrationCm + ' cm 处校准距离',
      calibrateState: this._settings.kNorm !== null ? '已校准' : '未校准',
      voiceState: this._settings.voice ? '开' : '关'
    }));

    if (this._query.demo === true) {
      this._enterDemo('按要求进入演示模式');
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
        if (!this._demo.active) this._enterDemo('当前环境没有传感器和相机，进入演示模式');
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
      if (!this._sensorError) this._sensorError = '当前环境未提供姿态传感器';
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
      this._sensorError = event && event.message ? String(event.message) : '传感器读取失败';
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
        this._cameraError = '当前环境未提供相机';
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
      this._cameraError = '当前环境未提供条码识别';
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
      this._lastCaptureInfo = sample.imageWidth + '×' + sample.imageHeight + ' · 拍照 ' +
        Math.round(sample.timings.photoMs) + ' ms · 解码 ' + Math.round(sample.timings.decodeMs) +
        ' ms · 识别 ' + Math.round(sample.timings.detectMs) + ' ms';
      if (this._calibrationPending) {
        this._calibrationPending = false;
        if (sample.found) {
          const k = this._distance.calibrate(sample.sideNorm, sample.markerMm, this._settings.calibrationCm);
          if (k !== null) {
            this._settings.kNorm = k;
            saveSettings(storageOrNull(), this._settings);
            this._toast('已校准：K = ' + k.toFixed(3));
          }
        } else {
          this._toast('未找到标记，请把标记放在 ' + this._settings.calibrationCm + ' cm 处再试');
        }
      } else {
        this._distance.update(sample, now);
        if (reason === 'tap') this._toast(sample.found ? '测得 ' + formatCm(this._distance.snapshot().cm) : '未找到标记');
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
        this._toast('相机权限被拒绝，距离测量已停止');
      } else if (code === 'needs-tap') {
        this._cameraState = 'manual';
        this._stopCaptureLoop();
        this._toast('自动拍照被拒绝：单击距离卡片手动测量');
      } else if (this._captureFailures >= MAX_CAPTURE_FAILURES) {
        this._cameraState = 'stopped';
        this._stopCaptureLoop();
        this._toast('连续 ' + MAX_CAPTURE_FAILURES + ' 次测量失败，已停止自动测量');
      } else {
        this._toast('测量失败：' + this._cameraError);
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
    this._toast(sensorOk ? '已退出演示，3 秒后记录基准姿态' : '已退出演示：' + (this._sensorError || '无传感器'));
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
          this._sensorError = '传感器 ' + Math.round(SENSOR_TIMEOUT_MS / 1000) + ' 秒内没有数据';
          this._phase = this._cameraState === 'ready' ? 'monitoring' : 'ready';
          this._baselineDueAt = null;
          if (this._query.demo !== false) {
            this._enterDemo('传感器没有数据，进入演示模式');
            return;
          }
          this._toast(this._sensorError + '，单击坐姿卡片重试');
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
        this._toast('演示模式：姿态由脚本生成');
      } else if (!this._sensor) {
        if (this._startSensors()) {
          if (!this._session.isStarted()) this._beginSession();
          else {
            this._phase = 'calibrating';
            this._baselineDueAt = now + BASELINE_COUNTDOWN_MS;
          }
          this._toast('传感器已连接，3 秒后记录基准姿态');
        } else {
          this._toast(this._sensorError || '姿态传感器不可用');
        }
      } else {
        this._phase = 'calibrating';
        this._baselineDueAt = now + BASELINE_COUNTDOWN_MS;
        this._toast('请坐直、正视屏幕，3 秒后记录基准姿态');
      }
    } else if (this._focus === FOCUS_DISTANCE) {
      if (this._demo.active) {
        this._toast('演示模式：距离由脚本生成');
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
        this._toast(this._cameraError || '相机不可用');
      }
    } else if (this._focus === FOCUS_CALIBRATE) {
      if (this._demo.active) {
        this._distance.calibrate(0.05, DISTANCE_DEFAULTS.defaultMarkerMm, this._settings.calibrationCm);
        this._toast('演示模式：模拟校准完成');
      } else if (this._cameraState === 'ready' || this._cameraState === 'manual' || this._cameraState === 'stopped') {
        this._cameraState = this._cameraState === 'stopped' ? 'ready' : this._cameraState;
        this._calibrationPending = true;
        this._toast('正在校准，请保持在 ' + this._settings.calibrationCm + ' cm 处正视标记');
        this._captureOnce('calibrate');
      } else {
        this._toast(this._cameraError || '相机不可用，无法校准');
      }
    } else if (this._focus === FOCUS_VOICE) {
      this._settings.voice = !this._settings.voice;
      saveSettings(storageOrNull(), this._settings);
      this._toast(this._settings.voice ? '语音提醒已开启' : '语音提醒已关闭');
      if (this._settings.voice) this._speak('语音提醒已开启', true);
    } else if (this._focus === FOCUS_DEMO) {
      if (this._demo.active) this._exitDemo();
      else this._enterDemo('进入演示模式');
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
    this._toast('已关闭提醒');
    this._render(now);
  },

  _toast(text) {
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this.setData({ toast: text });
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      this.setData({ toast: '' });
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
    let postureLabel = '未就绪';
    let postureDetail = this._sensorError || '正在连接姿态传感器';
    if (demo || (this._phase === 'monitoring' && p.hasBaseline)) {
      postureTone = p.level === 'off' ? 'off' : p.level;
      postureLabel = p.level === 'ok' ? '良好' : p.level === 'warn' ? '注意' : p.level === 'bad' ? '不佳' : '等待';
      const pitchWord = p.pitch >= 0 ? '低头' : '仰头';
      const rollWord = p.roll >= 0 ? '右歪' : '左歪';
      postureDetail = pitchWord + ' ' + formatDeg(p.pitch) + ' · ' + rollWord + ' ' + formatDeg(p.roll);
    } else if (this._phase === 'calibrating') {
      const left = Math.max(0, Math.ceil(((this._baselineDueAt || now) - now) / 1000));
      postureLabel = '校准 ' + left;
      postureDetail = this._lastQuaternion ? '请坐直、正视屏幕' : (this._sensorError || '等待传感器数据');
    } else if (this._query.mode === 'distance') {
      postureLabel = '未启用';
      postureDetail = '本次只监测屏幕距离';
    }

    // Distance tile
    let distanceTone = 'off';
    let distanceLabel = '-- cm';
    let distanceDetail = '';
    if (this._query.mode === 'posture') {
      distanceLabel = '未启用';
      distanceDetail = '本次只监测坐姿';
    } else if (demo || this._cameraState === 'ready' || this._cameraState === 'manual' || this._cameraState === 'stopped') {
      const calText = d.calibrated ? '已校准' : '估算';
      if (d.markerState === 'found' && d.cm !== null) {
        distanceLabel = formatCm(d.cm);
        distanceTone = d.level === 'too-close' ? 'bad' : d.level === 'close' ? 'warn' : 'ok';
        const levelText = d.level === 'too-close' ? '太近' : d.level === 'close' ? '偏近' : d.level === 'far' ? '偏远' : '适中';
        distanceDetail = levelText + ' · ' + calText;
      } else if (d.markerState === 'missing') {
        distanceLabel = '未见标记';
        distanceDetail = d.lastCm !== null ? '上次 ' + formatCm(d.lastCm) : '请让相机看到屏幕上的标记';
      } else if (this._capturing) {
        distanceLabel = '测量中';
        distanceDetail = '拍照并识别标记';
      } else if (this._cameraState === 'manual') {
        distanceLabel = '待测量';
        distanceDetail = '单击距离卡片测量';
      } else if (this._cameraState === 'stopped') {
        distanceLabel = '已停止';
        distanceDetail = '单击距离卡片重试';
      } else if (this._phase === 'ready') {
        distanceLabel = '待开始';
        distanceDetail = '单击距离卡片开始';
      } else {
        distanceLabel = '等待';
        distanceDetail = '每 20 秒测量一次';
      }
    } else if (this._cameraState === 'denied') {
      distanceLabel = '无权限';
      distanceDetail = '相机权限被拒绝';
    } else {
      distanceLabel = '不可用';
      distanceDetail = this._cameraError || '相机不可用';
    }

    // Phase chip and clock
    let phaseChip = '就绪';
    if (demo) phaseChip = '演示';
    else if (this._phase === 'calibrating') phaseChip = '校准中';
    else if (this._phase === 'monitoring') phaseChip = '监测中';
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
      detail1 = '低头/仰头 ≥ ' + c.pitchBadDeg + '° 或歪头 ≥ ' + c.rollBadDeg + '° 持续 ' + Math.round(c.dwellMs / 1000) + ' 秒提醒';
      detail2 = '良好占比 ' + goodPercent(p.stats) + '% · 提醒 ' + p.stats.alerts + ' 次' +
        (demo ? ' · ' + this._demo.label : ' · 采样 ' + this._readingCount);
    } else if (focus === FOCUS_DISTANCE) {
      const c = this._distance.config;
      detail1 = '小于 ' + c.tooCloseCm + ' cm 持续 ' + Math.round(c.dwellMs / 1000) + ' 秒提醒 · 每 ' + Math.round(CAPTURE_INTERVAL_MS / 1000) + ' 秒拍照一次';
      detail2 = demo
        ? '提醒 ' + d.stats.alerts + ' 次 · ' + this._demo.label
        : '上次测量 ' + ageText(now, this._lastCaptureAt) + (this._lastCaptureInfo ? ' · ' + this._lastCaptureInfo : '');
    } else if (focus === FOCUS_CALIBRATE) {
      detail1 = '把标记放在离眼睛 ' + this._settings.calibrationCm + ' cm 处，正视它后单击';
      detail2 = '当前 K = ' + d.kNorm.toFixed(3) + (d.calibrated ? '（已校准）' : '（按相机视场估算）');
    } else if (focus === FOCUS_VOICE) {
      detail1 = '提醒出现时朗读一句简短提示';
      detail2 = '当前：' + (this._settings.voice ? '开' : '关') + ' · 两次朗读至少间隔 20 秒';
    } else {
      detail1 = '没有传感器和相机时，用脚本数据演示各种提醒';
      detail2 = '当前：' + (demo ? '开 · ' + this._demo.label : '关');
    }

    // Hint
    let hint = '';
    if (alert) hint = '单击或点头：关闭提醒 · 双击：退出';
    else if (focus === FOCUS_POSTURE) hint = (this._sensor || demo ? '单击：重设基准姿态' : '单击：重新连接传感器') + ' · 前滑/后滑：切换 · 双击：退出';
    else if (focus === FOCUS_DISTANCE) hint = '单击：立即测量距离 · 前滑/后滑：切换 · 双击：退出';
    else if (focus === FOCUS_CALIBRATE) hint = '单击：开始校准 · 前滑/后滑：切换 · 双击：退出';
    else if (focus === FOCUS_VOICE) hint = '单击：切换语音提醒 · 前滑/后滑：切换 · 双击：退出';
    else hint = '单击：切换演示模式 · 前滑/后滑：切换 · 双击：退出';

    this.setData({
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
      calibrateText: '在 ' + this._settings.calibrationCm + ' cm 处校准距离',
      calibrateState: d.calibrated ? '已校准' : '未校准',
      voiceClass: joinClass(['row', focus === FOCUS_VOICE && 'is-focus']),
      voiceState: this._settings.voice ? '开' : '关',
      demoClass: joinClass(['row', focus === FOCUS_DEMO && 'is-focus']),
      demoState: demo ? '开' : '关',
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
      <text class="eyebrow">健康工位</text>
      <view class="topline-right">
        <text class="chip">{{phaseChip}}</text>
        <text class="clock">{{clock}}</text>
      </view>
    </view>

    <view class="tiles">
      <view class="{{postureClass}}">
        <view class="tile-head">
          <text class="tile-name">坐姿</text>
          <text class="tile-mark">{{postureMark}}</text>
        </view>
        <text class="tile-value">{{postureLabel}}</text>
        <text class="tile-detail">{{postureDetail}}</text>
      </view>
      <view class="{{distanceClass}}">
        <view class="tile-head">
          <text class="tile-name">屏幕距离</text>
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
        <text class="row-text">语音提醒</text>
        <text class="row-state">{{voiceState}}</text>
      </view>
      <view class="{{demoClass}}">
        <text class="row-text">演示模式</text>
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
      <text class="alert-hint">单击镜腿或点头关闭</text>
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
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.48);
}

.tile-mark {
  font-size: 14px;
  line-height: 16px;
  color: #40ff5e;
}

.tile-value {
  margin-top: 2px;
  font-size: 28px;
  line-height: 34px;
  font-weight: 500;
  color: #40ff5e;
}

.tile-detail {
  margin-top: 2px;
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.72);
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
