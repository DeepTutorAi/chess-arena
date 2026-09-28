// "It's your turn" alert for players whose tab is in the background: the tab
// title blinks and (on phones) the device vibrates. Cleared the moment the tab
// becomes visible again. No Notification permission prompt — nothing to grant.

export function createTurnAlert({
  doc = globalThis.document,
  nav = globalThis.navigator,
  setIntervalImpl = (...args) => globalThis.setInterval(...args),
  clearIntervalImpl = (...args) => globalThis.clearInterval(...args),
  blinkMs = 1000,
} = {}) {
  let timer = null;
  let originalTitle = null;

  function restore() {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (doc && originalTitle !== null) doc.title = originalTitle;
    originalTitle = null;
  }

  doc?.addEventListener?.('visibilitychange', () => {
    if (!doc.hidden) restore();
  });

  return {
    /** Alert only when the tab is hidden. Returns true when an alert started. */
    notify(message = 'ถึงตาคุณ') {
      if (!doc || !doc.hidden) return false;
      if (originalTitle === null) originalTitle = doc.title;
      const alertTitle = `● ${message} — ${originalTitle}`;
      doc.title = alertTitle;
      if (timer === null) {
        let flash = false;
        timer = setIntervalImpl(() => {
          flash = !flash;
          doc.title = flash ? originalTitle : alertTitle;
        }, blinkMs);
      }
      try {
        nav?.vibrate?.([120, 60, 120]);
      } catch {
        // vibration is best effort (blocked without a recent user gesture)
      }
      return true;
    },
    /** Stop blinking and restore the normal title. */
    clear: restore,
    get active() {
      return timer !== null;
    },
  };
}
