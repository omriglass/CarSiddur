// REQ §13.94: the ride's whole route (`v_board_rides.route`, both legs) with estimated times and
// boarding/alighting marks - shared by the Sadran `RideSheet` and the member `RideDetailSheet`.
// Renders nothing for a plain origin -> destination ride (nothing worth saying); callers keep
// `RideRouteStops` as the fallback for rows that carry no `route` at all.
import { ArrowDownToLine, ArrowUpFromLine, Flag, MapPin, Navigation } from "lucide-react";

import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { entryCoversLeg, type ServedEntry } from "../servedOf";
import { parseRideRoute, routeHasIntermediates, type RouteKind, type RoutePoint } from "@/lib/rideRoute";

const KIND_ICON: Record<RouteKind, typeof MapPin> = {
  origin: Navigation,
  stop: MapPin,
  board: ArrowUpFromLine,
  alight: ArrowDownToLine,
  destination: Flag,
};

function kindLabel(point: RoutePoint): string {
  switch (point.kind) {
    case "board": return tv("rideRoute.board", { name: point.name });
    case "alight": return tv("rideRoute.alight", { name: point.name });
    default: return point.name;
  }
}

export interface RideRouteProps {
  /** `BoardRide["route"]`. */
  route: unknown;
  /** QB24: the ride's served entries - a relay ride shows only the leg(s) they cover. Omit to show every leg. */
  served?: readonly Pick<ServedEntry, "leg">[];
}

export function RideRoute({ route, served }: RideRouteProps) {
  const points = parseRideRoute(route);
  if (!routeHasIntermediates(points)) return null;
  return (
    <div className="space-y-1" data-testid="ride-route">
      <span className="font-medium">{he.rideRoute.title}</span>
      {(["out", "return"] as const).map((leg) => {
        const legPoints = points.filter((p) => p.leg === leg);
        if (!legPoints.length || (served?.length && !served.some((entry) => entryCoversLeg(entry, leg)))) return null;
        return (
          <div key={leg} className="text-xs text-muted-foreground" data-testid={`ride-route-${leg}`}>
            <p className="font-medium text-foreground">{leg === "out" ? he.rideRoute.out : he.rideRoute.return}</p>
            <ol className="space-y-0.5">
              {legPoints.map((point) => {
                const Icon = KIND_ICON[point.kind];
                return (
                  <li key={`${point.leg}:${point.position}`} className="flex items-center gap-1.5" data-route-kind={point.kind}>
                    <Icon className="size-3 shrink-0" aria-hidden="true" />
                    <span>{kindLabel(point)}</span>
                    {point.eta ? <span dir="ltr" className="tabular-nums">{formatTime(new Date(point.eta))}</span> : null}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
