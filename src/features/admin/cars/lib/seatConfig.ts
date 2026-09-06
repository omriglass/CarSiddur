// Pure helpers for the SeatConfigEditor (docs/UX_FLOWS.md §5.4): dominance
// validation (a row that's entirely covered by another row can be removed)
// and a handful of common presets. Reuses the solver's own `dominates()` so
// "redundant row" in the admin editor means exactly what "dominated
// configuration" means to the solver (docs/SOLVER.md §3.3) — no second
// definition to keep in sync.

import { dominates } from "@/solver";

import type { Passengers } from "@/solver";

export interface SeatConfigDraft extends Passengers {
  /** stable client-side key for list rendering / row removal, not persisted. */
  key: string;
}

/**
 * Indices of rows that are dominated by some *other* row in the list (both
 * directions of an exact tie count as dominated — one of the two duplicates
 * is redundant). Empty configs (all-zero) never dominate anything.
 */
export function findDominatedIndices(rows: Passengers[]): number[] {
  const dominated: number[] = [];
  rows.forEach((row, i) => {
    const isDominated = rows.some((other, j) => {
      if (i === j) return false;
      if (dominates(other, row)) {
        // An exact duplicate dominates both ways; keep the earlier index only.
        if (dominates(row, other) && i < j) return false;
        return true;
      }
      return false;
    });
    if (isDominated) dominated.push(i);
  });
  return dominated;
}

export function isEmptyConfig(row: Passengers): boolean {
  return row.adults === 0 && row.childSeats === 0 && row.boosters === 0;
}

export interface SeatConfigPreset {
  labelKey: "seatConfigPresetSedan5" | "seatConfigPresetMinivan7" | "seatConfigPresetVan9" | "seatConfigPresetSmall4";
  configs: Passengers[];
}

export const SEAT_CONFIG_PRESETS: SeatConfigPreset[] = [
  { labelKey: "seatConfigPresetSedan5", configs: [{ adults: 5, childSeats: 0, boosters: 0 }, { adults: 3, childSeats: 1, boosters: 0 }, { adults: 3, childSeats: 0, boosters: 1 }] },
  { labelKey: "seatConfigPresetMinivan7", configs: [{ adults: 7, childSeats: 0, boosters: 0 }, { adults: 5, childSeats: 2, boosters: 0 }, { adults: 4, childSeats: 0, boosters: 3 }] },
  { labelKey: "seatConfigPresetVan9", configs: [{ adults: 9, childSeats: 0, boosters: 0 }, { adults: 6, childSeats: 3, boosters: 0 }] },
  { labelKey: "seatConfigPresetSmall4", configs: [{ adults: 4, childSeats: 0, boosters: 0 }, { adults: 2, childSeats: 2, boosters: 0 }] },
];
