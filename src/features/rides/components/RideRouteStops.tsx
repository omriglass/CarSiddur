// REQUIREMENTS §13.93 "Multi-stop rides" Display: the route-with-stops section shared by the
// Sadran `RideSheet` and the member `RideDetailSheet` (both already read `servedOf()`) —
// compact, one line per stop, estimated times via `formatTime`/`<span dir="ltr">`. Rendered
// only for served requests that actually declared stops; most rides render nothing at all.
import { he, t } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { parseRouteStops, type RouteStop } from "@/lib/routeStops";

import { entryCoversLeg, type ServedEntry } from "../servedOf";

function legStops(leg: "out" | "return", stops: readonly RouteStop[]) {
  const named = stops.filter((s) => s.leg === leg);
  if (!named.length) return null;
  return (
    <p>
      <span className="font-medium">{leg === "out" ? t("rideDetail.routeStopsOut") : t("rideDetail.routeStopsReturn")}</span>{" "}
      {named.map((stop, index) => (
        <span key={`${stop.leg}:${stop.position}`}>
          {index > 0 ? " · " : ""}
          {stop.name}
          {stop.eta ? (
            <>
              {" "}
              (<span dir="ltr">{formatTime(new Date(stop.eta))}</span>)
            </>
          ) : null}
        </span>
      ))}
    </p>
  );
}

export interface RideRouteStopsProps {
  served: readonly ServedEntry[];
}

export function RideRouteStops({ served }: RideRouteStopsProps) {
  const withStops = served.filter((entry) => entry.stops?.length);
  if (!withStops.length) return null;
  return (
    <div className="space-y-1">
      <span className="font-medium">{he.rideDetail.routeStopsTitle}</span>
      {withStops.map((entry) => {
        const stops = parseRouteStops(entry.stops);
        return (
          <div key={entry.request_id} className="space-y-0.5 text-xs text-muted-foreground">
            {entryCoversLeg(entry, "out") ? legStops("out", stops) : null}
            {entryCoversLeg(entry, "return") ? legStops("return", stops) : null}
          </div>
        );
      })}
    </div>
  );
}
