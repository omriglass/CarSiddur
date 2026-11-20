/**
 * AI1 (docs/TODO.md "Ask in words"): our code's side of every turn — the model proposes, this checks and completes.
 * - The model never chooses between rides: it lists every ride the message could mean (`matching_rides`); a target is
 *   set only when exactly one fits, otherwise the app asks "which ride?".
 * - Arithmetic is ours: relative shifts and durations become times here, not in the model.
 * - Anything outside the context is dropped: a date not in the calendar, a place name not on the list, an unknown ride.
 * - A follow-up keeps the previous draft: what the new answer leaves empty is taken from it (the model is asked to
 *   return the whole draft, this makes sure).
 * - `flags` records what was dropped or decided here, for the conversation record (REQ item 258 f).
 * Pure (no Deno/Node APIs) so the evaluation runner scores exactly what the edge function will return.
 */
import type { AskContext } from "./askPrompt.ts";

export type AskIntent = "new_request" | "find_ride" | "edit_request" | "cancel_request" | "unclear";
export type AskQuestion = "which_ride" | "what_day" | "what_place" | "what_time";
export interface AskPlaceRef { text: string; list_name: string | null }

export interface AskModelAnswer {
  intent: AskIntent;
  matching_rides?: string[];
  date?: string | null;
  time_mode?: "depart" | "arrive_by" | null;
  time?: string | null;
  return_time?: string | null;
  trip_type?: "round_trip" | "one_way" | "drop_off" | null;
  destination?: AskPlaceRef | null;
  origin?: AskPlaceRef | null;
  stops?: { leg: "out" | "return"; text: string; list_name: string | null }[];
  people?: string[];
  remove_people?: string[];
  extra_adults?: number | null;
  needs?: ("large_trunk" | "tow_hitch")[];
  start_shift_minutes?: number | null;
  end_shift_minutes?: number | null;
  duration_minutes?: number | null;
  ask?: AskQuestion | null;
}

export interface AskDraft extends Omit<AskModelAnswer, "matching_rides"> {
  target_ride: string | null;
  /** The rides a "which ride?" question offers (empty unless asked). */
  ride_choices: string[];
  /** What our checks dropped or decided (date_dropped, place_unlisted, time_dropped, ride_unknown, ride_ambiguous, kept_previous, intent_kept). */
  flags: string[];
}

const SCALARS = ["date", "time_mode", "time", "return_time", "trip_type", "destination", "origin", "extra_adults"] as const;
const LISTS = ["people", "remove_people", "stops", "needs"] as const;

