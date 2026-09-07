import { useEffect, useState } from "react";

/**
 * Light/dark/system theme preference (Profile screen, visual pass). No
 * `notification_event`/DB row for this — it's a pure client display
 * preference, stored in `localStorage` only (mirrors the reference app's
 * dark-theme token set, CLAUDE.md hard rule 6 doesn't apply — this isn't a
 * timestamp). `"system"` follows the OS `prefers-color-scheme` media query
 * live; `"light"`/`"dark"` pin it regardless of the OS setting.
 */
export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "nevo-theme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Exported so `main.tsx` can read the same stored value `applyTheme` expects, without duplicating the storage key/parsing logic. */
export function getStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

function resolveIsDark(preference: ThemePreference): boolean {
  if (preference === "dark") return true;
  if (preference === "light") return false;
  return typeof window !== "undefined" && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/** Toggles the `dark` class Tailwind's `darkMode: ["class"]` strategy reads (`src/index.css` `.dark { ... }`). Exported so `main.tsx` can apply it once, synchronously, before the first paint (no flash of the wrong theme). */
export function applyTheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveIsDark(preference));
}

/** `useTheme()` — Profile's theme picker. Reactively follows the OS setting while `preference === "system"`. */
export function useTheme(): { preference: ThemePreference; setPreference: (next: ThemePreference) => void } {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => getStoredPreference());

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = () => applyTheme(preference);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  function setPreference(next: ThemePreference) {
    setPreferenceState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  return { preference, setPreference };
}
