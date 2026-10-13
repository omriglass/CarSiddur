import { useCallback, useState } from "react";

/** Per-device memory of the weeks folded on `/my` (owner 2026-10-13); a convenience, so storage failures are ignored. */
const STORAGE_KEY = "my.collapsedWeeks";

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/** Every week is open until the member folds it; the key is `weekStart:departmentId`. */
export function useCollapsedWeeks(): { isCollapsed: (key: string) => boolean; toggle: (key: string) => void } {
  const [collapsed, setCollapsed] = useState<string[]>(read);
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      // Only the latest few folds are kept: old weeks drop off the list on their own.
      const next = current.includes(key) ? current.filter((value) => value !== key) : [...current, key].slice(-20);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode / blocked storage: the fold still works for this visit.
      }
      return next;
    });
  }, []);
  const isCollapsed = useCallback((key: string) => collapsed.includes(key), [collapsed]);
  return { isCollapsed, toggle };
}
