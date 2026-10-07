import type { Json } from "@/integrations/supabase/types";

/** Department default (`department_settings.turnaround_minutes` column default) when no setting row is readable yet. */
export const DEFAULT_TURNAROUND_MINUTES = 30;
/** Department default (`department_settings.chauffeur_dwell_minutes` column default). */
export const DEFAULT_CHAUFFEUR_DWELL_MINUTES = 10;

export interface DepartmentSettingsLike {
  turnaround_minutes?: number | null;
  chauffeur_dwell_minutes?: number | null;
}

export interface WeekRowLike {
  settings_overrides?: Json | null;
}

export interface EffectiveWeekSettings {
  turnaroundMinutes: number;
  chauffeurDwellMinutes: number;
}

function overrideNumber(overrides: Json | null | undefined, key: string): number | undefined {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
  const raw = overrides[key];
  // SQL reads `settings_overrides->>'key'` and casts it with `::int`, so a numeric string counts too.
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The turnaround buffer and chauffeur dwell that apply to one week: the week's
 * `weeks.settings_overrides` value, else the department's setting, else the column default.
 * TS twin of SQL `required_turnaround_minutes(dept, week)` and the `chauffeur_dwell_minutes`
 * lookup (DATA_MODEL §3.3) — every client read of these two settings goes through here so the
 * board, the siddur, the solver input and the server agree (REQ §13.108 D1).
 */
export function effectiveWeekSettings(
  departmentSettings: DepartmentSettingsLike | null | undefined,
  weekRow: WeekRowLike | null | undefined,
): EffectiveWeekSettings {
  const overrides = weekRow?.settings_overrides;
  return {
    turnaroundMinutes:
      overrideNumber(overrides, "turnaround_minutes") ?? departmentSettings?.turnaround_minutes ?? DEFAULT_TURNAROUND_MINUTES,
    chauffeurDwellMinutes:
      overrideNumber(overrides, "chauffeur_dwell_minutes") ?? departmentSettings?.chauffeur_dwell_minutes ?? DEFAULT_CHAUFFEUR_DWELL_MINUTES,
  };
}
