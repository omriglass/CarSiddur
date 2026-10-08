// The "הבקשה במילים" column of the export's requests sheet (owner 2026-10-08): one line that reads like the sentence form
// ("X ו־Y צריכים הלוך-חזור מ… ל… ביום ב׳ 12.10, לצאת ב־17:00, …") plus every modifier, so a request can be re-created by
// hand if the app is down. Pure; all wording comes from the sentence form's own dictionary keys and helpers.
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { isActiveStop } from "@/lib/routeStops";
import { formatTime } from "@/lib/time";

import { flexBrief } from "../../requests/components/requestForm/sentence/sentenceModel";
import { flexBriefText } from "../../requests/flexText";
import { intervalToFlexValue } from "../../requests/mapper";
import { windowSummary } from "../../requests/timeWindow";
import { whoText } from "../../requests/whoLabel";
import { fallbackLine } from "../board/planBLine";

import type { WeekRequestRow } from "../api";

const LRE = "‪";
const PDF = "‬";
const time = (instant: string) => formatTime(new Date(instant));
const flex = (interval: string | null | undefined) => intervalToFlexValue(interval ?? "");
const day = (instant: string) => formatDayDate(instant);

function labelThen(label: string, value: string): string {
  return /\p{Pd}$/u.test(label) ? `${label}${value}` : `${label} ${value}`;
}

export type RequestSentenceInput = Pick<WeekRequestRow,
  "trip_type" | "depart_at" | "return_at" | "arrive_by" | "leave_dest_at" | "depart_anchor" | "return_anchor" | "duration_locked"
  | "flex_depart_early" | "flex_depart_late" | "flex_return_early" | "flex_return_late" | "adults" | "child_seats" | "boosters"
  | "has_luggage" | "notes" | "ride_description" | "template_id" | "fallback" | "served_by_alternative" | "series_id" | "series_index" | "series_count"
  | "destination_text" | "origin_text"> & Partial<Pick<WeekRequestRow,
  "requester_full_name" | "companions" | "childNames" | "guest_passenger_names" | "destination_resolved_name" | "origin_resolved_name"
  | "stops" | "ride_type_name_he" | "preferred_car_name" | "alternative" | "trip_shape">>;

/** Keeps every `HH:mm` in the text left-to-right inside an RTL spreadsheet cell. */
export function isolateTimes(text: string): string {
  return text.replace(/\d{1,2}:\d{2}/g, (match) => `${LRE}${match}${PDF}`);
}

