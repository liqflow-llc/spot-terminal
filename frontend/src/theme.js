// Light / dark / system colour theme. The choice lives in localStorage; "system" follows the
// device setting live. index.html applies it before first paint (same key and logic) so the page
// never flashes the wrong colours.
import { useEffect, useState } from 'react';

const KEY = 'spot.theme';
const PREFS = ['system', 'light', 'dark'];
const META_COLOR = { dark: '#0b0e11', light: '#f5f7fa' };
const media = () => window.matchMedia?.('(prefers-color-scheme: light)');
const listeners = new Set();

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    return PREFS.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

const resolve = (pref) => (pref === 'system' ? (media()?.matches ? 'light' : 'dark') : pref);

function apply() {
  const theme = resolve(getThemePref());
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
  for (const fn of listeners) fn(theme);
}

export function setThemePref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* private mode: applies to this visit only */ }
  apply();
}

/** Call once at startup: keeps "system" in step with the device's setting. */
export function initTheme() {
  apply();
  media()?.addEventListener?.('change', apply);
}

/** { pref, theme, setPref }: theme is the one in effect, 'light' or 'dark'. */
export function useTheme() {
  const [pref, setPref] = useState(getThemePref);
  const [theme, setTheme] = useState(() => resolve(getThemePref()));
  useEffect(() => {
    const fn = (t) => { setTheme(t); setPref(getThemePref()); };
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return { pref, theme, setPref: setThemePref };
}
