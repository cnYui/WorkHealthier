// Monitoring session clock, sedentary reminder, and time formatting.

export const SESSION_DEFAULTS = Object.freeze({
  sedentaryMs: 45 * 60 * 1000, // remind to stand up after this long
  sedentaryCooldownMs: 5 * 60 * 1000 // after a dismiss, remind again after this long
});

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// 00:00 for under an hour, h:mm:ss above.
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((typeof ms === 'number' ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
  return pad2(m) + ':' + pad2(s);
}

export function formatMinutes(ms) {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + ' h' + (m > 0 ? ' ' + m + ' min' : '');
}

export function createSession(options) {
  const cfg = Object.assign({}, SESSION_DEFAULTS, options || {});
  const state = {
    startedAt: null,
    pausedAt: null,
    pausedTotalMs: 0,
    sedentaryStartedAt: null,
    reminderActive: false,
    reminderSince: null,
    remindedUntil: 0,
    reminders: 0
  };

  function elapsed(now) {
    if (state.startedAt === null) return 0;
    const end = state.pausedAt !== null ? state.pausedAt : now;
    return Math.max(0, end - state.startedAt - state.pausedTotalMs);
  }

  return {
    config: cfg,

    start(now) {
      if (state.startedAt !== null) return false;
      state.startedAt = now;
      state.sedentaryStartedAt = now;
      return true;
    },

    isRunning() {
      return state.startedAt !== null && state.pausedAt === null;
    },

    isStarted() {
      return state.startedAt !== null;
    },

    pause(now) {
      if (state.startedAt === null || state.pausedAt !== null) return false;
      state.pausedAt = now;
      return true;
    },

    resume(now) {
      if (state.pausedAt === null) return false;
      state.pausedTotalMs += Math.max(0, now - state.pausedAt);
      state.pausedAt = null;
      return true;
    },

    elapsed,

    // Advances the sedentary reminder; returns the reminder state.
    tick(now) {
      if (state.startedAt === null || state.pausedAt !== null) {
        return { active: state.reminderActive, since: state.reminderSince };
      }
      const sitting = now - state.sedentaryStartedAt;
      if (!state.reminderActive && sitting >= cfg.sedentaryMs && now >= state.remindedUntil) {
        state.reminderActive = true;
        state.reminderSince = now;
        state.reminders += 1;
      }
      return { active: state.reminderActive, since: state.reminderSince, sittingMs: sitting };
    },

    sittingMs(now) {
      if (state.sedentaryStartedAt === null) return 0;
      return Math.max(0, now - state.sedentaryStartedAt);
    },

    // The wearer acknowledged the reminder: restart the sitting clock.
    dismissReminder(now) {
      if (!state.reminderActive) return false;
      state.reminderActive = false;
      state.reminderSince = null;
      state.sedentaryStartedAt = now;
      state.remindedUntil = now + cfg.sedentaryCooldownMs;
      return true;
    },

    snapshot(now) {
      return {
        started: state.startedAt !== null,
        running: state.startedAt !== null && state.pausedAt === null,
        elapsedMs: elapsed(now),
        sittingMs: state.sedentaryStartedAt === null ? 0 : Math.max(0, now - state.sedentaryStartedAt),
        reminder: { active: state.reminderActive, since: state.reminderSince },
        reminders: state.reminders
      };
    }
  };
}
