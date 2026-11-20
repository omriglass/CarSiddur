// REQ item 258 (d): a checked chat draft → the regular request form's values. Pure. Only what the draft says is set;
// the form's own defaults (origin, ride type, flexibility…) stay, and the member sees everything before sending.
// Names come back to ids through the function's `people` refs (never guessed: an ambiguous or unknown name is left out
// and listed in `unresolved`); places by the department list's exact name, else as typed text.
import type { DestinationValue } from "@/components/DestinationCombobox";
import type { RequestFormValues } from "@/features/requests/schema";
import { tripTypeToLegacyFields } from "@/features/requests/tripType";
import { dateKey, weekStartFor } from "@/lib/time";

import type { AskDraft, AskPersonRef, AskPlaceRef } from "./types";

export interface AskCatalog {
  destinations: readonly { id: string; name: string }[];
  people: Record<string, AskPersonRef | null>;
}

/** The Sunday (week key) of a `YYYY-MM-DD` day. */
export function weekStartOfDay(day: string): string {
  return dateKey(weekStartFor(new Date(`${day}T12:00:00+02:00`)));
}

/** The form's 15-minute grid: the nearest quarter (an arrive-by time rounds down, so the member is never late). */
export function toQuarter(time: string, mode: "nearest" | "down" = "nearest"): string {
  const [h = 0, m = 0] = time.split(":").map(Number);
  const total = h * 60 + m;
  let q = mode === "down" ? Math.floor(total / 15) * 15 : Math.round(total / 15) * 15;
  if (q >= 24 * 60) q = 24 * 60 - 15;
  return `${String(Math.floor(q / 60)).padStart(2, "0")}:${String(q % 60).padStart(2, "0")}`;
}

export function placeValue(ref: AskPlaceRef | null | undefined, destinations: AskCatalog["destinations"]): DestinationValue | null {
  if (!ref) return null;
  const listed = ref.list_name ? destinations.find((d) => d.name === ref.list_name) : undefined;
  if (listed) return { presetId: listed.id, name: listed.name };
  const text = (ref.text ?? "").trim();
  return text ? { freeText: text } : null;
}

export function resolvePeople(names: readonly string[], people: AskCatalog["people"]) {
  const companions: string[] = [];
  const children: string[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const ref = people[name];
    if (!ref) unresolved.push(name);
    else if (ref.kind === "child") children.push(ref.id);
    else companions.push(ref.id);
  }
  return { companions, children, unresolved };
}

const uniq = (ids: readonly string[]) => [...new Set(ids)];

function stopValues(draft: AskDraft, leg: "out" | "return", destinations: AskCatalog["destinations"]): DestinationValue[] {
  return (draft.stops ?? []).filter((s) => s.leg === leg).map((s) => placeValue(s, destinations)).filter((v): v is DestinationValue => !!v);
}

function tripFields(tripType: NonNullable<AskDraft["trip_type"]>, hasReturn: boolean): Partial<RequestFormValues> {
  const dropOffPickup = tripType === "drop_off" && hasReturn;
  const legacy = tripTypeToLegacyFields(tripType, dropOffPickup);
  return { tripType, dropOffPickup, tripShape: legacy.tripShape, needsCarAtDestination: legacy.needsCarAtDestination, oneWayCarMode: legacy.oneWayCarMode };
}

function timeFields(draft: AskDraft): Partial<RequestFormValues> {
  const out: Partial<RequestFormValues> = {};
  if (draft.time) {
    if (draft.time_mode === "arrive_by") Object.assign(out, { departAnchor: "arrive", arriveByTime: toQuarter(draft.time, "down") });
    else Object.assign(out, { departAnchor: "leave", departTime: toQuarter(draft.time) });
  }
  if (draft.return_time) Object.assign(out, { returnAnchor: "arrive", returnTime: toQuarter(draft.return_time) });
  return out;
}

