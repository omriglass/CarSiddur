import { createContext, useContext, useMemo } from "react";

import type { RideTypeColor } from "@/lib/enums";
import { rideTypeColorClasses, type RideTypeColorClasses } from "@/lib/rideTypeColors";

/**
 * REQ §13.177 (b): the active department's ride-type colours (`ride_types.color`) by code, for every ride block,
 * legend and chart (`RideTypeColorsProvider` in the app shell). Without a provider (unit tests) colours fall back by
 * seeded code, as before.
 */
export const RideTypeColorsContext = createContext<ReadonlyMap<string, RideTypeColor | null>>(new Map());

/** `rideTypeColorClasses` bound to the department's colours. */
export function useRideTypeColorClasses(): (code: string | null | undefined) => RideTypeColorClasses {
  const colorByCode = useContext(RideTypeColorsContext);
  return useMemo(() => (code: string | null | undefined) => rideTypeColorClasses(code, colorByCode), [colorByCode]);
}
