import type { PassengerCounts } from "@/components/PassengerStepper";
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
