import type { TranslationKey } from "@/i18n/he";
import type { TripShape } from "@/lib/enums";

/**
 * Label key for the request form's destination field. A "חזור בלבד" (`one_way_from`)
 * request only has a return leg, so the place being asked for is where the member is
 * coming *from*, not where they are going (owner bug report 2026-09-14; UX_FLOWS.md §3.4).
 * Form copy only — the stored field is still the request's destination.
 */
export function destinationLabelKey(tripShape: TripShape | null | undefined): TranslationKey {
  return tripShape === "one_way_from" ? "field.destinationFrom" : "field.destination";
}
