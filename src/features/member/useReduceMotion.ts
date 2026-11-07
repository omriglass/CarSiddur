import { useState } from "react";

/**
 * "Turn off animations" (owner 2026-11-07, REQ §13.185 h, profile switch). Per-device, `localStorage` only, like
 * `useExperimentalFeatures`. While on, `<html data-reduce-motion>` and the rule in `index.css` stop every
 * animation and transition app-wide, whatever the device's own reduced-motion setting says.
 */
const STORAGE_KEY = "a11y.reduceMotion.v1";

function readReduceMotion(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function applyReduceMotion(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-reduce-motion", "");
  else document.documentElement.removeAttribute("data-reduce-motion");
}

/** Called once from `main.tsx`, before the first render. */
export function installReduceMotion(): void {
  applyReduceMotion(readReduceMotion());
}

export function useReduceMotion(): { enabled: boolean; setEnabled: (enabled: boolean) => void } {
  const [enabled, setEnabledState] = useState(readReduceMotion);
  function setEnabled(next: boolean) {
    setEnabledState(next);
    applyReduceMotion(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // A convenience only; storage may be denied in private browsing.
    }
  }
  return { enabled, setEnabled };
}
