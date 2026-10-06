import { fromZonedTime } from "date-fns-tz";

import { dateKey, formatTime, TZ } from "@/lib/time";

import type { MyRequestRow } from "./api";

export interface SeriesDayOption {
  day: string;
  /** The leg's own departure / return as "HH:MM" (Asia/Jerusalem). */
  departTime: string | null;
  returnTime: string | null;
}

/** One option per calendar day of the multi-day request, day order. */
export function seriesDayOptions(legs: readonly MyRequestRow[]): SeriesDayOption[] {
  return legs.map((leg) => {
    const anchor = leg.departAt ?? leg.returnAt;
    return {
      day: dateKey(anchor ?? new Date()),
      departTime: leg.departAt ? formatTime(new Date(leg.departAt)) : null,
      returnTime: leg.returnAt ? formatTime(new Date(leg.returnAt)) : null,
    };
  });
}

export type ShortenError = "invalidRange" | "unchanged";

export interface ShortenInput {
  days: readonly SeriesDayOption[];
  firstDay: string;
  departTime: string;
  lastDay: string;
  returnTime: string;
}

/** Instants for `shorten_series`, or the reason the choice is not submittable. */
export function buildShortenArgs(input: ShortenInput): { departAt: string; returnAt: string } | { error: ShortenError } {
  const first = input.days.findIndex((d) => d.day === input.firstDay);
  const last = input.days.findIndex((d) => d.day === input.lastDay);
  // REQ §13.103 c: one kept day is fine (it becomes an ordinary one-day request); the return must follow the departure.
  if (first < 0 || last < first || (last === first && input.returnTime <= input.departTime)) return { error: "invalidRange" };
  const original = input.days[0]!;
  const originalEnd = input.days[input.days.length - 1]!;
  if (
    first === 0 && last === input.days.length - 1
    && input.departTime === original.departTime && input.returnTime === originalEnd.returnTime
  ) {
    return { error: "unchanged" };
  }
  return {
    departAt: fromZonedTime(`${input.firstDay}T${input.departTime}:00`, TZ).toISOString(),
    returnAt: fromZonedTime(`${input.lastDay}T${input.returnTime}:00`, TZ).toISOString(),
  };
}
