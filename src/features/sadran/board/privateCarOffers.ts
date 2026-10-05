// REQ §13.99 (QB20/P1): the board never offers a private (temporary) car to anyone but its owner.
// The pure solver preview may still propose one; this strips those suggestions before the unmet
// list shows them. No React, no Supabase.
import type { Suggestion, SolverOutput } from "@/solver";

interface CarLike { id: string; type: string; owner_id: string | null }
interface RideLike { id: string | null; car_id: string | null }
interface RequestLike { id: string; requester_id: string }

export function suggestionCarIds(suggestion: Suggestion, rides: readonly RideLike[]): string[] {
  const hostCar = (hostRideId?: string) => (hostRideId ? rides.find((ride) => ride.id === hostRideId)?.car_id ?? null : null);
  const ids: (string | null | undefined)[] = [];
  switch (suggestion.kind) {
    case "merge": ids.push(hostCar(suggestion.hostRideId)); break;
    case "splitLegs":
      ids.push(suggestion.outbound.carId, hostCar(suggestion.outbound.hostRideId), suggestion.return.carId, hostCar(suggestion.return.hostRideId));
      break;
    case "shiftWithinFlex": case "shiftBeyondFlex": case "convertToRoundTrip": case "chauffeur": case "changeOrigin":
      ids.push(suggestion.carId); break;
    default: break;
  }
  return ids.filter((id): id is string => !!id);
}

export function withoutPrivateCarOffers(output: SolverOutput, cars: readonly CarLike[], rides: readonly RideLike[], requests: readonly RequestLike[]): SolverOutput {
  const privateCars = new Map(cars.filter((car) => car.type === "temporary").map((car) => [car.id, car.owner_id]));
  if (privateCars.size === 0) return output;
  const requesterOf = new Map(requests.map((request) => [request.id, request.requester_id]));
  return {
    ...output,
    unmet: output.unmet.map((unmet) => ({
      ...unmet,
      suggestions: unmet.suggestions.filter((suggestion) => suggestionCarIds(suggestion, rides)
        .every((carId) => !privateCars.has(carId) || privateCars.get(carId) === requesterOf.get(suggestion.requestId))),
    })),
  };
}
