// Pure display-name helpers for reason texts (docs/SOLVER.md §3.13a).
// A reason template var is never an id: names come from the input, else a
// free-text label from the request, else ''.
import type { Assignment, Car, Destination, Request, SolverInput } from './types';

type PlaceInput = Pick<SolverInput, 'destinations'>;

/** Display name of a place; falls back to `freeText` (a request's own label), never to the id. */
export function placeName(input: PlaceInput, id: string | undefined, freeText?: string): string {
  const named = id ? input.destinations[id]?.name : undefined;
  if (named) return named;
  return freeText ?? '';
}

/** Destination label of a request (place name, or its free-text destination). */
export function requestDestName(input: PlaceInput, request: Request): string {
  return placeName(input, request.destinationId, request.destinationText);
}

/** Origin label of a request (place name, or its free-text origin). */
export function requestOriginName(input: PlaceInput, request: Request, originId: string | undefined): string {
  return placeName(input, originId, request.originText);
}

/** Member display name from any request of that member; '' when unknown. */
export function memberName(input: Pick<SolverInput, 'requests'>, memberId: string | undefined): string {
  if (!memberId) return '';
  for (const r of input.requests) if (r.memberId === memberId && r.memberName) return r.memberName;
  return '';
}

export function carName(cars: Pick<Car, 'id' | 'name'>[], carId: string): string {
  return cars.find((c) => c.id === carId)?.name ?? '';
}

/** Merge host label: the host ride's driver name, else its car name, else ''. */
export function rideHostLabel(input: SolverInput, assignments: Assignment[], rideId: string): string {
  const ride = assignments.find((a) => a.rideId === rideId);
  if (!ride) return '';
  const fromMember = memberName(input, ride.driverMemberId);
  if (fromMember) return fromMember;
  const driverReq = ride.driverRequestId ? input.requests.find((r) => r.id === ride.driverRequestId) : undefined;
  return driverReq?.memberName ?? carName(input.cars, ride.carId);
}

export type { Destination };
