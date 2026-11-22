import { tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

/**
 * SOLVER.md §1.3a `chainBreaks()`: the warning on a ride whose car is elsewhere. R5U6: it names the ride (time + who) so it
 * reads away from its block. R22U5: on a Sadran car move - often one left behind after the trip it served changed - it
 * also says the move may be cancelled.
 */
export function chainBrokenWarningText(ride: { starts_at: string | null; pin_reason?: string | null }, riders: readonly (string | null | undefined)[], carPlace: string): string {
  const label = [ride.starts_at ? formatTime(new Date(ride.starts_at)) : "", ...riders.map((name) => name?.trim().split(/\s+/)[0] ?? "")]
    .filter(Boolean).join(" · ");
  return tv(ride.pin_reason === "CAR_MOVE" ? "sadranBoard.carMoveNotHereWarning" : "sadranBoard.carNotHereWarning", { ride: label, place: carPlace });
}
