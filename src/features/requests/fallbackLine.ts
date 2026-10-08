// REQ §13.112 (a)/(b): the text of the "אם אין רכב" line wherever it is only read — the form's stage-2 recap and
// `/my` (a request waiting for a car shows its plan B, a request served by it says so and keeps its original line).
// Pure (no React); copy comes from `he.planB`. Times are Asia/Jerusalem `HH:mm` (`formatTime`).
import { z } from "zod";

import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { tripTypeSchema, type RequestFallbackValue, type TripType } from "@/lib/enums";
import { formatTime } from "@/lib/time";

import type { StoredAlternative } from "./planB";

const time = (instant: string) => formatTime(new Date(instant));

function altPlaceName(alt: Pick<StoredAlternative, "dropPlaceName" | "dropPlaceText">): string {
  return alt.dropPlaceName ?? alt.dropPlaceText ?? "";
}

/** The pickup place's name when it is not the drop place; `null` = from the drop place. */
function pickupPlaceName(alt: Pick<StoredAlternative, "pickupPlaceId" | "pickupPlaceText" | "pickupPlaceName">): string | null {
  return alt.pickupPlaceId || alt.pickupPlaceText ? (alt.pickupPlaceName ?? alt.pickupPlaceText ?? null) : null;
}

/** Statuses in which a request is still looking for a car, so its plan B is worth showing (`/my`). */
const WAITING_STATUSES: readonly string[] = ["submitted", "proposed", "waitlisted", "denied", "external"];

/**
 * "תוכנית ב׳: הקפצה ל<place> עד 08:00 · איסוף ב־19:00" / "אם אין רכב: אסתדר" for a request that still waits for a
 * car; `null` otherwise (no fallback, already served by its plan B or by a car, withdrawn…).
 */
export function waitingFallbackLine(row: { status: string; fallback?: RequestFallbackValue | null; servedByAlternative?: boolean; alternative?: StoredAlternative | null }): string | null {
  if (row.servedByAlternative || !WAITING_STATUSES.includes(row.status)) return null;
  if (row.fallback === "manage") return he.planB.myLineManage;
  if (row.fallback !== "alternative" || !row.alternative) return null;
  const alt = row.alternative;
  const vars = { place: altPlaceName(alt), arrive: time(alt.arriveBy), pickup: alt.pickupAt ? time(alt.pickupAt) : "", pickupPlace: pickupPlaceName(alt) ?? "" };
  if (!(alt.pickup && alt.pickupAt)) return tv("planB.myLineNoPickup", vars);
  return tv(vars.pickupPlace ? "planB.myLinePickupFrom" : "planB.myLine", vars);
}

/** "שובצת בתוכנית ב׳: הקפצה ל<place> עד 08:00, איסוף מ<place> 19:00". */
export function servedByAlternativeLine(alt: StoredAlternative): string {
  const vars = { place: altPlaceName(alt), arrive: time(alt.arriveBy), pickup: alt.pickupAt ? time(alt.pickupAt) : "", pickupPlace: pickupPlaceName(alt) ?? altPlaceName(alt) };
  return alt.pickup && alt.pickupAt ? tv("planB.served", vars) : tv("planB.servedNoPickup", vars);
}

/** The replaced main trip kept in `request_alternatives.original_main` (only the fields the line needs). */
const originalMainSchema = z.object({
  trip_type: tripTypeSchema,
  destination_id: z.string().nullish(),
  destination_text: z.string().nullish(),
  depart_at: z.string().nullish(),
  return_at: z.string().nullish(),
  kept_return_at: z.string().nullish(),
});

export interface OriginalMainContext {
  /** Resolves a destination id (the department's places) to its name. */
  destinationName: (id: string) => string | undefined;
}

/** "הבקשה המקורית: הלוך-חזור לחיפה ד׳ 14.10 08:00–19:00" — `null` when `original_main` is missing or unreadable. */
export function originalRequestLine(originalMain: unknown, context: OriginalMainContext): string | null {
  const parsed = originalMainSchema.safeParse(originalMain);
  if (!parsed.success) return null;
  const main = parsed.data;
  const destination = (main.destination_id ? context.destinationName(main.destination_id) : undefined) ?? main.destination_text ?? "";
  const tripLabel: Record<TripType, string> = {
    round_trip: he.request.tripTypeRoundTrip,
    one_way: he.request.tripTypeOneWay,
    drop_off: he.request.tripTypeDropOff,
  };
  const dayInstant = main.depart_at ?? main.return_at;
  const ret = main.return_at ?? main.kept_return_at;
  const times = [main.depart_at ? time(main.depart_at) : null, main.trip_type === "round_trip" && ret ? time(ret) : null].filter(Boolean).join("–");
  return tv("planB.original", {
    route: tv("planB.originalRoute", { trip: tripLabel[main.trip_type], destination }),
    day: dayInstant ? formatDayDate(dayInstant) : "",
    times,
  }).replace(/\s+/g, " ").trim();
}

/** The form's stage-2 recap line ("אם אין רכב: הקפצה ל… עד … ואיסוף משם ב־…" / "אם אין רכב: אסתדר"); `null` for no line. */
export function planBRecapLine(
  values: { fallback?: RequestFallbackValue; altArriveBy?: string; altPickup?: boolean; altPickupAt?: string },
  placeLabel: string,
  /** The pickup place's name when it differs from the drop place; empty = from the drop place. */
  pickupPlaceLabel = "",
): string | null {
  if (values.fallback === "manage") return he.planB.recapManage;
  if (values.fallback !== "alternative") return null;
  const vars = { place: placeLabel, arrive: values.altArriveBy ?? "", pickup: values.altPickupAt ?? "", pickupPlace: pickupPlaceLabel };
  if (!(values.altPickup && values.altPickupAt)) return tv("planB.recapNoPickup", vars);
  return tv(pickupPlaceLabel ? "planB.recapPickupFrom" : "planB.recap", vars);
}