/** A new request: the form's values from the draft (on top of the form's empty values). */
export function draftToNewRequest(draft: AskDraft, catalog: AskCatalog): { patch: Partial<RequestFormValues>; weekStart: string | null; unresolved: string[] } {
  const patch: Partial<RequestFormValues> = { ...timeFields(draft) };
  if (draft.date) Object.assign(patch, { day: draft.date, returnDay: draft.date });
  const destination = placeValue(draft.destination, catalog.destinations);
  if (destination) patch.destination = destination;
  const origin = placeValue(draft.origin, catalog.destinations);
  if (origin) patch.origin = origin;
  if (draft.trip_type) Object.assign(patch, tripFields(draft.trip_type, !!draft.return_time));
  patch.outStops = stopValues(draft, "out", catalog.destinations);
  patch.returnStops = stopValues(draft, "return", catalog.destinations);
  const { companions, children, unresolved } = resolvePeople(draft.people ?? [], catalog.people);
  if (companions.length) patch.companions = uniq(companions);
  if (children.length) Object.assign(patch, { children: uniq(children), childSeats: uniq(children).length });
  if (draft.extra_adults && draft.extra_adults > 0) patch.extraAdults = Math.min(draft.extra_adults, 7);
  if (draft.needs?.includes("large_trunk")) patch.luggage = true;
  if (draft.needs?.includes("tow_hitch")) patch.towHitch = true;
  return { patch, weekStart: draft.date ? weekStartOfDay(draft.date) : null, unresolved };
}

/** An edit: the change applied to the request's own form values (only what the draft changes). */
export function applyDraftEdit(values: RequestFormValues, draft: AskDraft, catalog: AskCatalog): { values: RequestFormValues; unresolved: string[] } {
  const next: RequestFormValues = { ...values, ...timeFields(draft) };
  if (draft.trip_type && draft.trip_type !== values.tripType) {
    Object.assign(next, tripFields(draft.trip_type, draft.trip_type === "drop_off" ? !!(draft.return_time ?? values.returnTime) : true));
  }
  const addOut = stopValues(draft, "out", catalog.destinations);
  const addReturn = stopValues(draft, "return", catalog.destinations);
  if (addOut.length) next.outStops = [...values.outStops, ...addOut];
  if (addReturn.length) next.returnStops = [...values.returnStops, ...addReturn];
  const add = resolvePeople(draft.people ?? [], catalog.people);
  const remove = resolvePeople(draft.remove_people ?? [], catalog.people);
  const removed = new Set([...remove.companions, ...remove.children]);
  next.companions = uniq([...values.companions, ...add.companions]).filter((id) => !removed.has(id));
  const children = uniq([...values.children, ...add.children]).filter((id) => !removed.has(id));
  if (children.length !== values.children.length || children.some((id, i) => id !== values.children[i])) {
    next.childSeats = Math.max(0, values.childSeats + (children.length - values.children.length));
  }
  next.children = children;
  if (draft.needs?.includes("large_trunk")) next.luggage = true;
  if (draft.needs?.includes("tow_hitch")) next.towHitch = true;
  return { values: next, unresolved: [...add.unresolved, ...remove.unresolved] };
}

/** REQ item 258 (f): what the member finally sent vs what the chat understood — the measured model error. */
const DIFF_FIELDS = [
  "day", "departAnchor", "departTime", "arriveByTime", "returnTime", "tripType", "destination", "origin",
  "outStops", "returnStops", "companions", "children", "extraAdults", "luggage", "towHitch",
] as const;

export function formDiff(understood: Partial<RequestFormValues>, sent: RequestFormValues): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of DIFF_FIELDS) {
    if (!(key in understood)) continue;
    const from = understood[key];
    const to = sent[key];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) diff[key] = { from: from ?? null, to: to ?? null };
  }
  return diff;
}

/** The sent values kept with the conversation — the diff fields only (never the note to the Sadran). */
export function sentSnapshot(sent: RequestFormValues): Record<string, unknown> {
  return Object.fromEntries(DIFF_FIELDS.map((key) => [key, sent[key] ?? null]));
}
