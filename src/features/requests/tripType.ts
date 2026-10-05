import type { TripType } from "@/lib/enums";
import type { OneWayCarMode, RequestTripShape } from "./schema";

/**
 * Pure mapping between the member-facing `tripType` (REQ §13.93: הלוך-חזור / הלוך בלבד / הקפצה)
 * and the legacy `tripShape`/`needsCarAtDestination`/`oneWayCarMode` columns the rest of the
 * request form (validation, duplicate detection, quick-window math, time-field visibility) and
 * `submit_request` still key off — mirrors `ORIGINS_PLAN_2026-10.md` §1's table exactly, and
 * `submit_request`'s own `v_trip_type_in` branch (`20261004100600_submit_request_origin_trip_
 * type.sql`), so the client and the RPC always derive the same legacy fields. The new three-
 * option `TripTypeControl` is the only writer of `tripType`/`dropOffPickup`; everything else
 * keeps reading `tripShape`/`needsCarAtDestination` exactly as before.
 */
export interface TripTypeLegacyFields {
  tripShape: RequestTripShape;
  needsCarAtDestination: boolean;
  oneWayCarMode: OneWayCarMode | undefined;
}

/**
 * `dropOffPickup` only matters for `"drop_off"` — a drop-off "with pickup" is a round trip that
 * does not need the car kept at the destination (the solver/Sadran may serve each leg
 * separately); "no pickup" is a plain one-way-to leg. `oneWayCarMode` is left `undefined` for
 * every case the server decides itself (REQ §88) — `"one_way"` is the one trip type a member
 * only ever picks while able to drive (`canUseDrivingTripTypes`), so it is always `relay`.
 */
export function tripTypeToLegacyFields(tripType: TripType, dropOffPickup: boolean): TripTypeLegacyFields {
  switch (tripType) {
    case "round_trip":
      return { tripShape: "round_trip", needsCarAtDestination: true, oneWayCarMode: undefined };
    case "one_way":
      return { tripShape: "one_way_to", needsCarAtDestination: true, oneWayCarMode: "relay" };
    case "drop_off":
      return dropOffPickup
        ? { tripShape: "round_trip", needsCarAtDestination: false, oneWayCarMode: undefined }
        : { tripShape: "one_way_to", needsCarAtDestination: false, oneWayCarMode: undefined };
  }
}

export interface InitialTripType {
  tripType: TripType;
  dropOffPickup: boolean;
}

/**
 * The trip-type control's initial selection for an existing request/template row. Prefers the
 * row's own `tripType` column (present on every row since the 2026-10-04 backfill); falls back
 * to the pre-migration shape-based derivation only for rows/fixtures that never carried it
 * (mirrors the SQL backfill's own rule, `20261004100200_requests_origin_and_trip_type.sql`).
 * A legacy `one_way_from` row (never produced by new submissions) is shown as a plain drop-off
 * with no pickup leg until the member actively changes the selection — `tripShape` on the form
 * stays whatever `mapEditRowToValues` loaded until then, so nothing about the stored request
 * changes just by opening the edit form.
 */
export function initialTripType(row: {
  tripType?: TripType | null;
  tripShape: RequestTripShape;
  needsCarAtDestination: boolean;
}): InitialTripType {
  if (row.tripType) {
    return { tripType: row.tripType, dropOffPickup: row.tripType === "drop_off" && row.tripShape === "round_trip" };
  }
  if (row.tripShape === "round_trip") {
    return row.needsCarAtDestination
      ? { tripType: "round_trip", dropOffPickup: false }
      : { tripType: "drop_off", dropOffPickup: true };
  }
  return { tripType: row.tripShape === "one_way_to" ? "one_way" : "drop_off", dropOffPickup: false };
}

/**
 * A non-driver (`profiles.does_not_drive`) may only file a drop-off unless a named companion
 * who *can* drive is also on the request (REQ §13.88/§13.93 — mirrors `submit_request`'s own
 * `non_driver_needs_drop_off` guard, step O3). `true` for a driving member (the ordinary case)
 * and for anyone with no `does_not_drive` flag loaded yet.
 */
export function canUseDrivingTripTypes(requesterDoesNotDrive: boolean, companionIds: readonly string[], companionDoesNotDriveById: ReadonlyMap<string, boolean>): boolean {
  if (!requesterDoesNotDrive) return true;
  return companionIds.some((id) => companionDoesNotDriveById.get(id) === false);
}
