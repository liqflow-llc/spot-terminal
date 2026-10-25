import { useCallback, useEffect, useState } from 'react';

// Starred markets, kept in this browser only (a per-viewer convenience). Every component using
// the hook stays in sync, across tabs too.
const KEY = 'spot.favoriteMarkets';
const EVENT = 'spot:favorites';

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(a => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState(read);

  useEffect(() => {
    const sync = () => setFavorites(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const toggle = useCallback((address) => {
    const current = read();
    const next = current.includes(address) ? current.filter(a => a !== address) : [address, ...current];
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode): keep it for this page view only.
    }
    setFavorites(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return { favorites, isFavorite: (address) => favorites.includes(address), toggle };
}
