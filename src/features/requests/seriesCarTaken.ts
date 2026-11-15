// MD1 (owner 2026-11-14, REQ item 232): the question when a one-day ride made multi-day finds its car taken later.
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";
import { tv } from "@/i18n/he";

import type { SeriesBlocker } from "./api";

export type SeriesCarTakenAnswer =
  | { kind: "returnEarlier" }
  | { kind: "replace"; rideId: string; keepLaterEnd: boolean };

export interface SeriesCarTakenQuestion {
  blocker: SeriesBlocker;
  /** The latest return that fits before the blocker; null when it would be on the departure day (R21B3). */
  latestReturn: string | null;
  /** The return the member asked for (to compare with the own ride's end). */
  requestedReturn: string;
  /** The editor is the requester ("יש לך") rather than someone editing for them ("לדנה"). */
  editorIsRequester: boolean;
}

export function seriesCarTakenText(q: SeriesCarTakenQuestion): string {
  const day = formatDayDate(q.blocker.starts_at);
  const time = formatTime(new Date(q.blocker.starts_at));
  const name = q.blocker.name ?? "";
  if (q.blocker.kind === "maintenance") return tv("request.carTakenMaintenance", { day, time });
  if (q.blocker.kind === "own_ride") {
    return q.editorIsRequester
      ? tv("request.carTakenOwnMine", { day, time })
      : tv("request.carTakenOwnOther", { name, day, time });
  }
  return tv("request.carTakenRide", { name, day, time });
}

