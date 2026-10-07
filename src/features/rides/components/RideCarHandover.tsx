import { useProfile } from "@/features/auth/useProfile";

import type { BoardRide } from "../api";
import { carHandoverNotes } from "../carHandover";
import { useCarNeighboursQuery } from "../hooks";
import { peopleOf } from "../ridePeople";
import { CarHandoverNotice } from "./CarHandoverNotice";

/**
 * The siddur ride sheet's "be back on time" note (REQ §13.108 f): only for the ride's driver / requesters
 * (`people` sources `driver` / `requester`), only when the gap to the neighbouring ride on the car is tight.
 */
export function RideCarHandover({ ride }: { ride: Pick<BoardRide, "id" | "people" | "starts_at" | "ends_at"> }) {
  const viewerId = useProfile().data?.id;
  const rideId = ride.id ?? undefined;
  const participants = peopleOf(ride)
    .filter((person) => (person.source === "driver" || person.source === "requester") && person.person_id)
    .map((person) => person.person_id as string);
  const isParticipant = !!viewerId && participants.includes(viewerId);
  const neighbours = useCarNeighboursQuery(isParticipant && rideId ? [rideId] : []);
  if (!isParticipant || !rideId || !ride.starts_at || !ride.ends_at) return null;
  const notes = carHandoverNotes(neighbours.data?.get(rideId), viewerId, participants);
  return <CarHandoverNotice notes={notes} ride={{ startsAt: ride.starts_at, endsAt: ride.ends_at }} />;
}
