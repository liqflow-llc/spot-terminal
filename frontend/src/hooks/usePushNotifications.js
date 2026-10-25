import { useCallback, useEffect, useState } from 'react';
import { getJSON, postJSON } from '../services/api';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

/**
 * Browser notifications for this wallet's orders (filled and paid out, expired, needs attention).
 * Delivered by push, so they arrive even when the site is closed.
 * status: 'unsupported' | 'blocked' | 'off' | 'on' | 'working'
 */
export function usePushNotifications(wallet) {
  const [status, setStatus] = useState(supported() ? 'off' : 'unsupported');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!supported() || !wallet) return undefined;
    let live = true;
    (async () => {
      if (Notification.permission === 'denied') return live && setStatus('blocked');
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return live && setStatus('off');
      const { subscribed } = await postJSON('/api/push/status', { wallet, endpoint: sub.endpoint }).catch(() => ({ subscribed: false }));
      if (live) setStatus(subscribed ? 'on' : 'off');
    })().catch(() => {});
    return () => { live = false; };
  }, [wallet]);

  const enable = useCallback(async () => {
    if (!supported() || !wallet) return;
    setError(null);
    setStatus('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setStatus(permission === 'denied' ? 'blocked' : 'off');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { publicKey } = await getJSON('/api/push/key');
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await postJSON('/api/push/subscribe', { wallet, subscription: sub.toJSON() });
      setStatus('on');
    } catch (err) {
      setError(err.message);
      setStatus('off');
    }
  }, [wallet]);

  const disable = useCallback(async () => {
    setStatus('working');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await postJSON('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
    } finally {
      setStatus('off');
    }
  }, []);

  return { status, error, enable, disable };
}
