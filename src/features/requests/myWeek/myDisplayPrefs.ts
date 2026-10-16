// Per-device display choices of `/my` (owner 2026-10-16): list or table view, and whether the children's rides show.
// Browser storage only (never account data); every access is wrapped — private mode / garbage must not break the screen.
import { useState } from "react";

const STORAGE_KEY = "my.display.v1";

export interface MyDisplayPrefs {
  view: "list" | "week";
  showKidsRides: boolean;
}

export const DEFAULT_MY_DISPLAY_PREFS: MyDisplayPrefs = { view: "list", showKidsRides: false };

export function parseMyDisplayPrefs(raw: string | null): MyDisplayPrefs {
  if (!raw) return DEFAULT_MY_DISPLAY_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<MyDisplayPrefs> | null;
    return {
      view: parsed?.view === "week" || parsed?.view === "list" ? parsed.view : DEFAULT_MY_DISPLAY_PREFS.view,
      showKidsRides: typeof parsed?.showKidsRides === "boolean" ? parsed.showKidsRides : DEFAULT_MY_DISPLAY_PREFS.showKidsRides,
    };
  } catch {
    return DEFAULT_MY_DISPLAY_PREFS;
  }
}

function read(): MyDisplayPrefs {
  try {
    return parseMyDisplayPrefs(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_MY_DISPLAY_PREFS;
  }
}

function write(prefs: MyDisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A convenience, never a reason to block the screen.
  }
}

export function useMyDisplayPrefs() {
  const [prefs, setPrefs] = useState<MyDisplayPrefs>(read);
  function update(patch: Partial<MyDisplayPrefs>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      write(next);
      return next;
    });
  }
  return {
    view: prefs.view,
    setView: (view: MyDisplayPrefs["view"]) => update({ view }),
    showKidsRides: prefs.showKidsRides,
    setShowKidsRides: (showKidsRides: boolean) => update({ showKidsRides }),
  };
}
