// Service worker: shows order notifications pushed by the server (also when the site is closed)
// and opens the market when one is tapped.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'SpotBook', body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'SpotBook', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = tabs.find(t => t.url === url) || tabs.find(t => new URL(t.url).origin === self.location.origin);
    if (same) {
      await same.focus();
      if (same.url !== url && 'navigate' in same) await same.navigate(url);
      return;
    }
    await self.clients.openWindow(url);
  })());
});
