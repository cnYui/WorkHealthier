# WorkHealthier

A desk-health agent for Rokid Glasses (AIUI 0.17.0, monochrome green, 480 × 352). It uses the glasses' pose sensor to tell whether you are looking down or tilting your head, uses the glasses' camera plus a QR marker on your monitor to estimate eye-to-screen distance, and shows (optionally speaks) a reminder when posture slips, the screen is too close, or you have been sitting for 45 minutes.

## First, the honest part: there is no infrared or laser rangefinder

AIUI 0.17's device APIs are Bluetooth, Accelerometer, AbsoluteOrientationSensor, Gyroscope and BatteryManager, and the Rokid Glasses hardware has one 12 MP camera plus an IMU: no ToF, infrared or laser ranging module. So:

| Need | What this project does | Based on |
| --- | --- | --- |
| Posture / head down / head tilt | The Page-scoped `AbsoluteOrientationSensor` from `enableWorldAwareness()` (Android `TYPE_ROTATION_VECTOR`, which fuses the gyroscope, accelerometer and magnetometer). The pose is measured relative to a "sit straight, look at the screen" baseline, giving a down/up angle and a tilt angle | Official Page API docs, `samples/gyroscope-test` |
| Eye-to-screen distance | The camera takes one low-resolution photo every 20 s, `BarcodeDetector` finds the QR marker on the monitor (payload `WH:50` means a nominal 50 mm side), and the marker's apparent size gives the distance; one tap calibrates at a known distance | Official `samples/scanner` (same photo → WebP decode → barcode pipeline) |
| Sitting too long | Reminder after 45 minutes of continuous monitoring | — |

The "gyroscope" feature the request asked for is that orientation sensor: the device fuses the gyroscope internally and returns a pose quaternion, which is far more stable than integrating raw angular velocity by hand.

## Import into AIUI Studio

The AIUI project root is the repository's `agent/` subdirectory (it contains `app.json` directly), not the repository root:

```text
Repository: https://github.com/cnYui/WorkHealthier
Ref: main
AIUI project directory: agent
```

