// REQ §13.112 (a), R11M1: the plan-B composer shows the car(s) and times the solver chose and lets the Sadran change
// each car. Pure helpers: the time window each car must be free for, and the cars offered for it. The server re-checks
// everything on create / send / apply (`_validate_alternative_payload`, `proposal_car_conflicts`); this is a pre-filter.

export interface AltPlanTimes {
  /** The instant the car leaves with the member (the proposal's `depart_at`). */
  departAt: string;
  /** The member's drop-off arrival (`request_alternatives.arrive_by`). */
  arriveBy: string;
  /** The pickup instant, when the plan B has a pickup. */
  pickupAt: string | null;
  /** The proposal's `return_at` (the member is back at the origin), only for a pickup from the drop-off place. */
  returnAt: string | null;
}

export interface TimeWindow { startMs: number; endMs: number }

/** The drive one way, as the solver planned it (departure → arrival); at least 15 minutes. */
function driveMs(times: AltPlanTimes): number {
  return Math.max(15 * 60_000, Date.parse(times.arriveBy) - Date.parse(times.departAt));
}

/** The car's busy time for each leg: the drop-off ride leaves at `departAt` and is back after the same drive; a pickup ride is the mirror image. */
export function alternativeLegWindows(times: AltPlanTimes): { out: TimeWindow; pickup: TimeWindow | null } {
  const drive = driveMs(times);
  const out = { startMs: Date.parse(times.departAt), endMs: Date.parse(times.arriveBy) + drive };
  if (!times.pickupAt) return { out, pickup: null };
  const pickupMs = Date.parse(times.pickupAt);
  const endMs = times.returnAt ? Date.parse(times.returnAt) : pickupMs + drive;
  return { out, pickup: { startMs: pickupMs - drive, endMs } };
}

export interface CarLike { id: string; name: string; status: string; type: string }
export interface RideLike { car_id: string | null; starts_at: string | null; ends_at: string | null; status: string | null }

/**
 * Active shared cars with no live ride overlapping `window`, by name; `keepId` (the car the solver or the Sadran already
 * holds) is always included. A temporary (private) car is offered only when it is already the chosen one.
 */
export function carsFreeForWindow<C extends CarLike>(cars: readonly C[], rides: readonly RideLike[], window: TimeWindow, keepId: string | null): C[] {
  const busy = new Set<string>();
  for (const ride of rides) {
    if (!ride.car_id || !ride.starts_at || !ride.ends_at || ride.status === "cancelled") continue;
    if (Date.parse(ride.starts_at) < window.endMs && Date.parse(ride.ends_at) > window.startMs) busy.add(ride.car_id);
  }
  return cars
    .filter((car) => car.id === keepId || (car.status === "active" && car.type !== "temporary" && !busy.has(car.id)))
    .sort((a, b) => a.name.localeCompare(b.name, "he") || a.id.localeCompare(b.id));
}

/** Unknown drive time for one leg (the app's default for an unknown route, ARCHITECTURE "unknown travel = 60 min"). */
const ONE_LEG_MS = 60 * 60_000;

/**
 * R5B3 / R6U1: the window a car must be free for to take a shift proposal — the whole new span, or for one leg (a
 * pickup card's `return`, an out-leg's `out`, or a request with only one time) that leg's hour. A pre-filter only: the
 * server places the request on the car on apply (`_shift_place_on_car`) and refuses what does not fit.
 */
export function shiftCarWindow(departAt: string | null, returnAt: string | null, leg: "out" | "return" | null): TimeWindow | null {
  if (leg === "return" || (!departAt && returnAt)) return returnAt ? { startMs: Date.parse(returnAt) - ONE_LEG_MS, endMs: Date.parse(returnAt) } : null;
  if (leg === "out" || (departAt && !returnAt)) return departAt ? { startMs: Date.parse(departAt), endMs: Date.parse(departAt) + ONE_LEG_MS } : null;
  return departAt && returnAt ? { startMs: Date.parse(departAt), endMs: Date.parse(returnAt) } : null;
}
