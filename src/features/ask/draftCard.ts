// REQ item 258 (c), UX_FLOWS §3.4b: the draft card's rows and the app's question, built by the app from the checked
// draft (never the model's prose). Pure; Hebrew from `he.ask.*`.
import { TRIP_TYPE_LABEL } from "@/features/waitlist/waitingLabels";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import type { AskDraft, AskQuestion, AskRide } from "./types";

export type CardQuestion = AskQuestion | "when_back";

export interface CardRow {
  key: "ride" | "when" | "where" | "time" | "back" | "who" | "stops" | "needs";
  label: string;
  /** null = a required detail still missing ("? חסר"). */
  value: string | null;
  /** The value before this change (edit card: the ride as it is). */
  old?: string;
  /** Changed by the last turn (highlighted). */
  changed: boolean;
}

const dayLabel = (date: string) => formatDayDate(`${date}T12:00:00+02:00`);
const placeName = (p: { text: string; list_name: string | null } | null | undefined) => (p ? p.list_name ?? p.text : null);
const join = (names: readonly string[]) => names.join(", ");

function whoValue(draft: AskDraft): string | null {
  const names = [...(draft.people ?? [])];
  if (draft.extra_adults && draft.extra_adults > 0) names.push(`+${draft.extra_adults}`);
  return names.length ? join([he.requestSentence.me, ...names]) : null;
}
function stopsValue(stops: AskDraft["stops"]): string | null {
  if (!stops?.length) return null;
  return join(stops.map((s) => (s.list_name ? s.list_name : `${s.text} ${he.ask.unlistedStop}`)));
}
function needsValue(needs: AskDraft["needs"]): string | null {
  if (!needs?.length) return null;
  return join(needs.map((n) => (n === "large_trunk" ? he.request.luggageChip : he.request.towChip)));
}
function timeValue(draft: AskDraft): string | null {
  if (!draft.time) return null;
  return draft.time_mode === "arrive_by" ? tv("ask.arriveBy", { time: draft.time }) : tv("ask.depart", { time: draft.time });
}
function hasReturnLeg(draft: AskDraft): boolean {
  return !draft.trip_type || draft.trip_type === "round_trip";
}

function newRows(draft: AskDraft): Omit<CardRow, "changed">[] {
  const where = placeName(draft.destination);
  const origin = placeName(draft.origin);
  const rows: Omit<CardRow, "changed">[] = [
    { key: "when", label: he.ask.row.when, value: draft.date ? dayLabel(draft.date) : null },
    {
      key: "where", label: he.ask.row.where,
      value: where ? [origin ? `${origin} → ${where}` : where, draft.trip_type ? TRIP_TYPE_LABEL[draft.trip_type] : null].filter(Boolean).join(" · ") : null,
    },
    { key: "time", label: he.ask.row.time, value: timeValue(draft) },
  ];
  if (hasReturnLeg(draft) || draft.return_time) rows.push({ key: "back", label: he.ask.row.back, value: draft.return_time ?? null });
  const who = whoValue(draft);
  if (who) rows.push({ key: "who", label: he.ask.row.who, value: who });
  const stops = stopsValue(draft.stops);
  if (stops) rows.push({ key: "stops", label: he.ask.row.stops, value: stops });
  const needs = needsValue(draft.needs);
  if (needs) rows.push({ key: "needs", label: he.ask.row.needs, value: needs });
  return rows;
}

/** One "which ride?" chip / the edit card's ride line: "א׳ 22.11 · 08:00–12:00 · חיפה". */
export function rideLabel(ride: AskRide): string {
  return tv("ask.rideChip", { day: dayLabel(ride.date), hours: ride.end ? `${ride.start}–${ride.end}` : ride.start, place: ride.destination });
}

function editRows(draft: AskDraft, ride: AskRide | undefined): Omit<CardRow, "changed">[] {
  const rows: Omit<CardRow, "changed">[] = [{ key: "ride", label: he.ask.row.ride, value: ride ? rideLabel(ride) : null }];
  if (draft.time) rows.push({ key: "time", label: he.ask.row.time, value: timeValue(draft), old: ride?.start });
  if (draft.return_time) rows.push({ key: "back", label: he.ask.row.back, value: draft.return_time, old: ride?.end ?? undefined });
  if (draft.trip_type && draft.trip_type !== ride?.trip_type) {
    rows.push({ key: "where", label: he.ask.row.where, value: TRIP_TYPE_LABEL[draft.trip_type], old: ride ? TRIP_TYPE_LABEL[ride.trip_type as keyof typeof TRIP_TYPE_LABEL] : undefined });
  }
  const stops = stopsValue(draft.stops);
  if (stops) rows.push({ key: "stops", label: he.ask.row.stops, value: `+ ${stops}` });
  const added = draft.people ?? [];
  const removed = draft.remove_people ?? [];
  if (added.length || removed.length) {
    rows.push({ key: "who", label: he.ask.row.who, value: [added.length ? `+ ${join(added)}` : "", removed.length ? `− ${join(removed)}` : ""].filter(Boolean).join(" ") });
  }
  const needs = needsValue(draft.needs);
  if (needs) rows.push({ key: "needs", label: he.ask.row.needs, value: `+ ${needs}` });
  return rows;
}

export interface DraftCard {
  kind: "new" | "edit";
  rows: CardRow[];
  question: CardQuestion | null;
  /** Ready for "אישור ← לטופס": nothing required is missing and no question is open. */
  complete: boolean;
  /** The one line on top of the prefilled form. */
  summary: string;
}

export function buildDraftCard(draft: AskDraft, previous: AskDraft | null, rides: readonly AskRide[]): DraftCard | null {
  const rideOf = (ref: string | null) => rides.find((r) => r.ref === ref);
  let kind: DraftCard["kind"];
  let rows: Omit<CardRow, "changed">[];
  let prevRows: Omit<CardRow, "changed">[] = [];
  if (draft.intent === "new_request") {
    kind = "new";
    rows = newRows(draft);
    if (previous?.intent === "new_request") prevRows = newRows(previous);
  } else if (draft.intent === "edit_request" && draft.target_ride) {
    kind = "edit";
    rows = editRows(draft, rideOf(draft.target_ride));
    if (previous?.intent === "edit_request" && previous.target_ride === draft.target_ride) prevRows = editRows(previous, rideOf(previous.target_ride));
  } else {
    return null;
  }
  const before = new Map(prevRows.map((r) => [r.key, r.value]));
  const withChanges: CardRow[] = rows.map((r) => ({ ...r, changed: !!previous && r.value !== null && before.get(r.key) !== r.value }));

  let question: CardQuestion | null = draft.ask ?? null;
  if (!question && kind === "new" && draft.date && draft.destination && draft.time && hasReturnLeg(draft) && !draft.return_time) question = "when_back";
  const missing = withChanges.some((r) => r.value === null && r.key !== "back");
  const complete = !question && !missing;
  const summary = withChanges.filter((r) => r.value !== null && r.key !== "ride").map((r) => r.value).join(" · ");
  return { kind, rows: withChanges, question, complete, summary };
}

/** The "which ride?" chips (the model never picks between them). */
export function rideChoices(draft: AskDraft, rides: readonly AskRide[]): AskRide[] {
  if (draft.ask !== "which_ride") return [];
  return draft.ride_choices.flatMap((ref) => rides.filter((r) => r.ref === ref));
}
