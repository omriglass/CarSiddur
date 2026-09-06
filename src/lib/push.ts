import { registerPushSubscription, unregisterPushSubscription } from "@/features/auth/api";
import { env } from "@/lib/env";

/**
 * Web push subscribe/unsubscribe (UX_FLOWS.md §3.2/§3.8, ARCHITECTURE.md §9).
 * The service worker itself (`src/sw.ts`) is registered by `vite-plugin-pwa`
 * (`injectRegister: "auto"`, `registerType: "autoUpdate"`); this module only
 * drives `pushManager` against the already-registered worker and wires the
 * result to `register_push_subscription` / a direct `push_subscriptions`
 * delete (no unregister RPC exists, see `features/auth/api.ts`).
 */

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** VAPID public key, base64url -> Uint8Array (the shape `pushManager.subscribe` expects). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  return navigator.serviceWorker.ready;
}

/** The current subscription, if any — used to render "מופעל / כבוי" on Profile. */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Requests notification permission, subscribes via the VAPID public key and
 * registers the subscription server-side. Throws if unsupported, denied, or
 * the registration RPC fails (caller shows the Hebrew toast via `showErrorToast`).
 */
export async function subscribeToPush(): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error("push_unsupported");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("push_permission_denied");
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(env.VITE_VAPID_PUBLIC_KEY) as BufferSource,
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("push_subscription_incomplete");
  }
  await registerPushSubscription({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  });
  return subscription;
}

/** Unsubscribes locally and removes the server-side row. No-op if not subscribed. */
export async function unsubscribeFromPush(): Promise<void> {
  const registration = await getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await unregisterPushSubscription(endpoint);
}
