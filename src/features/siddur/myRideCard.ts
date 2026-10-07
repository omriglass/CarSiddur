import type { RideCardData } from "@/components/RideCard";
import type { MyRequestRow } from "@/features/requests/api";
import { chauffeurRideLabel } from "@/lib/rideLabel";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { tv } from "@/i18n/he";
import { carHandoverNotes, type CarNeighbours } from "@/features/rides/carHandover";
import { servedOf } from "@/features/rides/servedOf";
import { peopleOf } from "@/features/rides/ridePeople";
import type { BoardRide } from "./api";

export function myRideCard(
  ride: BoardRide & { car_name: string | null; car_type?: "shared" | "temporary" | null },
  requests: readonly MyRequestRow[],
  rideTypes: readonly { code: string; name_he: string }[],
  /** REQ §13.108 f: the signed-in member and this ride's neighbours on its car — enables the "be back on time" note. */
  handover?: { viewerId: string | undefined; neighbours: CarNeighbours | undefined },
): RideCardData | null {
  if (!ride.id || !ride.starts_at) return null;
  const served = servedOf(ride);
  const ownEntry = served.find((entry) => entry.role === "driver" && requests.some((request) => request.id === entry.request_id))
    ?? served.find((entry) => requests.some((request) => request.id === entry.request_id));
  const ownRequest = requests.find((request) => request.id === ownEntry?.request_id);
  const passengers = served.filter((entry) => entry.role === "passenger");
  const chauffeur = !!ride.is_chauffeur || !!ride.needs_driver || (!served.some((entry) => entry.role === "driver") && passengers.length > 0);
  const destination = ownEntry?.destination ?? served[0]?.destination ?? ride.destination_name ?? "";
  const purposes = [...new Set(served.flatMap((entry) => {
    const name = rideTypes.find((type) => type.code === entry.ride_type)?.name_he;
    return name ? [name] : [];
  }))];
  const seen = new Set<string>();
  const joining = passengers.filter((entry) => {
    const key = `${entry.request_id}:${entry.leg}`;
    if (entry.request_id === ownEntry?.request_id || !entry.requester || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((entry) => tv(entry.leg === "return" ? "home.joiningFrom" : "home.joiningTo", {
    name: entry.requester!, destination: entry.destination ?? "",
  }));
  // The viewer drives it or requested it (their own request is among its served entries).
  const viewerId = handover?.viewerId;
  const participates = !!viewerId && (ride.driver_id === viewerId || !!ownEntry);
  const handoverNotes = participates ? carHandoverNotes(handover?.neighbours, viewerId, [viewerId]) : undefined;
  return {
    handover: handoverNotes,
    id: ride.id, startsAt: ride.starts_at, endsAt: ride.ends_at,
    originName: ride.origin_name ?? "", destinationName: destination,
    label: chauffeur ? chauffeurRideLabel(ride.needs_driver ? null : ride.driver_name, passengers, ride.starts_at, ride.origin_id ?? undefined,
      { from: ride.origin_name ?? "", to: ride.destination_name ?? "" })
      : tv(ownEntry?.leg === "return" ? "home.rideFrom" : "home.rideTo", { destination }),
    showDay: true,
    purpose: ownRequest?.rideTypeName || purposes.join(" / ") || rideTypes.find((type) => type.code === "other")?.name_he,
    joining,
    description: [ride.notes, ridePublicDetails(served, {
      addedNames: peopleOf(ride).filter((person) => person.source === "added").map((person) => person.display_name),
    })].filter(Boolean).join("\n"),
    driverName: ride.driver_name, carName: ride.car_name, carId: ride.car_id, carType: ride.car_type ?? undefined,
    isChauffeur: chauffeur, needsDriver: !!ride.needs_driver, isMine: true,
    rideTypeCode: ownRequest?.rideTypeCode ?? served[0]?.ride_type,
    seriesIndex: ride.series_index, seriesCount: ride.series_count,
  };
}
