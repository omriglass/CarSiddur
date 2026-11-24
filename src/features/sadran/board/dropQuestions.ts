// REQ §13.161 (c): which question a board drop asks first. Pure decisions only (no React, no
// Supabase); the dialogs and the actions live in `hooks/useBoardDnd.ts`.

interface RideForQuestion {
  id?: string | null;
  car_id?: string | null;
  status?: string | null;
  driver_id?: string | null;
  needs_driver?: boolean | null;
}

/**
 * A ride WITH a driver dropped onto another ride asks "לאחד את הנסיעות?" (merge / just move / cancel).
 * Only when the drop lands on a live ride of the target car that could take a merge; a drop on empty space,
 * a planning shadow, a reservation (no request to merge) or a host that needs a driver stays a plain move
 * (a needs-driver ride dropped on a ride is always a merge attempt and has its own path).
 */
export function rideDropAsksMerge(input: {
  ride: RideForQuestion;
  host: RideForQuestion | undefined;
  droppedOnRideId: string | undefined;
  carId: string;
  draggedServesRequest: boolean;
  hostIsReservation: boolean;
  isPlanningChange: boolean;
}): boolean {
  const { ride, host, droppedOnRideId } = input;
  if (input.isPlanningChange || !droppedOnRideId || !host?.id) return false;
  if (droppedOnRideId === ride.id || host.id !== droppedOnRideId) return false;
  if (host.car_id !== input.carId || host.status === "cancelled") return false;
  if (ride.needs_driver || !input.draggedServesRequest) return false;
  if (input.hostIsReservation || host.needs_driver || !host.driver_id) return false;
  return true;
}

export type DropAnswer = "yes" | "alt" | "no";

export interface SplitOutcome {
  beforeStart: string;
  beforeEnd: string;
  /** The base ride's window once the guest is out, or `null` when it does not change. */
  afterStart: string | null;
  afterEnd: string | null;
}

/** The open question (REQ §13.161 c); `resolve` answers the promise the gesture handler awaits. */
export type DropAskSpec =
  | { kind: "merge"; guest: string; host: string; car: string }
  | { kind: "split"; guest: string; host: string; outcome: SplitOutcome | null }
  | { kind: "transfer"; guest: string; host: string; from: string; car: string }
  /** CM1 phase 4 (REQ item 260 d): the same person's ride next to the one just placed / moved chains with it. */
  | { kind: "chain"; route: string }
  | { kind: "unplace"; name: string; /** REQ §13.194: a reservation is deleted, not returned to the list. */ reservation?: boolean }
  /** Silent drops item 5 (owner 2026-11-24): the move takes a stop past its stated hour (REQ item 246) - asked, never refused. */
  | { kind: "stopHour"; stop: StopHourBreak };
export type DropAsk = DropAskSpec & { resolve: (answer: DropAnswer) => void };

/** A guest chip dropped on a ride other than its own asks to move it; anywhere else it asks to split. */
export function guestDropQuestion(input: { guestRideId: string; hostRideId: string | undefined; hostIsLiveRide: boolean }): "transfer" | "split" {
  return input.hostRideId && input.hostRideId !== input.guestRideId && input.hostIsLiveRide ? "transfer" : "split";
}

/**
 * The base ride's hours after the guest leaves. `unmerge_request` shrinks the ride back toward the base
 * request's own hours (never past them), so the estimate is the base request's times clamped inside the
 * ride's current window; the server does the real arithmetic.
 */
export function splitOutcome(ride: { starts_at: string; ends_at: string }, base: { depart_at?: string | null; return_at?: string | null } | undefined): SplitOutcome {
  const start = Date.parse(ride.starts_at);
  const end = Date.parse(ride.ends_at);
  const depart = base?.depart_at ? Date.parse(base.depart_at) : NaN;
  const back = base?.return_at ? Date.parse(base.return_at) : NaN;
  const afterStart = Number.isFinite(depart) && depart > start && depart < end ? depart : start;
  const afterEnd = Number.isFinite(back) && back < end && back > afterStart ? back : end;
  const changed = afterStart !== start || afterEnd !== end;
  return {
    beforeStart: ride.starts_at,
    beforeEnd: ride.ends_at,
    afterStart: changed ? new Date(afterStart).toISOString() : null,
    afterEnd: changed ? new Date(afterEnd).toISOString() : null,
  };
}

/** A stop's stated hour that a ride move breaks: whose, where, the hour and the estimate after the move. */
export interface StopHourBreak {
  name: string;
  place: string;
  anchor: "arrive" | "leave";
  /** The stated hour and the estimated one after the move (ISO). */
  at: string;
  newAt: string;
}

interface StatedStop {
  leg: "out" | "return";
  position: number;
  fixed_anchor?: "arrive" | "leave" | null;
  fixed_at?: string | null;
  flex_minutes?: number | null;
  place_text?: string | null;
  place?: { name: string } | null;
}

/**
 * Silent drops item 5: the first stated stop hour of the ride's own trip that a move from `before` to `after` takes
 * (further) past its flexibility, or null. A leg's places move with its end that the trip is timed from - the way
 * there with the start, the way back with the end - so a stop's estimate is its stated hour plus how far that end now
 * sits from the request's own time. An arrive-by only breaks when late; a leave-at either way. Only the ride's own trip
 * counts: a guest's stops are not on its route (they are asked about when merging, REQ item 267).
 */
export function movedPastStopHour(
  request: { requester_full_name?: string | null; depart_at?: string | null; return_at?: string | null; stops?: readonly StatedStop[] | null } | undefined,
  leg: "out" | "return" | "both" | null | undefined,
  before: { startsAt: string; endsAt: string },
  after: { startsAt: string; endsAt: string },
): StopHourBreak | null {
  if (!request?.stops?.length) return null;
  const legs = !leg || leg === "both" ? ["out", "return"] : [leg];
  const offset = (window: { startsAt: string; endsAt: string }, stopLeg: "out" | "return") => stopLeg === "out"
    ? (request.depart_at ? Date.parse(window.startsAt) - Date.parse(request.depart_at) : null)
    : (request.return_at ? Date.parse(window.endsAt) - Date.parse(request.return_at) : null);
  const stops = [...request.stops].sort((a, b) => a.leg.localeCompare(b.leg) || a.position - b.position);
  for (const stop of stops) {
    if (!stop.fixed_anchor || !stop.fixed_at || !legs.includes(stop.leg)) continue;
    if (stop.leg === "return" && !request.return_at) continue;   // REQ §13.97: a one-way request's return stops are dormant
    const was = offset(before, stop.leg);
    const now = offset(after, stop.leg);
    if (was == null || now == null) continue;
    const flexMs = Math.max(0, stop.flex_minutes ?? 0) * 60_000;
    const excess = (shift: number) => Math.max(0, (stop.fixed_anchor === "arrive" ? shift : Math.abs(shift)) - flexMs);
    if (excess(now) > excess(was)) {
      return {
        name: request.requester_full_name ?? "",
        place: stop.place?.name ?? stop.place_text ?? "",
        anchor: stop.fixed_anchor,
        at: stop.fixed_at,
        newAt: new Date(Date.parse(stop.fixed_at) + now).toISOString(),
      };
    }
  }
  return null;
}
