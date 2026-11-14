// src/solver/personBusy.ts
//
// R20B5 (REQUIREMENTS item 234, docs/SOLVER.md §3.7b): a person is never moved into two rides at once.
// The solver keeps a timeline per car, not per person; this module derives a person's busy hours from
// what is already placed: the fixed rides' riders (`FixedRide.riders`, the driver and every passenger
// with a member id) and this run's own blocks on the car timelines (`ride:<request>`: the requester and
// named companions), plus the guests pooling seats in another ride. A rider of one leg is busy only for
// that leg's travel (owner 2026-11-14: "passengers might join for one of the directions only").
//
// The rule covers only the solver's own moves (owner 2026-11-14): a shift within flexibility, or a seat
// in another ride, may not overlap another ride of the same person. Commitments that already overlap the
// request's filed hours are left out — two requests filed overlapping are placed as filed, as before.

import type { NormalizedRequest } from './slots';
import type { CarTimeline } from './timeline';
import { travelSlotsFor } from './slots';
import type { LegSide, SolverInput, Window } from './types';

const SLOTS_PER_DAY = 96;

interface Commitment {
  memberId: string;
  window: Window;
  /** the request this commitment belongs to (the original id of a split half); undefined for a fixed ride's added rider */
  requestId?: string;
  seriesId?: string;
}

export interface PersonBook {
  timelines: Map<string, CarTimeline>;
  /** fixed rides' riders, by member (static: the solver never moves a fixed ride) */
  fixedByMember: Map<string, (Commitment & { rideId: string })[]>;
  /** this run's requests each member rides on, by member (static); their blocks are `ride:<normalized id>` */
  ownByMember: Map<string, NormalizedRequest[]>;
  /** guests pooling seated in another ride, by member */
  guestByMember: Map<string, { hostRideId: string; nr: NormalizedRequest; leg: LegSide }[]>;
}

/** What a busy check needs of a request (a normalized request or a series leg). */
export type BusySubject = Pick<NormalizedRequest, 'request' | 'window'>;

const rootId = (nr: BusySubject): string => nr.request.splitFrom ?? nr.request.id;

export function ridersOf(nr: BusySubject): string[] {
  return [...new Set([nr.request.memberId, ...nr.request.coRiderMemberIds])];
}

/** The part of `window` a rider of `leg` spends in the car: the whole ride for both legs, else that leg's travel. */
export function legWindow(window: Window, leg: LegSide, travelSlots: number): Window {
  if (leg === 'both') return window;
  const len = Math.min(Math.max(1, travelSlots), window.end - window.start);
  return leg === 'out' ? { start: window.start, end: window.start + len } : { start: window.end - len, end: window.end };
}

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** Built once per solve; a check then touches only the asked riders' own rides (owner 2026-11-14: never slow). */
export function buildPersonBook(input: SolverInput, normalized: readonly NormalizedRequest[], timelines: Map<string, CarTimeline>): PersonBook {
  const fixedByMember = new Map<string, (Commitment & { rideId: string })[]>();
  for (const fr of input.fixedRides) {
    const riders = fr.riders ?? (fr.driverMemberId ? [{ memberId: fr.driverMemberId, leg: 'both' as const }] : []);
    if (riders.length === 0) continue;
    // a round trip's car goes home → home: its riders' far place is unknown here, so a one-leg rider's time aboard is
    // the default travel time
    const travel = fr.originId === fr.destinationId
      ? Math.max(1, Math.ceil(input.config.defaultTravelMinutes / 15))
      : travelSlotsFor(input, fr.originId, fr.destinationId);
    for (const r of riders) {
      push(fixedByMember, r.memberId, {
        rideId: fr.id,
        memberId: r.memberId,
        window: legWindow(fr.window, r.leg, travel),
        ...(r.requestId ? { requestId: r.requestId } : {}),
        ...(fr.seriesId ? { seriesId: fr.seriesId } : {}),
      });
    }
  }
  const ownByMember = new Map<string, NormalizedRequest[]>();
  for (const nr of normalized) for (const memberId of ridersOf(nr)) push(ownByMember, memberId, nr);
  return { timelines, fixedByMember, ownByMember, guestByMember: new Map() };
}

/** Pooling seated `nr` (its `leg`) in the ride `hostRideId`. */
export function seatGuest(book: PersonBook | undefined, hostRideId: string, nr: NormalizedRequest, leg: LegSide): void {
  if (!book) return;
  for (const memberId of ridersOf(nr)) push(book.guestByMember, memberId, { hostRideId, nr, leg });
}

function blockWindow(book: PersonBook, rideId: string): Window | undefined {
  for (const tl of book.timelines.values()) {
    const block = tl.allBlocks().find((b) => b.rideId === rideId);
    if (block) return block.window;
  }
  return undefined;
}

const overlaps = (a: Window, b: Window): boolean => a.start < b.end && b.start < a.end;

/**
 * The hours `nr`'s riders are already taken elsewhere, the solver may not move `nr` into. Left out: the
 * request's own rides (its other legs, its series), the rides in `exceptRideIds` (the ride being moved
 * or joined), and every commitment that overlaps the request's filed hours (filed overlapping = kept as filed).
 */
export function busyWindowsFor(
  book: PersonBook | undefined,
  nr: BusySubject,
  exceptRideIds: readonly string[] = [],
  /** only this rider's commitments (the unmet reason names who is busy) */
  onlyMemberId?: string,
): Window[] {
  if (!book) return [];
  const root = rootId(nr);
  const series = nr.request.seriesId;
  const filed = nr.window;
  // a move stays within a day of the filed hours, so rides further away never matter (and are never looked up)
  const near = { start: filed.start - SLOTS_PER_DAY, end: filed.end + SLOTS_PER_DAY };
  const busy: Window[] = [];
  const consider = (rideId: string, window: Window | undefined, requestId: string | undefined, seriesId: string | undefined): void => {
    if (!window || exceptRideIds.includes(rideId)) return;
    if (requestId === root || (series && seriesId === series)) return;
    if (overlaps(window, filed)) return;
    busy.push(window);
  };
  for (const memberId of onlyMemberId ? [onlyMemberId] : ridersOf(nr)) {
    for (const c of book.fixedByMember.get(memberId) ?? []) {
      if (overlaps(c.window, near)) consider(c.rideId, c.window, c.requestId, c.seriesId);
    }
    for (const own of book.ownByMember.get(memberId) ?? []) {
      if (rootId(own) === root || !overlaps(own.dayWindow, near)) continue;
      const rideId = `ride:${own.id}`;
      consider(rideId, blockWindow(book, rideId), rootId(own), own.request.seriesId);
    }
    for (const g of book.guestByMember.get(memberId) ?? []) {
      if (rootId(g.nr) === root || !overlaps(g.nr.dayWindow, near)) continue;
      const window = blockWindow(book, g.hostRideId);
      consider(g.hostRideId, window && legWindow(window, g.leg, g.nr.travelSlots), rootId(g.nr), undefined);
    }
  }
  return busy.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Whether `window` keeps clear of every busy window. */
export function clearOf(window: Window, busy: readonly Window[]): boolean {
  return busy.every((b) => !overlaps(window, b));
}

/** `gap` minus the busy windows: the free stretches, in order. */
export function freeStretches(gap: Window, busy: readonly Window[]): Window[] {
  const out: Window[] = [];
  let cursor = gap.start;
  for (const b of busy) {
    if (b.end <= cursor || b.start >= gap.end) continue;
    if (b.start > cursor) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < gap.end) out.push({ start: cursor, end: gap.end });
  return out;
}
