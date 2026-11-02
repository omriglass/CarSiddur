// REQ §13.181 (b, c) (owner 2026-11-02): a הקפצה is one of "רק הקפצה" / "רק איסוף" / "הקפצה ואיסוף", and the origin and
// destination swap with one tap. "רק איסוף" is stored as the הקפצה it is — from the pickup place to the member's base
// place — so it is a form-only reading of the places. Pure helpers; `TripTypeFields` and the place swap button use them.
import type { UseFormReturn } from "react-hook-form";

import type { DestinationValue } from "@/components/DestinationCombobox";

import type { RequestFormValues } from "./schema";

export type DropOffMode = "drop" | "pickup" | "both";
export const DROP_OFF_MODES: readonly DropOffMode[] = ["drop", "pickup", "both"];

function isPlace(value: DestinationValue | undefined, placeId: string | null | undefined): boolean {
  return !!value && !!placeId && "presetId" in value && value.presetId === placeId;
}

/**
 * The הקפצה kind shown for these values: the explicit choice, else derived — a one-way הקפצה that ends at the
 * member's base place (`basePlaceId`: their default origin, else the department home) and starts elsewhere is a pickup.
 */
export function dropOffMode(
  values: Pick<RequestFormValues, "dropOffPickup" | "pickupOnly" | "origin" | "destination">,
  basePlaceId: string | null | undefined,
): DropOffMode {
  if (values.dropOffPickup) return "both";
  if (values.pickupOnly !== undefined) return values.pickupOnly ? "pickup" : "drop";
  return isPlace(values.destination, basePlaceId) && !isPlace(values.origin, basePlaceId) ? "pickup" : "drop";
}

/** Swaps origin and destination (the stops follow: the way out reversed becomes the way back, and back). */
export function swapRequestPlaces(form: UseFormReturn<RequestFormValues>): void {
  const values = form.getValues();
  const origin = values.origin;
  const destination = values.destination;
  form.setValue("origin", destination ?? { freeText: "" }, { shouldDirty: true, shouldValidate: true });
  form.setValue("destination", origin, { shouldDirty: true, shouldValidate: !!origin && !("freeText" in origin && !origin.freeText.trim()) });
  form.setValue("outStops", [...(values.returnStops ?? [])].reverse(), { shouldDirty: true });
  form.setValue("returnStops", [...(values.outStops ?? [])].reverse(), { shouldDirty: true });
}

/** Whether there is anything to swap: both places chosen. */
export function canSwapPlaces(values: Pick<RequestFormValues, "origin" | "destination">): boolean {
  const filled = (value: DestinationValue | undefined) => !!value && ("presetId" in value || !!value.freeText.trim());
  return filled(values.origin) && filled(values.destination);
}
