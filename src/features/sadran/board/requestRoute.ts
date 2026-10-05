// G6 (docs/TODO.md, REQ §13.93 "Display"): what the Sadran reads on every request/ride surface of
// the board — "מ<origin> ל<destination>" (origin only when it is not the department home, a
// free-text origin always) plus the trip type (הלוך-חזור / הלוך בלבד / הקפצה).
import { he } from "@/i18n/he";
import type { TripType } from "@/lib/enums";
import { routeLabel } from "@/lib/routeLabel";

export function tripTypeLabel(tripType: TripType | null | undefined): string {
  switch (tripType) {
    case "one_way":
      return he.request.tripTypeOneWay;
    case "drop_off":
      return he.request.tripTypeDropOff;
    case "round_trip":
      return he.request.tripTypeRoundTrip;
    default:
      return "";
  }
}

export interface RequestRouteInput {
  originId?: string | null;
  originName?: string | null;
  originText?: string | null;
  destination: string;
  tripType?: TripType | null;
  stops?: readonly string[];
}

/** "מ<origin> ל<destination> · <trip type>" (the trip-type part is omitted when unknown). */
export function requestRouteLine(input: RequestRouteInput, homeDestinationId: string | null | undefined): string {
  const origin = input.originName ?? input.originText ?? "";
  const originIsHome = !!input.originId && !!homeDestinationId && input.originId === homeDestinationId;
  const route = routeLabel({ destination: input.destination, origin, originIsHome: originIsHome || !origin, stops: input.stops });
  const type = tripTypeLabel(input.tripType);
  return type ? `${route} · ${type}` : route;
}
