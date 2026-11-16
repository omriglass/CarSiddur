// REQ item 246 h (owner mock board 5): the stops view - the one drawing of who rides where. Per leg, each place
// with its time, who gets off (↓) and on (↑) there, and the free seats on the next stretch. Read on demand
// (`ride_stretches`) only for a ride with places in the middle; anything else (and while it loads) shows
// `RideRoute` as before.
import { Lock } from "lucide-react";

import { he, tv } from "@/i18n/he";
import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";
import { formatTime } from "@/lib/time";

import { useRideStretchesQuery } from "../hooks";
import { stopRows, withStatedHours } from "../rideStretches";
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
  // LT1 phase 2e: the ride's estimate ("~"), and beside it a stated hour - a lock when kept, said when not
  const stated = withStatedHours(points, query.data);
  const rows = stopRows(stated.points, people, query.data);
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
              <span className="text-xs">
                {row.point.eta ? <span dir="ltr" className="tabular-nums text-muted-foreground">~{formatTime(new Date(row.point.eta))}</span> : null}
                {stated.kept.has(`${row.leg}:${row.point.position}`) ? (
                  <span className="ms-1.5 inline-flex items-center gap-1 font-semibold text-primary" data-testid="ride-stop-fixed">
                    <Lock className="size-3" aria-label={he.rideStops.fixed} />
                    <span dir="ltr" className="tabular-nums">{formatTime(new Date(stated.kept.get(`${row.leg}:${row.point.position}`) as string))}</span>
                  </span>
                ) : null}
                {/* Owner 2026-11-16: a stated hour the estimate misses is a warning in few words, never a refusal. */}
                {stated.missed.has(`${row.leg}:${row.point.position}`) ? (
                  <span className="ms-1.5 rounded bg-amber-100 px-1 font-medium text-amber-950 dark:bg-amber-900/40 dark:text-amber-100" data-testid="ride-stop-missed">
                    {he.rideStops.tight}
                  </span>
                ) : null}
              </span>
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
