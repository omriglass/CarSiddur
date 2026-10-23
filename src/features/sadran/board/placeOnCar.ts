// R14M1: the unplaced card's "שבץ ברכב…" picker (phone: dragging is impractical). The picker offers the cars a drop
// onto the car's lane at the request's own time would accept, and placing runs the board's drop handler unchanged.
// Pure: reuses the advisory drop validity (the server still decides on placement).
import { isoToDayMinutes } from "./geometry";
import { isUnmetDropValid, type BoardDropContext } from "./dropValidity";
import { requestStart } from "./phantomLanes";

import type { UnmetListItem } from "./components/UnmetList";

export interface PlaceableCar {
  carId: string;
  name: string;
}

/** Minute of the selected day the card's trip starts (where a drop at its own time would land); null off-day. */
export function placementMinutes(ctx: Pick<BoardDropContext, "selectedDay">, item: UnmetListItem): number | null {
  const start = requestStart(item.request);
  if (!start) return null;
  const minutes = isoToDayMinutes(start, ctx.selectedDay);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

/** Active cars the request can be dropped on at its own time, in car-name order. */
export function carsFreeForRequest(ctx: BoardDropContext, item: UnmetListItem): PlaceableCar[] {
  const minutes = placementMinutes(ctx, item);
  if (minutes == null) return [];
  return ctx.cars
    .filter((car) => car.status === "active" && isUnmetDropValid(ctx, item, car.id, minutes))
    .map((car) => ({ carId: car.id, name: car.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "he") || a.carId.localeCompare(b.carId));
}
