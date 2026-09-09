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
    // Documented exception to CLAUDE.md hard rule 3 (Hebrew in exactly three
    // places): `tsconfig.sw.json` deliberately scopes this file's build to
    // itself only (see its `include`), so it cannot statically import
    // `src/i18n/he.ts` (which pulls in `he.admin.ts`/`he.member.ts`/
    // `he.sadran.ts`, none listed in that project). This fallback title is
    // only shown when a push payload omits its own title, which never
    // happens for real notifications (every `notification_templates` row
    // has one) — see docs/REFACTOR_BACKLOG.md §5.4.
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
