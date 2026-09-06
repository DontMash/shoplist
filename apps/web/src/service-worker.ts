/// <reference lib="webworker" />

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';
import { notificationClickUrl } from './lib/notification-click';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [/^\/api\//],
}));
registerRoute(({ url }) => url.pathname === '/api/qr', new StaleWhileRevalidate({ cacheName: 'shoplist-qr' }));

self.addEventListener('push', (event) => {
  let payload: { title?: string; body?: string; url?: string; tag?: string } = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || 'Your list changed.' };
  }
  event.waitUntil(self.registration.showNotification(payload.title || 'Shoplist', {
    body: payload.body || 'Your list changed.',
    tag: payload.tag || 'shoplist',
    data: payload,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = notificationClickUrl(event.notification.data);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        await client.navigate(new URL(url, self.location.origin).href);
        return;
      }
    }
    await self.clients.openWindow(new URL(url, self.location.origin).href);
  })());
});
