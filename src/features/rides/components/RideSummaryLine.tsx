// Owner 2026-11-16: the ride sheet's summary sentence (`rideSummaryText`). The places in the middle need
// `ride_stretches`, read on demand only for a ride that has them (the same cached read as the stops view); anything
// else, and while it loads, is the ride's own label. RP1 (owner 2026-11-21): a ride that goes both ways reads them too
// (who stays at the far end, who is picked up there); the board's sheet shows the line only when it says more than the
// label (`onlyWhenMore`).
import { MapPin } from "lucide-react";

import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";

import { useRideStretchesQuery } from "../hooks";
import type { RidePerson } from "../ridePeople";
import { stopRows } from "../rideStretches";
import { rideSummaryText } from "../rideSummary";

export function RideSummaryLine({ rideId, version, route, people, lead, onlyWhenMore = false }: {
  rideId: string | null; version: number | null; route: unknown; people: readonly RidePerson[]; lead: string; onlyWhenMore?: boolean;
}) {
  const points = parseRideRoute(route);
  const worth = routeHasIntermediates(points) || (points.some((p) => p.leg === "out") && points.some((p) => p.leg === "return"));
  const query = useRideStretchesQuery(rideId, version, worth);
  const text = worth && query.data ? rideSummaryText(lead, stopRows(points, people, query.data)) : lead;
  if (onlyWhenMore && text === lead) return null;
  return (
    <p className="flex items-start gap-1 font-medium" data-testid="ride-summary">
      <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{text}</span>
    </p>
  );
}
