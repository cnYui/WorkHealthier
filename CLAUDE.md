# WorkHealthier — workspace notes for Claude

> This folder is the root of the `cnYui/WorkHealthier` repository; the AIUI Studio import root is its `agent/` subdirectory. **Everything in this project is English-only** (UI strings, docs, comments, deck) by the user's explicit request, even though the user writes in Chinese.

## Where things live

| Location | What it is |
|---|---|
| `agent/` | **AIUI Studio import root** (contains `app.json` directly), AIUI 0.17.0, one Page `pages/monitor/index` |
| `agent/lib/` | Pure logic with Node tests: `quat.js`, `posture.js`, `distance.js`, `session.js`, `capture.js`, `temple.js`, `demo.js`, `env.js`; `webp.js` + `vendor/webpjs/` are copied verbatim from the official `samples/scanner` |
| `tests/` | `npm test` (Node 20+, `node --test`); not imported into Studio |
| `docs/aiui-audit.md` | Generated UX/capability audit; regenerate after every change under `agent/` (see below) |
| `docs/marker.html`, `docs/marker/` | QR marker shown on the monitor for distance estimation (payload `WH:<mm>`) |
| `docs/deck/` | HTML slide deck with screenshots |
| `artifacts/` | Ignored by git: `aix pack` output and `aix preview --html-out` page |
| `C:\Users\yui\.claude\skills\rokid-aiui-agent` | Installed Skill with the validation scripts in `scripts/` |
| `D:\CodeWorkSpace\rokid-aiui-agent-skill` | The Skill's repository |

## Platform facts this project relies on (AIUI v0.17.0, commit 88e70bb0)

- Device APIs are only Bluetooth, Accelerometer, AbsoluteOrientationSensor, Gyroscope, BatteryManager. **There is no rangefinder/ToF/IR API**; distance comes from the camera + QR marker.
- Page world awareness: `this.enableWorldAwareness()` → page-private `this.orientationSensor` (`AbsoluteOrientationSensor`, quaternion `[x, y, z, w]`), `onHeadGesture` (`nod`/`shake`), runtime disables it before `onUnload`. Fallback: `new AbsoluteOrientationSensor({ frequency })` global.
- Camera on glasses: `wx.media.createCameraContext().takePhoto({ quality, enableSystemPreview })` → `{ data: ArrayBuffer, mimeType }` (WebP), decoded with the pure-JS decoder, then the global `BarcodeDetector.detect({ data: gray, width, height })` (the `barcode` module import also exists but the global is documented). `takePhoto` "must run during a valid user interaction while the host window is focused" — the Page tries a 20 s interval anyway and falls back to tap-to-measure when the host rejects it. Camera is unavailable when `app.json` has `"lifetime": "cut"`, so this app must not be a cut agent.
- Speech: `speechSynthesis.speak(new SpeechSynthesisUtterance(text), 'immediate' | 'enqueue')`.
- `app.json` `"permissions": ["CAMERA"]` (capabilities sample line 57); AGENTS.md also lists `camera`.

## Change → Studio debugging loop

1. Edit `agent/`, then `npm test` and
   `python C:/Users/yui/.claude/skills/rokid-aiui-agent/scripts/validate_aiui_project.py agent --repository-root . --target-version 0.17.0 --strict`
2. Regenerate the audit (all rows BLOCKED until signed Studio/device evidence exists):
   `python C:/Users/yui/.claude/skills/rokid-aiui-agent/scripts/inventory_aiui_capabilities.py agent --target-version 0.17.0 --repository-root . > <tmp>/inventory.json`, then `python docs/tools/gen_audit.py <tmp>/inventory.json docs/aiui-audit.md`, then
   `python C:/Users/yui/.claude/skills/rokid-aiui-agent/scripts/validate_aiui_audit.py docs/aiui-audit.md --repository-root . --import-root agent` → exit 2 (valid, blocked) is the expected result without a trust policy.
3. `git commit` + `git push origin main`
4. Studio (`https://aiui.rokid.com`): top-left **New Agent** menu → **GitHub Import** → `https://github.com/cnYui/WorkHealthier/tree/main/agent` → Confirm. Re-importing the same URL updates the project in place; a different URL creates a second project. The import field keeps the previous URL; set it as a form value rather than clearing it with the keyboard.
5. Chat: `/debug` + a request to run `pages/monitor/index` → inline card → **Enter** → Effect Preview (480 × 352). Right-hand Device Simulation panel: four temple buttons, microphone. Log panel shows `console.log`.
6. Keep the browser pane visible while Studio works: with the pane hidden the page stalls (`visibilityState = hidden`, no rAF frames), imports get stuck unpacking and the preview stops rendering.