In Studio (https://aiui.rokid.com) open the **New Agent** menu at the top left, choose **GitHub Import**, enter `https://github.com/cnYui/WorkHealthier/tree/main/agent`, and confirm. Importing the same URL again updates the project in place.

After the import, send `/debug` in the chat and ask it to run `pages/monitor/index`; when the card appears click **Enter** and the canvas moves into the 480 × 352 Effect Preview window. The Device Simulation panel on the right has the four temple buttons.

**The web simulator has neither a sensor nor a camera** (measured earlier: `navigator.mediaDevices` is missing and the pose sensor never delivers data), so the Page switches to **demo mode** by itself after a few seconds and plays a 150-second script: good → head-down alert → recovered → too-close alert → recovered → head-tilt alert → marker out of view → all good. On the glasses it uses the real sensor and camera.

## Temple controls

| Action | Keys the simulator sends | Effect |
| --- | --- | --- |
| Tap | `GlobalHook` → `Enter` | While an alert is showing: dismiss it; otherwise the focused item's action (table below) |
| Swipe forward / back | `GlobalHook` → `ArrowUp` / `ArrowDown` | Cycle through the five focus targets |
| Double tap | Never reaches the Page in the simulator | Host default: exit the agent |
| Nod | World-awareness `nod` gesture (glasses only) | Dismiss the alert |

Focus targets and their tap action:

| Focus | Tap |
| --- | --- |
| Posture tile | Re-capture the posture baseline 3 s later (sit straight, look at the screen); if the sensor is not connected, retry the connection |
| Screen distance tile | Take a photo and measure once; the first tap also starts automatic measuring (the camera needs a user interaction to begin) |
| Calibrate distance at 60 cm | Take a photo and map the marker's current size to 60 cm; stored locally |
| Voice reminders | On / off |
| Demo mode | On / off |

The Page calls `preventDefault()` for `Enter`, `ArrowUp` and `ArrowDown` (it fully owns focus movement and activation); `Backspace` keeps the host default.

## Alert rules

| Alert | Condition | Cleared |
| --- | --- | --- |
| Head down / up | ≥ 18° from the baseline for 8 s (10°–18° shows "Watch") | Automatically 2 s after posture recovers; after a tap/nod dismiss, no new alert for 60 s |
| Head tilted | ≥ 12° for 8 s (7°–12° "Watch") | Same as above |
| Too close to the screen | < 45 cm for 15 s and at least 2 samples (45–52 cm "Close", > 85 cm "Far") | Automatically above 52 cm; 60 s cooldown after a dismiss |
| Sitting too long | 45 minutes of continuous monitoring | Dismiss restarts the timer |

All thresholds are constants at the top of `agent/lib/posture.js`, `agent/lib/distance.js` and `agent/lib/session.js`.

## The screen marker

1. Open `docs/marker.html` on the monitor (or open `docs/marker/marker-50mm.svg` directly, or print it and stick it on the monitor bezel).
2. Match the page's 10 cm ruler against a real ruler; the marker then has the right physical size.
3. On the glasses move the focus to **Calibrate distance at 60 cm**, sit 60 cm from the marker, look at it and tap. Calibration cancels any error in the marker size, so as long as the marker size stays the same you never need to calibrate again.

Before calibration the app uses a constant derived from the Rokid Glasses camera field of view (about 96° horizontal), `K = 0.446`, which may be off by ±20%; the tile then says "estimate".

## Axis convention (to be verified on the glasses)

`DEFAULT_AXIS_MAP` in `agent/lib/quat.js` assumes the device X axis is the left–right axis (rotation about it is nodding / looking down), Y is vertical (turning) and Z is front–back (tilting), matching the mapping in the official `samples/gyroscope-test`; `pitchDownSign = -1` decides which direction counts as "down". A wrong sign only swaps the Down/Up labels, it never affects whether a deviation is detected. On the glasses put the focus on the posture tile, look down, and check that the angle text says "Down"; flip the sign if not.

## Layout

Ink reference canvas 480 × 352 (safe insets 16 px horizontal, 12 px vertical): status line → two indicator tiles (posture / screen distance, 26 px values) → two detail lines → three setting rows → control hint. The chat-flow card is 448 × 150, where `@media (max-height: 240px)` keeps only the status line and the two tiles. Alerts are a 2 px dashed frame over the tile area, and every state is expressed with a label and a mark (√ △ ▲ ○), never with luminance alone.

## Layout of the repository

```text
agent/                     AIUI Studio import root
  AGENTS.md                Agent identity, voice routing rules, capability limits
  app.json                 Page list, CAMERA permission
  pages/monitor/index.ink  The only Page: sensor, camera, temple input, alerts, demo mode, both layouts
  lib/quat.js              Quaternion math and the axis convention
  lib/posture.js           Posture state machine (thresholds, dwell, cooldown, statistics)
  lib/distance.js          Marker ranging, calibration, too-close detection
  lib/session.js           Session clock, sedentary reminder
  lib/capture.js           One photo → decode → detect measurement
  lib/temple.js            Temple input de-duplication (GlobalHook / gesture keys)
  lib/demo.js              Demo script
  lib/env.js               Runtime parsing, local settings
  lib/webp.js + vendor/    Pure-JS WebP decoder from the official scanner sample (see THIRD_PARTY_NOTICES.md)
docs/marker.html           Marker page; docs/marker/*.svg|png are the 30/50/80 mm markers
docs/aiui-audit.md         UX / capability audit matrices (every row BLOCKED until signed Studio and device evidence exists)
docs/deck/                 Slide deck with screenshots
tests/                     Node unit tests (not imported into Studio)
```

## Development

```bash
npm test
python C:/Users/yui/.claude/skills/rokid-aiui-agent/scripts/validate_aiui_project.py agent --repository-root . --target-version 0.17.0 --strict
npx --yes --package @yodaos-pkg/aix-cli@0.8.2 aix pack agent -o artifacts/workhealthier.aix
npx --yes --package @yodaos-pkg/aix-cli@0.8.2 aix preview agent --html-out artifacts/preview.html
```

Requires Node 20+. `tests/` covers all pure logic in `agent/lib/`, including a replay of the whole demo script through both state machines to confirm every alert appears and clears.

## Status

- Local: unit tests, strict structural validation, and AIX pack / list / preview all pass.
- AIX browser preview: layout, focus movement, tap actions and the automatic demo fallback were checked visually.
- Studio simulator (2026-09-12): the GitHub import and the `/debug` chat card work; the card renders the 448 × 150 compact layout in the `MONITORING` state (`docs/deck/shots/05-studio-card.png`). The simulator delivers one constant pose, so posture reads Good at 0°, and it rejects the camera photo, so distance ends on "Stopped" with a tap-to-retry hint. It can verify layout, focus, demo mode and the temple key order, not real sensor or camera behaviour.
- Glasses: not verified yet. Still to confirm on hardware: `enableWorldAwareness()` exposing `reading` events on `this.orientationSensor`, the axis signs, whether `takePhoto()` is allowed from a timer outside a user interaction (if not, the Page switches to tap-to-measure by itself), WebP decode time, the nod gesture, and speech synthesis.
- Before submission, tick the camera permission in Studio's build-and-review form and state its purpose (local marker detection only; photos are neither stored nor uploaded).
