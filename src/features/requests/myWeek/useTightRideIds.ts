import { useQueries } from "@tanstack/react-query";

import { tightRideIdsOf } from "@/features/rides/tightSchedule";
import { fetchBoardRides, type BoardRide, type Week } from "@/features/siddur/api";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { effectiveWeekSettings } from "@/lib/weekSettings";

/**
 * The siddur's "tight schedule" marker (`tightScheduleRideIds` over the whole week) for the weeks my upcoming rides
 * fall in — the same week queries the siddur and the ride sheet use (cache shared), so the marker also shows on an
 * unpublished day the Sadran manages (owner 2026-10-16), where `v_ride_car_neighbours` has no data.
 */
export function useTightRideIds(
  departmentId: string | undefined,
  rides: readonly Pick<BoardRide, "week_start">[],
  weeks: readonly Pick<Week, "week_start" | "settings_overrides">[],
  departmentSettings: Parameters<typeof effectiveWeekSettings>[0],
  homeLocationId: string | null | undefined,
  cars: readonly { id: string; base_location_id?: string | null }[],
): Set<string> {
  const weekStarts = [...new Set(rides.flatMap((ride) => (ride.week_start ? [ride.week_start] : [])))].sort();
  const results = useQueries({
    queries: weekStarts.map((weekStart) => ({
      queryKey: siddurKeys.boardRides(departmentId as string, weekStart),
      queryFn: () => fetchBoardRides(departmentId as string, weekStart),
      enabled: !!departmentId,
      staleTime: 30_000,
    })),
  });
  const tight = new Set<string>();
  weekStarts.forEach((weekStart, index) => {
    const data = results[index]?.data;
    if (!data) return;
    const turnaround = effectiveWeekSettings(departmentSettings, weeks.find((week) => week.week_start === weekStart)).turnaroundMinutes;
    for (const id of tightRideIdsOf(data, turnaround, homeLocationId, cars)) tight.add(id);
  });
  return tight;
}
