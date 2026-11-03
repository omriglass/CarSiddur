import { useState } from "react";

/**
 * Per-device siddur display preferences (UX_FLOWS.md member siddur "display"
 * menu): cards-vs-table, table zoom and "show early hours" persist across
 * visits on this device only — never account data, so a plain `localStorage`
 * read/write (try/catch, same pattern as `features/sadran/lastUsedPolicy.ts`
 * and `features/auth/useActiveDepartment.ts`) is enough; no Supabase column.
 */
const STORAGE_KEY = "siddur.display.v1";

interface SiddurDisplayPrefsValue {
  tableView: boolean;
  tableZoom: number;
  showEarlyHours: boolean;
}

const DEFAULT_PREFS: SiddurDisplayPrefsValue = { tableView: false, tableZoom: 1, showEarlyHours: false };

function readPrefs(): SiddurDisplayPrefsValue {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<SiddurDisplayPrefsValue>;
    return {
      tableView: typeof parsed.tableView === "boolean" ? parsed.tableView : DEFAULT_PREFS.tableView,
      tableZoom: typeof parsed.tableZoom === "number" ? parsed.tableZoom : DEFAULT_PREFS.tableZoom,
      showEarlyHours: typeof parsed.showEarlyHours === "boolean" ? parsed.showEarlyHours : DEFAULT_PREFS.showEarlyHours,
    };
  } catch {
    // Private browsing / restrictive webviews may deny storage or hold garbage — today's
    // defaults remain a safe fallback either way.
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: SiddurDisplayPrefsValue): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Persisting the preference is a convenience, never a reason to block the screen.
  }
}

export function useSiddurDisplayPrefs() {
  const [prefs, setPrefs] = useState<SiddurDisplayPrefsValue>(readPrefs);

  function update(patch: Partial<SiddurDisplayPrefsValue>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      writePrefs(next);
      return next;
    });
  }

  return {
    tableView: prefs.tableView,
    setTableView: (tableView: boolean) => update({ tableView }),
    tableZoom: prefs.tableZoom,
    setTableZoom: (tableZoom: number) => update({ tableZoom }),
    showEarlyHours: prefs.showEarlyHours,
    setShowEarlyHours: (showEarlyHours: boolean) => update({ showEarlyHours }),
  };
}
