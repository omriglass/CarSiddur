import type { DestinationValue } from "@/components/DestinationCombobox";
import type { PassengerCounts } from "@/components/passengerStepperBounds";
import type { TripShapeValue } from "@/components/TripShapeControl";

/** Count seats including the requester. Names do not silently replace unnamed passengers. */
export function coverNamedPassengers(counts: PassengerCounts, otherPeople: number): PassengerCounts {
  const missing = Math.max(0, otherPeople + 1 - counts.adults - counts.childSeats - counts.boosters);
  return { ...counts, adults: Math.min(8, counts.adults + missing) };
}
export function guestPassengerNames(text: string): string[] {
  return text.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}
/** A one-way passenger needs the driver's complete out-and-back vehicle window. */
export function quickVehicleWindow(shape: TripShapeValue, selectedMs: number, roundTripEndMs: number, travelMinutes: number, dwellMinutes: number): { startMs: number; endMs: number } {
  if (shape === "round_trip") return { startMs: selectedMs, endMs: roundTripEndMs };
  const durationMinutes = Math.max(15, Math.ceil((2 * Math.max(0, travelMinutes) + Math.max(0, dwellMinutes)) / 15) * 15);
  const durationMs = durationMinutes * 60_000;
  return shape === "one_way_to" ? { startMs: selectedMs, endMs: selectedMs + durationMs } : { startMs: Math.floor((selectedMs - durationMs) / (15 * 60_000)) * 15 * 60_000, endMs: selectedMs };
}

export interface QuickOriginAwayWindow {
  carId: string;
  awayFrom: string;
  awayUntil: string | null;
  locationId?: string;
  locationName?: string;
}

/**
 * REQ §13.93: the origin a quick request (empty-slot, UX_FLOWS.md §18) should default to —
 * where the chosen car actually is at the slot's start: an away window covering `atMs`, else
 * the car's `base_location_id`, else the department home. Pure — no React/Supabase.
 */
export function resolveQuickOrigin(input: {
  carId: string;
  atMs: number;
  awayWindows: readonly QuickOriginAwayWindow[];
  baseLocationId?: string | null;
  baseLocationName?: string;
  homeId: string;
  homeName: string;
}): DestinationValue {
  const away = input.awayWindows.find(
    (w) =>
      w.carId === input.carId &&
      Date.parse(w.awayFrom) <= input.atMs &&
      (w.awayUntil === null || input.atMs < Date.parse(w.awayUntil)),
  );
  if (away?.locationId) return { presetId: away.locationId, name: away.locationName ?? "" };
  if (input.baseLocationId) return { presetId: input.baseLocationId, name: input.baseLocationName ?? "" };
  return { presetId: input.homeId, name: input.homeName };
}
