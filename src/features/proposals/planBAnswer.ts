// REQ §13.112 (a), R11M3: the lines a plan-B proposal shows on `/p/:token` and in the signed-in answer screen — the Sadran's chosen
// car, when it leaves (and from where) and arrives, the pickup (place, time, car — "רכב אחר לאיסוף" when it is another car) and a
// closing line that accepting replaces the member's original request. Pure; names come from the edge function's summary.
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { ProposalAlternativeSummary, ProposalRequestSummary } from "./api";

export interface PlanBLines {
  car: string | null;
  leave: string | null;
  pickup: string | null;
  otherCar: string | null;
  back: string | null;
  replaces: string | null;
}

function tripTypeText(tripType: string | null | undefined): string {
  switch (tripType) {
    case "one_way": return he.request.tripTypeOneWay;
    case "drop_off": return he.request.tripTypeDropOff;
    case "round_trip": return he.request.tripTypeRoundTrip;
    default: return "";
  }
}

export function planBLines(alt: ProposalAlternativeSummary, request: ProposalRequestSummary | null | undefined): PlanBLines {
  const time = (iso: string) => formatTime(new Date(iso));
  const leaveVars = { depart: alt.departAt ? time(alt.departAt) : "", origin: alt.originName ?? "", place: alt.dropPlace, arrive: time(alt.arriveBy) };
  const leave = alt.departAt ? tv(alt.originName ? "proposalScreen.planB.leave" : "proposalScreen.planB.leaveNoOrigin", leaveVars) : null;
  const pickupCar = alt.pickupAt && alt.pickupCarName ? tv("proposalScreen.planB.pickupCar", { car: alt.pickupCarName }) : "";
  const pickupLine = alt.pickupAt
    ? tv(alt.pickupPlace ? "proposalScreen.planB.pickupFrom" : "proposalScreen.planB.pickup", { pickup: time(alt.pickupAt), pickupPlace: alt.pickupPlace ?? "" })
    : null;
  const original = request && request.departAt
    ? tv("proposalScreen.planB.originalTrip", {
      trip: tripTypeText(request.tripType), place: request.destination ?? "",
      times: `${time(request.departAt)}${request.returnAt ? `–${time(request.returnAt)}` : ""}`,
    }).replace(/\s+/g, " ").trim()
    : null;
  return {
    car: alt.carName ? tv("proposalScreen.planB.car", { car: alt.carName }) : null,
    leave,
    pickup: pickupLine ? `${pickupLine}${pickupCar ? ` ${pickupCar}` : ""}` : null,
    otherCar: alt.pickupAt && alt.carName && alt.pickupCarName && alt.pickupCarName !== alt.carName ? he.proposalScreen.planB.otherCar : null,
    back: alt.pickupAt && alt.returnAt ? tv("proposalScreen.planB.back", { back: time(alt.returnAt) }) : null,
    replaces: original ? tv("proposalScreen.planB.replaces", { original }) : null,
  };
}
