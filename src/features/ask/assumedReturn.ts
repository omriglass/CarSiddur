// REQ item 258 (c), owner 2026-11-20: the chat never asks "when are you back?". A round trip with no return said gets an
// estimated one — 3 hours after leaving, or for shopping the drive there + 1.5 hours + the drive back. The card marks
// it as an estimate and the member changes it in the chat or the form. Pure.
import type { AskDraft } from "./types";

export const ASSUMED_STAY_MINUTES = 180;
export const SHOPPING_STAY_MINUTES = 90;

const toMinutes = (time: string) => {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
};
const fromMinutes = (total: number) => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

/** Minutes of driving from home to a listed place, null when not known (free text, no route). */
export type TravelLookup = (listName: string) => number | null;

export function withAssumedReturn(draft: AskDraft, travel: TravelLookup): { draft: AskDraft; assumed: boolean } {
  const roundTrip = !draft.trip_type || draft.trip_type === "round_trip";
  if (draft.intent !== "new_request" || !roundTrip || draft.return_time || !draft.time || !draft.date || !draft.destination) {
    return { draft, assumed: false };
  }
  const minutes = draft.destination.list_name ? travel(draft.destination.list_name) : null;
  const at = toMinutes(draft.time);
  let back: number;
  if (draft.errand === "shopping" && minutes !== null) {
    const arrival = draft.time_mode === "arrive_by" ? at : at + minutes;
    back = arrival + SHOPPING_STAY_MINUTES + minutes;
  } else {
    const leave = draft.time_mode === "arrive_by" ? at - (minutes ?? 0) : at;
    back = leave + ASSUMED_STAY_MINUTES;
  }
  back = Math.min(Math.ceil(back / 15) * 15, 24 * 60 - 15);
  if (back <= at) return { draft, assumed: false };
  return { draft: { ...draft, return_time: fromMinutes(back) }, assumed: true };
}