/** A follow-up answer completed from the previous draft (same intent; an "unclear" answer keeps the draft's intent). */
function withPrevious(answer: AskModelAnswer, previous: AskDraft | null | undefined, flags: string[]): AskModelAnswer {
  if (!previous || previous.intent === "unclear") return answer;
  const merged: AskModelAnswer = { ...answer };
  if (merged.intent === "unclear") { merged.intent = previous.intent; flags.push("intent_kept"); }
  if (merged.intent !== previous.intent) return merged;
  let kept = false;
  for (const key of SCALARS) {
    if ((merged[key] ?? null) === null && (previous[key] ?? null) !== null) {
      if (key === "return_time" && merged.trip_type === "one_way") continue;
      (merged as unknown as Record<string, unknown>)[key] = previous[key];
      kept = true;
    }
  }
  for (const key of LISTS) {
    if (!(merged[key]?.length) && previous[key]?.length) { (merged as unknown as Record<string, unknown>)[key] = previous[key]; kept = true; }
  }
  if (!(merged.matching_rides?.length) && previous.target_ride) { merged.matching_rides = [previous.target_ride]; kept = true; }
  if (kept) flags.push("kept_previous");
  return merged;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
}
function fromMinutes(total: number): string | null {
  if (total < 0 || total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
const validTime = (t: string | null | undefined) => (t && TIME_RE.test(t) ? t : null);

function checkPlace(ref: AskPlaceRef | null | undefined, names: Set<string>): AskPlaceRef | null {
  if (!ref || !(ref.text ?? "").trim()) return ref?.list_name && names.has(ref.list_name) ? { text: ref.list_name, list_name: ref.list_name } : null;
  return { text: ref.text.trim(), list_name: ref.list_name && names.has(ref.list_name) ? ref.list_name : null };
}

export function normalizeAnswer(modelAnswer: AskModelAnswer, context: AskContext, previous?: AskDraft | null): AskDraft {
  const flags: string[] = [];
  const answer = withPrevious(modelAnswer, previous, flags);
  const names = new Set(context.places.flatMap((p) => [p.name]));
  const dates = new Set(context.calendar.map((d) => d.date));
  const today = context.now.split("T")[0];
  const rides = new Map(context.my_rides.map((r) => [r.ref, r]));

  const { matching_rides: matching = [], ...rest } = answer;
  delete (rest as Partial<AskDraft>).target_ride;
  delete (rest as Partial<AskDraft>).ride_choices;
  delete (rest as Partial<AskDraft>).flags;
  if (answer.date && !dates.has(answer.date)) flags.push("date_dropped");
  if ((answer.time && !validTime(answer.time)) || (answer.return_time && !validTime(answer.return_time))) flags.push("time_dropped");
  const listed = [answer.destination, answer.origin, ...(answer.stops ?? [])];
  if (listed.some((p) => p?.list_name && !names.has(p.list_name))) flags.push("place_unlisted");
  const draft: AskDraft = {
    ...rest,
    date: answer.date && dates.has(answer.date) ? answer.date : null,
    time: validTime(answer.time),
    return_time: validTime(answer.return_time),
    destination: checkPlace(answer.destination, names),
    origin: checkPlace(answer.origin, names),
    stops: (answer.stops ?? []).filter((s) => (s.text ?? "").trim()).map((s) => ({ ...s, list_name: s.list_name && names.has(s.list_name) ? s.list_name : null })),
    people: answer.people ?? [],
    remove_people: answer.remove_people ?? [],
    needs: answer.needs ?? [],
    ask: answer.ask ?? null,
    target_ride: null,
    ride_choices: [],
    flags,
  };

  if (answer.intent === "edit_request" || answer.intent === "cancel_request") {
    const known = [...new Set(matching)].filter((ref) => rides.has(ref));
    if (known.length < new Set(matching).size) flags.push("ride_unknown");
    if (known.length > 1) flags.push("ride_ambiguous");
    if (known.length === 1) {
      draft.target_ride = known[0] ?? null;
      if (draft.ask === "which_ride") draft.ask = null;
    } else {
      draft.ride_choices = known.length > 1 ? known : context.my_rides.map((r) => r.ref);
      draft.ask = "which_ride";
    }
    const ride = draft.target_ride ? rides.get(draft.target_ride)! : null;
    if (ride && answer.intent === "edit_request") {
      if (!draft.time && answer.start_shift_minutes) draft.time = fromMinutes(toMinutes(ride.start) + answer.start_shift_minutes);
      if (!draft.return_time && answer.end_shift_minutes && ride.end) draft.return_time = fromMinutes(toMinutes(ride.end) + answer.end_shift_minutes);
      if (draft.ask === "what_time" && (draft.time || draft.return_time)) draft.ask = null;
    }
  }

  if (answer.intent === "find_ride" && !draft.date) draft.date = today;

  if (answer.intent === "new_request") {
    if (draft.time && !draft.return_time && answer.duration_minutes && answer.duration_minutes > 0 && draft.time_mode !== "arrive_by") {
      draft.return_time = fromMinutes(toMinutes(draft.time) + answer.duration_minutes);
    }
    // the model must not invent a day: an unchecked or missing date is asked for
    if (!draft.date) draft.ask = draft.ask ?? "what_day";
    else if (!draft.destination) draft.ask = draft.ask === "what_day" ? "what_place" : draft.ask ?? "what_place";
    else if (!draft.time) draft.ask = draft.ask ?? "what_time";
  }

  return draft;
}
