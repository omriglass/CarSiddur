import { useState } from "react";

/**
 * "Allow experimental features" (owner 2026-10-12, profile switch). Per-device, `localStorage` only — no Supabase
 * column, so an experimental feature ships on `main` without a schema change and stays invisible until a member opts
 * in on this device. Same try/catch pattern as `features/siddur/useSiddurDisplayPrefs.ts`. Today it gates only the
 * Google calendar behind the "my rides" week view (`features/calendar/`).
 */
const STORAGE_KEY = "experimental.enabled.v1";

export function readExperimentalEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExperimentalEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A convenience only; storage may be denied in private browsing.
  }
}

export function useExperimentalFeatures(): { enabled: boolean; setEnabled: (enabled: boolean) => void } {
  const [enabled, setEnabledState] = useState(readExperimentalEnabled);
  function setEnabled(next: boolean) {
    setEnabledState(next);
    writeExperimentalEnabled(next);
  }
  return { enabled, setEnabled };
}
