import { useMemo, type ReactNode } from "react";

import { useRideTypes } from "@/features/fleet/hooks";

import { RideTypeColorsContext } from "./rideTypeColorsContext";

/** Supplies the active department's ride-type colours to everything below the app shell (REQ §13.177 b). */
export function RideTypeColorsProvider({ children }: { children: ReactNode }) {
  const rideTypesQuery = useRideTypes();
  const colorByCode = useMemo(
    () => new Map((rideTypesQuery.data ?? []).map((rideType) => [rideType.code, rideType.color] as const)),
    [rideTypesQuery.data],
  );
  return <RideTypeColorsContext.Provider value={colorByCode}>{children}</RideTypeColorsContext.Provider>;
}
