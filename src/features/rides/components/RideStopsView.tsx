// REQ item 246 h (owner mock board 5): the stops view - the one drawing of who rides where. Per leg, each place
// with its time, who gets off (↓) and on (↑) there, and the free seats on the next stretch. Read on demand
// (`ride_stretches`) only for a ride with places in the middle; anything else (and while it loads) shows
// `RideRoute` as before.
import { he, tv } from "@/i18n/he";
import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";
import { formatTime } from "@/lib/time";

import { useRideStretchesQuery } from "../hooks";
import { stopRows } from "../rideStretches";
import type { RidePerson } from "../ridePeople";
import type { ServedEntry } from "../servedOf";
import { RideRoute } from "./RideRoute";

export interface RideStopsViewProps {
  rideId: string | null;
  version: number | null;
  route: unknown;
  people: readonly RidePerson[];
  served?: readonly Pick<ServedEntry, "leg">[];
}

function freeLabel(n: number): string {
  if (n > 1) return tv("rideStops.freeMany", { n: String(n) });
  return n === 1 ? he.rideStops.freeOne : he.rideStops.full;
}

export function RideStopsView({ rideId, version, route, people, served }: RideStopsViewProps) {
  const points = parseRideRoute(route);
  const hasMiddle = routeHasIntermediates(points);
  const query = useRideStretchesQuery(rideId, version, hasMiddle);
  if (!hasMiddle || !query.data) return <RideRoute route={route} served={served} />;
  const rows = stopRows(points, people, query.data);
  if (!rows.length) return <RideRoute route={route} served={served} />;

  return (
    <div className="space-y-1" data-testid="ride-stops-view">
      <span className="font-medium">{he.rideStops.title}</span>
      <ol className="space-y-1.5 text-sm">
        {rows.map((row) => (
          <li key={`${row.leg}:${row.point.position}`} data-testid={`ride-stop-${row.leg}-${row.point.position}`}>
            {row.first ? (
              <p className={`text-xs font-semibold text-muted-foreground ${row.leg === "return" ? "mt-2 border-t pt-2" : ""}`}>
                {row.leg === "out" ? he.rideRoute.out : he.rideRoute.return}
              </p>
            ) : null}
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{row.point.name}</span>
              {row.point.eta ? <span dir="ltr" className="text-xs tabular-nums text-muted-foreground">{formatTime(new Date(row.point.eta))}</span> : null}
            </div>
            {row.off.length ? <p className="text-xs" data-testid="ride-stop-off">{tv("rideStops.off", { names: row.off.join(", ") })}</p> : null}
            {row.on.length ? <p className="text-xs" data-testid="ride-stop-on">{tv("rideStops.on", { names: row.on.join(", ") })}</p> : null}
            {row.free != null ? <p className="text-xs text-muted-foreground" data-testid="ride-stop-free">{freeLabel(row.free)}</p> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
