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
  | { kind: "unplace"; name: string };
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
