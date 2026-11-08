import { useEffect, useState } from "react";

import {
  applyAppearance,
  getStoredCustomTheme,
  getStoredMode,
  getStoredThemeId,
  storeCustomTheme,
  storeMode,
  storeThemeId,
  THEME_CHANGE_EVENT,
  type ModePreference,
} from "@/themes/apply";
import type { CustomTheme } from "@/themes/types";

/**
 * Profile → "מראה" (REQ §13.196): the light/dark/by-device mode, the theme, and the member's custom colours. A
 * pure client preference stored on the device only (`src/themes/apply.ts`); `main.tsx` applies it before the first
 * paint and follows the device's dark setting live while the mode is "system".
 */
export type ThemePreference = ModePreference;

export function useTheme(): {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  themeId: string;
  setThemeId: (id: string) => void;
  custom: CustomTheme;
  setCustom: (next: CustomTheme) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredMode);
  const [themeId, setThemeIdState] = useState<string>(getStoredThemeId);
  const [custom, setCustomState] = useState<CustomTheme>(getStoredCustomTheme);

  useEffect(() => {
    const sync = () => {
      setPreferenceState(getStoredMode());
      setThemeIdState(getStoredThemeId());
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return {
    preference,
    setPreference(next) {
      storeMode(next);
      applyAppearance();
    },
    themeId,
    setThemeId(id) {
      storeThemeId(id);
      applyAppearance();
    },
    custom,
    setCustom(next) {
      setCustomState(next);
      storeCustomTheme(next);
      applyAppearance();
    },
  };
}
