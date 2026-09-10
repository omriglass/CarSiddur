import { useState } from "react";

/**
 * Per-device Sadran board display preferences (UX_FLOWS.md §4.2 mobile
 * header "eye" display menu): cards-vs-table, table zoom, "show early hours"
 * and "show legend" persist across visits on this device only — a sibling of
 * `features/siddur/useSiddurDisplayPrefs.ts` (same shape + try/catch
 * localStorage pattern) rather than a generalized shared hook, so the
 * member siddur's own storage key/defaults stay untouched.
 */
const STORAGE_KEY = "board.display.v1";

interface BoardDisplayPrefsValue {
  tableView: boolean;
  tableZoom: number;
  showEarlyHours: boolean;
  showLegend: boolean;
}

const DEFAULT_PREFS: BoardDisplayPrefsValue = { tableView: false, tableZoom: 1, showEarlyHours: false, showLegend: true };

function readPrefs(): BoardDisplayPrefsValue {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<BoardDisplayPrefsValue>;
    return {
      tableView: typeof parsed.tableView === "boolean" ? parsed.tableView : DEFAULT_PREFS.tableView,
      tableZoom: typeof parsed.tableZoom === "number" ? parsed.tableZoom : DEFAULT_PREFS.tableZoom,
      showEarlyHours: typeof parsed.showEarlyHours === "boolean" ? parsed.showEarlyHours : DEFAULT_PREFS.showEarlyHours,
      showLegend: typeof parsed.showLegend === "boolean" ? parsed.showLegend : DEFAULT_PREFS.showLegend,
    };
  } catch {
    // Private browsing / restrictive webviews may deny storage or hold garbage — today's
    // defaults remain a safe fallback either way.
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: BoardDisplayPrefsValue): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Persisting the preference is a convenience, never a reason to block the screen.
  }
}

export function useBoardDisplayPrefs() {
  const [prefs, setPrefs] = useState<BoardDisplayPrefsValue>(readPrefs);

  function update(patch: Partial<BoardDisplayPrefsValue>) {
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
    showLegend: prefs.showLegend,
    setShowLegend: (showLegend: boolean) => update({ showLegend }),
  };
}
