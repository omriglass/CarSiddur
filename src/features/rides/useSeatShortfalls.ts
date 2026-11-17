import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useCarSeatConfigs } from "@/features/fleet/hooks";
import { he, tv } from "@/i18n/he";
import { parseRideRoute } from "@/lib/rideRoute";

import type { BoardRide } from "./api";
import { fetchRideStretches } from "./api";
import { ridesKeys } from "./keys";
import type { RideStretches } from "./rideStretches";
import { maybeShort, seatsShortLabel, stretchShortfall, type SeatShortfall } from "./seatShortfall";

/**
 * REQ item 248: the rides with more people than seats, by ride id. The per-direction sum picks the few rides that may
 * be short; only those read their stretches (the same query the ride sheet uses, so opening it costs nothing more).
 */
export function useSeatShortfalls(rides: readonly BoardRide[], departmentId: string | null | undefined): Map<string, SeatShortfall> {
  const configsQuery = useCarSeatConfigs(departmentId ?? undefined);
  const suspects = useMemo(() => {
    const configs = configsQuery.data ?? [];
    if (!configs.length) return [];
    return rides.filter((ride) => ride.id && ride.car_id && maybeShort(ride, configs.filter((c) => c.car_id === ride.car_id)));
  }, [rides, configsQuery.data]);
  const combine = useCallback((results: { data?: RideStretches }[]) => {
    const out = new Map<string, SeatShortfall>();
    suspects.forEach((ride, i) => {
      const short = stretchShortfall(results[i]?.data ?? undefined, parseRideRoute(ride.route));
      if (short) out.set(ride.id as string, short);
    });
    return out;
  }, [suspects]);
  return useQueries({
    queries: suspects.map((ride) => ({
      queryKey: ridesKeys.stretches(ride.id as string, ride.version),
      queryFn: () => fetchRideStretches(ride.id as string),
    })),
    combine,
  });
}

/** "חסרים 2 מקומות" / "חסר מקום אחד", or undefined when everyone fits. */
export function seatsShortText(short: SeatShortfall | null | undefined): string | undefined {
  return seatsShortLabel(short, { one: he.rideStops.seatsShortOne, many: (n) => tv("rideStops.seatsShortMany", { n: String(n) }) });
}

/** "בדרך מבנימינה לחיפה" for a ride with places in the middle, else undefined (the whole way). */
export function seatsShortWhere(short: SeatShortfall | null | undefined): string | undefined {
  return short?.from && short.to ? tv("rideStops.seatsShortWhere", { from: short.from, to: short.to }) : undefined;
}
