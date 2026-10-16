import { tv } from "@/i18n/he";
import type { Database } from "@/integrations/supabase/types";
import { formatDayDate } from "@/lib/dayLabels";
import { dateKey, formatTime } from "@/lib/time";

import { peopleOf } from "./ridePeople";
import { servedOf } from "./servedOf";
import type { BoardRide } from "@/features/siddur/api";

/**
 * "Be back on time" (REQ §13.108 f, docs/TODO.md U3): the ride right before / after a ride on the same
 * car, read from `v_ride_car_neighbours` (the one SQL source — what counts as a neighbour and the
 * tight-gap threshold are decided there, never here). Pure: no React, no Supabase calls.
 */
export type CarNeighbourRow = Database["public"]["Views"]["v_ride_car_neighbours"]["Row"];

export type CarNeighbourKind = "ride" | "reservation" | "car_move";

export interface CarNeighbour {
  rideId: string;
  /** Next ride: its start. Previous ride: its end. */
  at: string;
  kind: CarNeighbourKind;
  /** Driver, else first requester, else first named person of a reservation; null when nobody is named. */
  name: string | null;
  /** Profile ids on that ride (driver, requesters, companions, named people). */
  people: string[];
  gapMinutes: number;
  tight: boolean;
}

export interface CarNeighbours {
  next: CarNeighbour | null;
  prev: CarNeighbour | null;
}

function kindOf(raw: string | null): CarNeighbourKind {
  return raw === "reservation" || raw === "car_move" ? raw : "ride";
}

export function mapCarNeighbours(row: CarNeighbourRow): CarNeighbours {
  return {
    next: row.next_ride_id && row.next_starts_at
      ? { rideId: row.next_ride_id, at: row.next_starts_at, kind: kindOf(row.next_kind), name: row.next_name,
          people: row.next_people ?? [], gapMinutes: row.next_gap_minutes ?? 0, tight: !!row.next_tight }
      : null,
    prev: row.prev_ride_id && row.prev_ends_at
      ? { rideId: row.prev_ride_id, at: row.prev_ends_at, kind: kindOf(row.prev_kind), name: row.prev_name,
          people: row.prev_people ?? [], gapMinutes: row.prev_gap_minutes ?? 0, tight: !!row.prev_tight }
      : null,
  };
}

type NeighbourRide = Pick<BoardRide, "id" | "car_id" | "starts_at" | "ends_at" | "status" | "planning_conflict" | "series_id" | "auto_relocation" | "pin_reason" | "driver_id" | "driver_name" | "served" | "people">;

/** The view's threshold: the week override / department turnaround, never below 30 minutes. */
const MIN_TIGHT_MINUTES = 30;

function neighbourOf(ride: NeighbourRide, at: string, gapMs: number, thresholdMs: number): CarNeighbour {
  const served = servedOf(ride as BoardRide);
  const people = peopleOf(ride);
  const kind: CarNeighbourKind = ride.auto_relocation && ride.pin_reason === "CAR_MOVE" ? "car_move"
    : !ride.auto_relocation && served.length === 0 ? "reservation" : "ride";
  const ids = new Set<string>();
  if (ride.driver_id) ids.add(ride.driver_id);
  for (const person of people) if (person.person_id) ids.add(person.person_id);
  const name = ride.driver_name
    ?? served.find((entry) => entry.requester)?.requester
    ?? people.find((person) => person.source === "added")?.display_name
    ?? null;
  return { rideId: ride.id as string, at, kind, name, people: [...ids], gapMinutes: Math.round(gapMs / 60_000), tight: gapMs <= thresholdMs };
}

/**
 * Client mirror of `v_ride_car_neighbours` for days the view hides (unpublished days the viewer manages, owner
 * 2026-10-16): same car, another ride, not a planning conflict, a different series; the next ride is the earliest
 * starting at/after this one's end, the previous the latest ending at/before its start; tight = gap <=
 * max(turnaround, 30). Unlike the view, `draft` rides count too (the viewer sees them because they manage the day).
 */
