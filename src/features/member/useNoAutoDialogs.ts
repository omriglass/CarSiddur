import { useState } from "react";

/**
 * "Do not open sheets automatically in a new request" (owner 2026-10-16, profile switch). Per-device, `localStorage`
 * only, default off (the guided start runs). Same try/catch pattern as `useExperimentalFeatures.ts`.
 */
const STORAGE_KEY = "requestForm.noAutoDialogs.v1";

export function readNoAutoDialogs(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeNoAutoDialogs(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A convenience only; storage may be denied in private browsing.
  }
}

export function useNoAutoDialogs(): { enabled: boolean; setEnabled: (enabled: boolean) => void } {
  const [enabled, setEnabledState] = useState(readNoAutoDialogs);
  function setEnabled(next: boolean) {
    setEnabledState(next);
    writeNoAutoDialogs(next);
  }
  return { enabled, setEnabled };
}
