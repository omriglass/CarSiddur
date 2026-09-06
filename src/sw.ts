/// <reference lib="webworker" />

// Minimal service worker for carshare-nevo, generated via vite-plugin-pwa's
// `injectManifest` strategy so the push handlers below are ours (see
// docs/ARCHITECTURE.md §3, §9). Precaching is Workbox; push handling is
// hand-written and intentionally small.

import { precacheAndRoute } from "workbox-precaching";
import type { PrecacheEntry } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

precacheAndRoute(self.__WB_MANIFEST);

self.skipWaiting();
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
}

function parsePushPayload(event: PushEvent): PushPayload {
  if (!event.data) return {};
  try {
    return event.data.json() as PushPayload;
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener("push", (event: PushEvent) => {
  const { title, body, url } = parsePushPayload(event);

  event.waitUntil(
    self.registration.showNotification(title ?? "סידור רכב נבו", {
      body: body ?? "",
      dir: "rtl",
      lang: "he",
      data: { url: url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  const url = (event.notification.data?.url as string | undefined) ?? "/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      const targetUrl = new URL(url, self.location.origin).href;

      for (const client of clientList) {
        if (client.url === targetUrl && "focus" in client) {
          await client.focus();
          return;
        }
      }

      const anyClient = clientList[0];
      if (anyClient && "navigate" in anyClient && "focus" in anyClient) {
        await anyClient.focus();
        await anyClient.navigate(targetUrl);
        return;
      }

      await self.clients.openWindow(targetUrl);
    })(),
  );
});
