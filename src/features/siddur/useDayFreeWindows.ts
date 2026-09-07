import { useCars, useMaintenanceBlocks, useTurnaroundMinutes } from "@/features/fleet/hooks";
import { siddurCarName } from "@/lib/siddurCarName";
import { toInstant } from "@/features/requests/mapper";

import { computeCarFreeWindows, type CarFreeWindow } from "./freeWindows";
import { useBoardRides, useCarLocations } from "./hooks";

export interface DayFreeWindowsCar {
  id: string;
  name: string;
  type: "shared" | "temporary";
}

export interface DayFreeWindowsAway {
  carId: string;
  awayFrom: string;
  awayUntil: string | null;
}

export interface DayFreeWindowsResult {
  isLoading: boolean;
  /** Every shared car's free windows for `day`'s 06:00–23:59 range. */
  freeWindows: CarFreeWindow[];
  /** Raw away-from-home windows (any car), for the quick-request sheet's more specific warning. */
  awayWindows: DayFreeWindowsAway[];
  cars: DayFreeWindowsCar[];
}

/**
 * Shared data plumbing for every quick-request entry point (grid click, day-list button/free
 * gaps, Home card — UX_FLOWS.md §18): fetches what `features/siddur/freeWindows.ts`'s pure
 * `computeCarFreeWindows()` needs and runs it per active/shared car for one day. Kept as one
 * hook so the three call sites (`SiddurPage`, `HomePage`) don't each re-derive the same
 * `try_auto_approve()`-mirroring logic slightly differently.
 */
export function useDayFreeWindows(
  departmentId: string | undefined,
  weekStart: string | undefined,
  day: string | undefined,
  now: Date,
): DayFreeWindowsResult {
  const carsQuery = useCars(departmentId);
  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const turnaroundQuery = useTurnaroundMinutes(departmentId);

  const sharedCars = (carsQuery.data ?? []).filter((c) => c.type === "shared" && c.status === "active");
  const awayWindows: DayFreeWindowsAway[] = (carLocationsQuery.data ?? [])
    .filter((l): l is typeof l & { car_id: string; away_from: string } => !!l.car_id && !!l.away_from)
    .map((l) => ({
      carId: l.car_id,
      awayFrom: l.away_from,
      awayUntil: l.away_until,
    }));

  const freeWindows: CarFreeWindow[] = day
    ? sharedCars.flatMap((c) => {
        const turnaroundMinutes = turnaroundQuery.data ?? 30;
        return computeCarFreeWindows({
          carId: c.id,
          rides: (boardRidesQuery.data ?? [])
            .filter((r) => r.car_id === c.id && r.starts_at && r.ends_at)
            .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string })),
          maintenanceBlocks: (maintenanceQuery.data ?? [])
            .filter((b) => b.car_id === c.id)
            .map((b) => ({ startsAt: b.starts_at, endsAt: b.ends_at })),
          awayWindows: awayWindows.filter((w) => w.carId === c.id),
          turnaroundMinutes,
          rangeStart: Date.parse(toInstant(day, "06:00", false)),
          rangeEnd: Date.parse(toInstant(day, "23:59", false)),
          now: now.getTime(),
        });
      })
    : [];

  return {
    isLoading: carsQuery.isLoading || boardRidesQuery.isLoading || turnaroundQuery.isLoading || maintenanceQuery.isLoading,
    freeWindows,
    awayWindows,
    cars: sharedCars.map((c) => ({ id: c.id, name: siddurCarName(c), type: c.type })),
  };
}