export function neighboursFromRides(rides: readonly NeighbourRide[], rideId: string, turnaroundMinutes: number): CarNeighbours {
  const self = rides.find((ride) => ride.id === rideId);
  if (!self?.car_id || !self.starts_at || !self.ends_at) return { next: null, prev: null };
  const start = new Date(self.starts_at).getTime();
  const end = new Date(self.ends_at).getTime();
  const thresholdMs = Math.max(turnaroundMinutes, MIN_TIGHT_MINUTES) * 60_000;
  const others = rides.filter((other) => other.id && other.id !== rideId && other.car_id === self.car_id && other.starts_at && other.ends_at
    && (other.status === "confirmed" || other.status === "flagged" || other.status === "draft")
    && !other.planning_conflict && (!self.series_id || other.series_id !== self.series_id));
  const byId = (a: NeighbourRide, b: NeighbourRide) => (a.id as string).localeCompare(b.id as string);
  const next = others.filter((o) => new Date(o.starts_at as string).getTime() >= end)
    .sort((a, b) => new Date(a.starts_at as string).getTime() - new Date(b.starts_at as string).getTime() || byId(a, b))[0];
  const prev = others.filter((o) => new Date(o.ends_at as string).getTime() <= start)
    .sort((a, b) => new Date(b.ends_at as string).getTime() - new Date(a.ends_at as string).getTime() || byId(a, b))[0];
  return {
    next: next ? neighbourOf(next, next.starts_at as string, new Date(next.starts_at as string).getTime() - end, thresholdMs) : null,
    prev: prev ? neighbourOf(prev, prev.ends_at as string, start - new Date(prev.ends_at as string).getTime(), thresholdMs) : null,
  };
}

/** A multi-day series row: "next" comes from its LAST leg's ride, "prev" from its FIRST leg's. */
export function combineSeriesNeighbours(first: CarNeighbours | undefined, last: CarNeighbours | undefined): CarNeighbours | undefined {
  if (!first && !last) return undefined;
  return { prev: first?.prev ?? null, next: last?.next ?? null };
}

export interface CarHandoverNotes {
  /** Someone takes the car right after this ride: return it on time. */
  returnBy?: CarNeighbour;
  /** The car arrives from someone else's ride right before this one. */
  arrivesFrom?: CarNeighbour;
}

/**
 * Only a driver/requester of the ride sees a note (`rideParticipantIds` = the ride's driver + requesters of its
 * served requests), only when the gap is tight, and never when the viewer is also on the neighbouring ride
 * (their own next ride is not "someone else").
 */
export function carHandoverNotes(
  neighbours: CarNeighbours | null | undefined,
  viewerId: string | null | undefined,
  rideParticipantIds: readonly string[],
): CarHandoverNotes {
  if (!neighbours || !viewerId || !rideParticipantIds.includes(viewerId)) return {};
  const notes: CarHandoverNotes = {};
  if (neighbours.next?.tight && !neighbours.next.people.includes(viewerId)) notes.returnBy = neighbours.next;
  if (neighbours.prev?.tight && !neighbours.prev.people.includes(viewerId)) notes.arrivesFrom = neighbours.prev;
  return notes;
}

export interface CarHandoverLine {
  id: "returnBy" | "arrivesFrom";
  before: string;
  /** Weekday + date when the neighbour is on another day than the reference instant, else empty. */
  day: string;
  time: string;
  after: string;
}

const TIME_MARK = "{{time}}";

function split(template: string, id: CarHandoverLine["id"], day: string, time: string): CarHandoverLine {
  const [before = "", after = ""] = template.split(TIME_MARK);
  return { id, before, day, time, after };
}

/**
 * The lines to show, split around the time so the UI can put it in an `<span dir="ltr">`.
 * `rideStartsAt` / `rideEndsAt`: this ride's (series: first start / last end), to decide whether a day label is needed.
 */
export function carHandoverLines(notes: CarHandoverNotes, ride: { startsAt: string; endsAt: string }): CarHandoverLine[] {
  const lines: CarHandoverLine[] = [];
  if (notes.returnBy) {
    const n = notes.returnBy;
    const key = n.kind === "car_move" ? "carHandover.returnByCarMove"
      : n.kind === "reservation" ? "carHandover.returnByReservation"
      : n.name ? "carHandover.returnByRide" : "carHandover.returnByUnnamed";
    const day = dateKey(n.at) === dateKey(ride.endsAt) ? "" : formatDayDate(n.at);
    lines.push(split(tv(key, { name: n.name ?? "", time: TIME_MARK }), "returnBy", day, formatTime(new Date(n.at))));
  }
  if (notes.arrivesFrom) {
    const n = notes.arrivesFrom;
    const key = n.kind === "car_move" ? "carHandover.arrivesFromCarMove"
      : n.kind === "reservation" ? "carHandover.arrivesFromReservation"
      : n.name ? "carHandover.arrivesFromRide" : "carHandover.arrivesFromUnnamed";
    const day = dateKey(n.at) === dateKey(ride.startsAt) ? "" : formatDayDate(n.at);
    lines.push(split(tv(key, { name: n.name ?? "", time: TIME_MARK }), "arrivesFrom", day, formatTime(new Date(n.at))));
  }
  return lines;
}
