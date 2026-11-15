// FC1 (REQ item 231): the preview requests for the ride sheet's cancel / remove-me confirmations — exactly the calls
// those buttons then send (`cancelRide` in features/requests/api.ts, `removeRidePerson` in ./api.ts).
import type { BoardRide, FreedCarPreviewRequest } from "./api";

/** Only a published ride can free a car someone is waiting for (an unpublished day is still being planned). */
function previewable(ride: BoardRide | null | undefined): ride is BoardRide & { id: string; version: number } {
  return !!ride?.id && ride.version != null && ride.status !== "draft" && ride.status !== "cancelled";
}

export function cancelRidePreview(ride: BoardRide | null | undefined, asEditor: boolean): FreedCarPreviewRequest | null {
  if (!previewable(ride)) return null;
  return {
    action: asEditor ? "ride_editor_cancel_ride" : "cancel_ride",
    args: { p_ride_id: ride.id, p_reason: "CANCELLED_BY_MEMBER", p_expected_version: ride.version },
  };
}

export function removeMePreview(ride: BoardRide | null | undefined, key: string | null | undefined): FreedCarPreviewRequest | null {
  if (!previewable(ride) || !key) return null;
  return { action: "remove_ride_person", args: { p_ride_id: ride.id, p_expected_version: ride.version, p_key: key } };
}

/**
 * A ride move / resize (`edit_ride`). Tried as already agreed with the others on it: the "דיברת עם X?" question comes
 * after this one, and the preview must not stop at it.
 */
export function editRidePreview(input: object, expectedVersion: number): FreedCarPreviewRequest {
  return { action: "edit_ride", args: { p_ride: { ...input, agreed: true }, p_expected_version: expectedVersion } };
}
