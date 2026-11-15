import { useSyncExternalStore } from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(cb: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Tailwind `lg` (1024 px) and up; false without `matchMedia` (jsdom, previews). */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches, () => false);
}
