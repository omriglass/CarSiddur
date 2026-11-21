// RP1 (owner 2026-11-21): the ride cards (siddur grid and list, the board's blocks, /my) say a complex ride as the
// ride sheet's flow sentence ("חבר, טל וגל יוצאים מהבית, משאירים את גל בזכרון יעקב…") instead of the label and a
// people line. Only rides that can be complex are read - places in the middle, or both ways with more than one
// person - in one `rides_stretches` call; each ride's own stretches query is filled too, so opening its sheet costs
// nothing more.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { parseRideRoute } from "@/lib/rideRoute";

import type { BoardRide } from "./api";
import { fetchRidesStretches } from "./api";
import { ridesKeys } from "./keys";
import { peopleOf } from "./ridePeople";
import { stopRows } from "./rideStretches";
import { rideFlowText } from "./rideSummary";

/** A ride whose people may not all ride the whole way both ways. */
export function mayBeComplex(ride: Pick<BoardRide, "route" | "people">): boolean {
  const points = parseRideRoute(ride.route);
  if (points.some((p) => p.kind === "stop" || p.kind === "board" || p.kind === "alight")) return true;
  return points.some((p) => p.leg === "out") && points.some((p) => p.leg === "return") && peopleOf(ride).length > 1;
}

/** Ride id -> its flow sentence, for the complex rides only (a simple ride keeps its label). */
export function useRideSummaries(rides: readonly BoardRide[], homeId: string | null | undefined | ((ride: BoardRide) => string | null | undefined)): Map<string, string> {
  const queryClient = useQueryClient();
  const candidates = useMemo(() => rides.filter((ride) => ride.id && mayBeComplex(ride)).slice(0, 200), [rides]);
  const ids = candidates.map((ride) => `${ride.id}:${ride.version ?? ""}`);
  const query = useQuery({
    queryKey: ridesKeys.stretchesBatch(ids),
    queryFn: async () => {
      const map = await fetchRidesStretches(candidates.map((ride) => ride.id as string));
      for (const ride of candidates) {
        const value = map.get(ride.id as string);
        if (value !== undefined) queryClient.setQueryData(ridesKeys.stretches(ride.id as string, ride.version), value);
      }
      return map;
    },
    enabled: candidates.length > 0,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const out = new Map<string, string>();
    const data = query.data;
    if (!data) return out;
    for (const ride of candidates) {
      const stretches = data.get(ride.id as string);
      if (!stretches) continue;
      const points = parseRideRoute(ride.route);
      const hasOut = points.some((p) => p.leg === "out");
      const hasBack = points.some((p) => p.leg === "return");
      const home = typeof homeId === "function" ? homeId(ride) : homeId;
      const text = rideFlowText(stopRows(points, peopleOf(ride), stretches), home ?? null, hasOut && !hasBack ? "out" : hasBack && !hasOut ? "return" : null);
      if (text) out.set(ride.id as string, text);
    }
    return out;
  }, [query.data, candidates, homeId]);
}
