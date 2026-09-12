// Temple touchpad input arbitration.
//
// Measured in AIUI Studio's glasses simulator: a temple tap delivers
// `GlobalHook` followed by `Enter`; a forward swipe delivers `GlobalHook`
// then `ArrowUp`; a backward swipe `GlobalHook` then `ArrowDown`. Acting on
// `GlobalHook` directly would double every action, but physical glasses may
// deliver only `GlobalHook` for a tap, so:
//   - a gesture key cancels any pending GlobalHook action;
//   - a GlobalHook that follows a gesture key within `echoMs` is an echo;
//   - a lone GlobalHook becomes one tap after `holdMs`.

export const GLOBAL_HOOK_HOLD_MS = 280;
export const GESTURE_ECHO_MS = 450;

export function createTempleInput(options) {
  const now = options.now;
  const schedule = options.schedule;
  const cancel = options.cancel;
  const onLoneGlobalHook = options.onLoneGlobalHook;
  const holdMs = options.holdMs === undefined ? GLOBAL_HOOK_HOLD_MS : options.holdMs;
  const echoMs = options.echoMs === undefined ? GESTURE_ECHO_MS : options.echoMs;
  let pending = null;
  let lastGestureAt = -Infinity;

  function clearPending() {
    if (pending === null) return;
    cancel(pending);
    pending = null;
  }

  return {
    gestureKeyDown() {
      clearPending();
    },
    gestureKeyUp() {
      clearPending();
      lastGestureAt = now();
    },
    // Returns true when a deferred tap was scheduled.
    globalHookUp() {
      if (now() - lastGestureAt < echoMs) return false;
      clearPending();
      pending = schedule(() => {
        pending = null;
        onLoneGlobalHook();
      }, holdMs);
      return true;
    },
    isPending() {
      return pending !== null;
    },
    dispose() {
      clearPending();
    }
  };
}
