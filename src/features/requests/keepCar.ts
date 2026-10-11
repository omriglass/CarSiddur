// REQ §13.126 (g): "הרכב זמין לשימוש ביעד". To the member a driver's round trip that leaves the car at the
// destination is still a הלוך-חזור (never "הקפצה") with a short note; the server stores it as a two-way הקפצה
// (`trip_type = 'drop_off'`, `keep_car_at_destination = true`). Pure helpers, shared by the form, /my and the board.
import { he, tv } from "@/i18n/he";
import type { TripType } from "@/lib/enums";

import type { RequestFormValues } from "./schema";

type KeepScope = Pick<RequestFormValues, "tripType" | "day"> & { returnDay?: string };

/** The link exists only for a driver's single-day הלוך-חזור (the caller also hides it in time-window mode). */
export function keepCarOffered(values: KeepScope, canDrive: boolean): boolean {
  return canDrive && values.tripType === "round_trip" && (!values.returnDay || values.returnDay === values.day);
}

/** Whether the submit sends `keep_car_at_destination`: the flag, still a single-day round trip, not a time window. */
export function keepCarActive(values: KeepScope & Pick<RequestFormValues, "tripShape"> & { keepCarAtDestination?: boolean; timeMode?: RequestFormValues["timeMode"] }): boolean {
  return !!values.keepCarAtDestination
    && values.tripType === "round_trip"
    && values.tripShape === "round_trip"
    && (!values.returnDay || values.returnDay === values.day)
    && values.timeMode !== "window";
}

/** A stored row (`trip_type = 'drop_off'` + the flag) is shown and edited as a round trip with the flag on. */
export function isKeepCarRow(row: { tripType?: TripType | null; keepCarAtDestination?: boolean | null }): boolean {
  return row.tripType === "drop_off" && !!row.keepCarAtDestination;
}

/** "הרכב נשאר ב<destination>" (a generic note while the destination is unknown). */
export function keepCarNote(destination: string | null | undefined): string {
  const place = destination?.trim();
  return place ? tv("keepCar.note", { place }) : he.keepCar.noteNoPlace;
}

/** "הלוך-חזור · הרכב נשאר ב<destination>". */
export function keepCarTripLabel(destination: string | null | undefined): string {
  return `${he.request.tripTypeRoundTrip} · ${keepCarNote(destination)}`;
}
