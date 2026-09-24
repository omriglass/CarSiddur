// "+ נוסעים" dialog (siddur `RideDetailSheet` / board `RideSheet`, REQ §13.85): picked
// members + named children + free-text guest names -> `add_ride_passengers()`'s
// `p_passengers` shape. Pure mapping, unit-tested in isolation from `AddPassengersDialog`,
// mirrors `features/sadran/board/reservationPeople.ts`'s `buildRidePassengerInputs` (the
// board reservation's *replace* editor) with one addition — a free-text guest-names field,
// same parser (`guestPassengerNames`) the request form already uses for its own guest field.

import { guestPassengerNames } from "@/features/requests/quickRequest";

import type { RidePassengerInput } from "./api";
import type { ChildOption } from "@/features/requests/api";

export interface PickedMember {
  id: string;
  name: string;
}

/** Resolves picked member/child ids plus free-text guest names into `add_ride_passengers()`'s `p_passengers` shape. */
export function buildAddPassengerInputs(
  memberIds: readonly string[],
  childIds: readonly string[],
  guestNamesText: string,
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
    ...guestPassengerNames(guestNamesText).map((name): RidePassengerInput => ({ display_name: name, seat_kind: "adult" })),
  ];
}
