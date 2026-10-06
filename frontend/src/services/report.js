// Sends failures that only the browser sees (wallet errors, crashes) to the server log, so they
// can be found when checking on the site. Never sends anything for a user cancelling in their
// wallet, and the same message at most once a minute.
const recent = new Map(); // message -> time sent

export function reportError(kind, err, context = {}) {
  try {
    const message = String(err?.message || err || '').slice(0, 300);
    if (!message || /reject|denied|cancel/i.test(message)) return;
    const key = `${kind}|${message}`;
    const now = Date.now();
    if (now - (recent.get(key) || 0) < 60_000) return;
    recent.set(key, now);
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, message, where: location.pathname, ...context }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must never break the page.
  }
}

/** Uncaught errors and promise rejections anywhere on the page. */
export function installGlobalErrorReporting() {
  window.addEventListener('error', (e) => {
    if (/ResizeObserver loop/.test(e.message || '')) return; // harmless browser noise
    reportError('crash', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled', e.reason));
}
