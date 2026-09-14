// Reservation dialog / RidePassengersEditor: picked people -> driver + `ride_passengers`
// rows (F3, docs/TODO.md, owner A5 2026-09-14; supabase/migrations/20260914120000_ride_passengers.sql).
// Pure mapping, unit-tested in isolation from the two React call sites (BoardScreen's
// reservation-creation dialog, RidePassengersEditor's existing-reservation editor).

import type { RidePassengerInput } from "../api";
import type { ChildOption } from "@/features/requests/api";

export interface PickedMember {
  id: string;
  name: string;
}

/**
 * The first person picked becomes the ride's driver (owner A5); everyone else picked is a
 * plain `ride_passengers` row. `driverId` is only ever set from a fresh pick list (a brand
 * new reservation) — editing an *existing* reservation's people (`RidePassengersEditor`)
 * never calls this, since its driver was already fixed at creation via `edit_ride`.
 */
export function splitReservationDriverAndPassengers(memberIds: readonly string[]): { driverId: string | null; passengerMemberIds: string[] } {
  const [driverId, ...passengerMemberIds] = memberIds;
  return { driverId: driverId ?? null, passengerMemberIds };
}

/** Resolves picked member/child ids into `set_ride_passengers()`'s `p_passengers` shape. */
export function buildRidePassengerInputs(
  memberIds: readonly string[],
  childIds: readonly string[],
  members: readonly PickedMember[],
  children: readonly ChildOption[],
): RidePassengerInput[] {
  return [
    ...memberIds.map((id): RidePassengerInput => ({
      person_id: id,
      display_name: members.find((m) => m.id === id)?.name ?? "",
      seat_kind: "adult",
    })),
    ...childIds.map((id): RidePassengerInput => {
      const child = children.find((c) => c.id === id);
      return { child_id: id, display_name: child?.name ?? "", seat_kind: child?.isAdultPassenger ? "adult" : "child_seat" };
    }),
  ];
}