export function requestSentenceText(row: RequestSentenceInput): string {
  const hasReturn = !!row.return_at;
  const names = [row.requester_full_name, ...(row.companions ?? []).map((c) => c.name), ...(row.childNames ?? []), ...(row.guest_passenger_names ?? [])]
    .map((n) => n?.trim()).filter((n): n is string => !!n);
  const companionCount = (row.companions ?? []).length + (row.guest_passenger_names ?? []).length;
  const extraAdults = Math.max(0, row.adults - 1 - companionCount);
  const unnamedChildren = Math.max(0, row.child_seats + row.boosters - (row.childNames ?? []).length);
  const plural = names.length > 1 || extraAdults > 0 || unnamedChildren > 0;
  const who = whoText(names, extraAdults, unnamedChildren);

  const trip = row.trip_type === "round_trip" ? he.request.tripTypeRoundTrip
    : row.trip_type === "one_way" ? he.request.tripTypeOneWay
      : hasReturn ? he.requestSentence.tripDropOffPickup : he.request.tripTypeDropOff;

  const stops = (row.stops ?? []).filter((stop) => isActiveStop(stop, hasReturn)).sort((a, b) => a.position - b.position);
  const stopNames = (leg: "out" | "return") => stops.filter((stop) => stop.leg === leg).map((stop) => stop.place?.name ?? stop.place_text ?? "").filter(Boolean);
  const origin = row.origin_resolved_name ?? row.origin_text ?? "";
  const destination = row.destination_resolved_name ?? row.destination_text ?? "";
  const outVia = stopNames("out");
  const route = [origin ? `${he.requestSentence.from}${origin}` : "", outVia.length ? `${he.requestSentence.via} ${outVia.join(", ")}` : "",
    destination ? `${he.requestSentence.to}${destination}` : ""].filter(Boolean).join(" ");

  const first = row.depart_at ?? row.return_at;
  const last = row.return_at ?? row.depart_at;
  const dayText = first ? (last && day(last) !== day(first) ? tv("requestSentence.dayRange", { from: day(first), to: day(last) }) : day(first)) : "";
  const head = [who, plural ? he.requestSentence.needsPlural : he.requestSentence.needs, trip, route, dayText ? tv("excelExport.sentence.onDay", { day: dayText }) : ""]
    .filter(Boolean).join(" ");

  // Entered times: a window, or the anchored/plain out and return times.
  const window = windowSummary({ durationLocked: row.duration_locked, departAt: row.depart_at, returnAt: row.return_at, flexReturnLate: row.flex_return_late });
  const isPickup = row.trip_type === "drop_off";
  const clauses: string[] = [];
  if (window) clauses.push(`${he.requestSentence.window.forPrefix}${window}`);
  else {
    if (row.depart_at) {
      clauses.push(row.depart_anchor === "arrive" && row.arrive_by
        ? labelThen(he.requestSentence.anchor.outArrive, time(row.arrive_by))
        : labelThen(he.requestSentence.anchor.outLeave, time(row.depart_at)));
    }
    if (row.return_at) {
      if (row.return_anchor === "leave" && row.leave_dest_at) {
        clauses.push(labelThen(isPickup ? he.requestSentence.anchor.pickupLeave : he.requestSentence.anchor.returnLeave, time(row.leave_dest_at)));
      } else {
        clauses.push(labelThen(isPickup ? he.requestSentence.anchor.pickupArrive : he.requestSentence.anchor.returnArrive, time(row.return_at)));
      }
    }
  }

  const modifiers: string[] = [];
  const returnVia = hasReturn ? stopNames("return") : [];
  if (returnVia.length) modifiers.push(tv("requestSentence.recapReturnVia", { names: returnVia.join(", ") }));
  if (row.series_id && row.series_count && row.series_count > 1) modifiers.push(tv("ride.seriesDay", { index: String(row.series_index ?? 1), count: String(row.series_count) }));
  if (!window) {
    const out = flexBriefText(flexBrief(flex(row.flex_depart_early), flex(row.flex_depart_late)));
    const ret = hasReturn ? flexBriefText(flexBrief(flex(row.flex_return_early), flex(row.flex_return_late))) : "";
    if (out && out === ret) modifiers.push(tv("excelExport.sentence.flex", { brief: out }));
    else {
      if (out) modifiers.push(tv(hasReturn ? "excelExport.sentence.flexOut" : "excelExport.sentence.flex", { brief: out }));
      if (ret) modifiers.push(tv("excelExport.sentence.flexReturn", { brief: ret }));
    }
  }
  if (row.preferred_car_name) modifiers.push(tv("excelExport.sentence.preferredCar", { name: row.preferred_car_name }));
  if (row.has_luggage) modifiers.push(he.requestSentence.carLuggage);
  const plan = fallbackLine({ fallback: row.fallback, alternative: row.alternative ?? null, trip_type: row.trip_type, series_id: row.series_id, served_by_alternative: row.served_by_alternative });
  if (plan) modifiers.push(plan);
  if (row.ride_type_name_he) modifiers.push(`${he.requestSentence.rideType}: ${row.ride_type_name_he}`);
  if (row.template_id) modifiers.push(he.request.repeating);
  if (row.notes?.trim()) modifiers.push(`${he.requestSentence.note}: ${row.notes.trim()}`);
  if (row.ride_description?.trim()) modifiers.push(`${he.requestSentence.description}: ${row.ride_description.trim()}`);

  return isolateTimes([clauses.length ? `${head}, ${clauses.join(", ")}` : head, ...modifiers].join(" · "));
}
