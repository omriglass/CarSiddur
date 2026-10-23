import { he } from "@/i18n/he";
import type { BoardRide } from "./api";

/**
 * A round trip's extra explanatory line ("הרכב נשאר איתי ביעד" / chauffeur). A one-way/relay/
 * drop_off leg (`origin_id !== destination_id`) no longer gets a second, possibly-conflicting
 * line here — REQUIREMENTS §13.93's precise driver-label wording (`src/lib/rideLabel.ts`'s
 * "הרכב נשאר שם" / "משאיר/ה את הרכב ב…" / "הרכב מחכה ב…") already lives in `headerLabel` above.
 */
export function carModeLabel(ride: BoardRide, viewerId: string | undefined): string {
  if (ride.origin_id === ride.destination_id) {
    if (ride.is_chauffeur) return he.rideDetail.carModeChauffeur;
    // R13U6: "the car stays with me" is the driver's sentence — a passenger (e.g. one dropped off on the way) is told nothing here.
    return viewerId && ride.driver_id === viewerId ? he.rideDetail.carModeKeep : "";
  }
  return "";
}