## AIX browser preview (measured 2026-09-12)

- `aix preview agent --html-out artifacts/preview.html` renders the Page in a 480 × 352 canvas with ←/Enter/↑/↓ buttons; serve `artifacts/` with `python -m http.server` and open it.
- The web runtime exposes `enableWorldAwareness` and a camera context but delivers no sensor readings, so the Page's 6 s sensor timeout (`SENSOR_TIMEOUT_MS`) drops it into demo mode. Before `_render` diffed its `setData` payload, the 500 ms tick visibly lagged (values converged over tens of seconds); the diffing fix is in `_push()`. The demo row's detail line shows the measured tick period.

## Studio simulator facts (measured on the previous Rokid project, 2026-09-11)

- Temple tap → `GlobalHook` then `Enter`; swipe forward → `GlobalHook` then `ArrowUp`; swipe back → `GlobalHook` then `ArrowDown`; **double tap never reaches agent Pages**. `lib/temple.js` drops the echo and treats a lone `GlobalHook` as a tap after 280 ms.
- This project, 2026-09-12: the GitHub import (`tree/main/agent`) and the `/debug` chat card work. The card showed `MONITORING`, posture Good (Down 0°, Tilt R 0°) from one constant pose, and distance `Stopped` because the photo was rejected (`docs/deck/shots/05-studio-card.png`). So the simulator does expose the orientation sensor and a camera context, but neither produces real data.
- Globals present: `LanguageModel`, `SpeechRecognition`, `speechSynthesis`, `SpeechSynthesisUtterance`, `wx.speech`. Missing: `navigator.mediaDevices`, `MediaRecorder`. No IMU data. → the Page auto-enters demo mode when neither a sensor nor a camera is found, or when the sensor stays silent for 6 s (`query.demo === false` disables that).
- Runtime is QuickJS; `new Date(y, m, d)` is unreliable, use `Date.now()` only.
- A dynamic class on the `<page>` root is not applied → root has the static class `page`; dynamic classes live on `view`s.
- `ink:for` inside a toggled `ink:if` does not re-render → this Page has no `ink:for` and toggles the alert with a class (`alert-off { display: none }`).
- Media-query rules must be plain single-class selectors. The chat card is 448 × 150 and matches `(max-height: 240px)`; after "Enter" the effect preview stays `_current` at 480 × 352.
- A simulated tap's `Enter` can arrive > 1 s after the button press; wait ≥ 2 s between simulator actions.

## Design decisions

- One Page, five focus targets cycled with swipes (posture tile, distance tile, calibrate row, voice row, demo row); tap = context action; any active alert makes tap/nod a dismiss. `Enter`/`ArrowUp`/`ArrowDown` are `preventDefault`ed; `Backspace` keeps the host default.
- Posture is relative to a baseline captured 3 s after start (and re-captured on tap on the posture tile). Axis map and sign in `lib/quat.js` (`DEFAULT_AXIS_MAP`) are **unverified on hardware**; a wrong sign only swaps the Down/Up label.
- Distance formula `cm = K * markerMm / sideNorm / 10`; `K` defaults to 0.446 (≈96° HFOV) and is replaced by the 60 cm calibration (persisted in `localStorage` key `workhealthier.settings.v1`).
- Monochrome green tokens: `#40ff5e` values/focus, 72% body text, 48% secondary, 32%/24% lines, ≤12% fills; 1 px lines, focus = border + inset box-shadow (visually 2 px) so the layout does not shift; alert = 2 px dashed frame; state marks √ △ ▲ ○.

## Verified / not verified

- Verified locally: `npm test` (all pure logic incl. a full demo replay), strict project validation exit 0, `aix pack`/`list` (no `.git`/`.aiui-evidence` entries), `aix preview` layout/focus/tap/demo fallback in the browser.
- Verified in Studio (2026-09-12): import, `/debug` chat card in the compact layout (constant pose → Good 0°, photo rejected → Stopped).
- Not verified: the 480 × 352 effect preview interactions in Studio (swipes, taps, demo fallback are not recorded with screenshots) and everything on physical glasses (see README "Status"). Simulator results are not device results; the Skill's release gates need signed device evidence.
