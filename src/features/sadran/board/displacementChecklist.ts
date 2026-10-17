// REQ item 136 (e), owner 2026-10-17: a displacement suggestion (`shiftWithinFlex` with `relocations`, SOLVER §3.10 /
// §3.16 `SUGGEST_SERIES_DISPLACE`) is shown as a guided checklist. Pure part: the steps and whether each is done,
// derived from the suggestion plus the board's current rides. No server step - the Sadran does each one by hand.
import { servedOf } from "@/features/rides/servedOf";

import type { Relocation, Suggestion, Window } from "@/solver";

import type { BoardRide } from "../api";

export type DisplacementSuggestion = Extract<Suggestion, { kind: "shiftWithinFlex" }>;
export type ChecklistRide = Pick<BoardRide, "id" | "car_id" | "status" | "served">;

export type ChecklistStep =
  | { key: string; kind: "unplace"; requestId: string; fromCarId: string; window: Window; rideIds: string[]; done: boolean }
  | { key: string; kind: "move"; requestId: string; fromCarId: string; toCarId: string; window: Window; rideIds: string[]; done: boolean }
  | { key: string; kind: "place"; requestId: string; carId: string; window: Window; rideIds: string[]; done: boolean };

/** A suggestion the board turns into a checklist (a plain `shiftWithinFlex` with nothing to relocate is not one). */
export function isDisplacementSuggestion(suggestion: Suggestion): suggestion is DisplacementSuggestion {
  return suggestion.kind === "shiftWithinFlex" && suggestion.relocations.length > 0;
}

/** The solver names a relocated ride `ride:<request id>` (`rideIdOf`); the board's rides carry that request in `served`. */
export function relocationRequestId(relocation: Pick<Relocation, "rideId">): string {
  return relocation.rideId.startsWith("ride:") ? relocation.rideId.slice(5) : relocation.rideId;
}

const live = (ride: ChecklistRide) => ride.status !== "cancelled";

/** Live rides of `carId` that serve `requestId`. */
export function ridesServing(rides: readonly ChecklistRide[], requestId: string, carId: string): (ChecklistRide & { id: string })[] {
  return rides.filter((ride): ride is ChecklistRide & { id: string } => !!ride.id && live(ride) && ride.car_id === carId && servedOf(ride as BoardRide).some((entry) => entry.request_id === requestId));
}

/**
 * Steps in the order the Sadran should do them: unplace, move, then the target placement. `targetRequestId` is the
 * suggestion's request (the series head for a multi-day trip). Done state:
 * - unplace: no live ride serving the request still sits on the old car;
 * - move: nothing left on the old car and a ride serves it on the new car;
 * - place: a live ride serves the target request on the suggested car.
 */
export function buildDisplacementSteps(suggestion: DisplacementSuggestion, rides: readonly ChecklistRide[], targetRequestId = suggestion.requestId): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  const sorted = [...suggestion.relocations].sort((a, b) => a.rideId.localeCompare(b.rideId));
  for (const relocation of sorted.filter((r) => r.toCarId === "")) {
    const requestId = relocationRequestId(relocation);
    const onOld = ridesServing(rides, requestId, relocation.fromCarId);
    steps.push({ key: `unplace:${relocation.rideId}`, kind: "unplace", requestId, fromCarId: relocation.fromCarId, window: relocation.window, rideIds: onOld.map((r) => r.id), done: onOld.length === 0 });
  }
  for (const relocation of sorted.filter((r) => r.toCarId !== "" && r.toCarId !== r.fromCarId)) {
    const requestId = relocationRequestId(relocation);
    const onOld = ridesServing(rides, requestId, relocation.fromCarId);
    const onNew = ridesServing(rides, requestId, relocation.toCarId);
    steps.push({ key: `move:${relocation.rideId}`, kind: "move", requestId, fromCarId: relocation.fromCarId, toCarId: relocation.toCarId, window: relocation.window, rideIds: (onOld.length ? onOld : onNew).map((r) => r.id), done: onOld.length === 0 && onNew.length > 0 });
  }
  const onTarget = ridesServing(rides, targetRequestId, suggestion.carId);
  steps.push({ key: `place:${targetRequestId}`, kind: "place", requestId: targetRequestId, carId: suggestion.carId, window: suggestion.window, rideIds: onTarget.map((r) => r.id), done: onTarget.length > 0 });
  return steps;
}

/** Board rides to highlight while the checklist is open: every step's ride that is still to be acted on or just was. */
export function checklistRideIds(steps: readonly ChecklistStep[]): Set<string> {
  return new Set(steps.flatMap((step) => step.rideIds));
}
