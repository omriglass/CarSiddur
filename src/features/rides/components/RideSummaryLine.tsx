// Owner 2026-11-16: the ride sheet's summary sentence (`rideSummaryText`). The places in the middle need
// `ride_stretches`, read on demand only for a ride that has them (the same cached read as the stops view); anything
// else, and while it loads, is the ride's own label.
import { MapPin } from "lucide-react";

import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";

import { useRideStretchesQuery } from "../hooks";
import type { RidePerson } from "../ridePeople";
import { stopRows } from "../rideStretches";
import { rideSummaryText } from "../rideSummary";

export function RideSummaryLine({ rideId, version, route, people, lead }: {
  rideId: string | null; version: number | null; route: unknown; people: readonly RidePerson[]; lead: string;
}) {
  const points = parseRideRoute(route);
  const hasMiddle = routeHasIntermediates(points);
  const query = useRideStretchesQuery(rideId, version, hasMiddle);
  const text = hasMiddle && query.data ? rideSummaryText(lead, stopRows(points, people, query.data)) : lead;
  return (
    <p className="flex items-start gap-1 font-medium" data-testid="ride-summary">
      <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{text}</span>
    </p>
  );
}
