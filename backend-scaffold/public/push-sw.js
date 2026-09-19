/**
 * Service worker for real, OS-level push notifications from the admin
 * panel (see services/pushNotifier.js for the server side). Two jobs:
 *
 *   1. 'push' — a message arrived from our server, possibly while no admin
 *      panel tab is even open. Show it as a normal system notification
 *      (same as any app's — banner, lock screen, notification center).
 *
 *   2. 'notificationclick' — the merchant tapped it. Focus an already-open
 *      admin panel tab and tell it which order to jump to, or if none is
 *      open, open one straight to that order.
 *
 * This file must be served from the SAME origin as admin.html, at the site
 * root (e.g. https://your-backend.onrender.com/push-sw.js) — that's what
 * server.js's express.static(public/) does.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'New order', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'New order';
  const options = {
    body: data.body || '',
    // icon/badge are optional — if these files don't exist, browsers just
    // fall back to a default icon, nothing breaks.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { orderId: data.orderId || null },
    tag: data.orderId ? `order-${data.orderId}` : undefined,
    requireInteraction: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const orderId = event.notification.data && event.notification.data.orderId;
  const targetUrl = orderId
    ? `/admin.html#order-${encodeURIComponent(orderId)}`
    : '/admin.html';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        const url = new URL(client.url);
        if (url.pathname.endsWith('/admin.html') && 'focus' in client) {
          await client.focus();
          if (orderId) client.postMessage({ type: 'navigate-order', orderId });
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })()
  );
});
