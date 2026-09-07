// src/solver/timeline.ts
//
// Per-car occupancy timeline (docs/SOLVER.md §3.2). Every occupancy (ride,
// maintenance block, fixed ride) is stored as [start, end + buffer) with its
// start/end location; maintenance blocks never move the car. A candidate
// [s, e) with origin o is legal iff [s, e + buffer) is disjoint from every
// stored interval AND the car is at `o` when it starts — the symmetric
// buffer rule (§1.3.1) plus the location rule (§1.3.8) in one pass.

import type { Car, DayBounds, Window } from './types';

export interface Block {
  rideId: string;
  window: Window;
  startLocationId: string;
  endLocationId: string;
  /** true only for a fixed ride the Sadran explicitly acknowledged may leave the car away overnight */
  overnightAck: boolean;
  approvedBufferAfterSlots?: number;
}

export interface Gap {
  window: Window;
  locationId: string;
}

interface MaintenanceEntry {
  window: Window;
}

/** true iff [aStart, aEnd) and [bStart, bEnd) are within `buffer` slots of each other (symmetric). */
function tooClose(aStart: number, aEnd: number, bStart: number, bEnd: number, buffer: number): boolean {
  return aStart < bEnd + buffer && bStart < aEnd + buffer;
}

export class CarTimeline {
  private blocks: Block[] = [];
  private fixedRideIds = new Set<string>();
  private maintenance: MaintenanceEntry[] = [];
  private readonly startLocation: string;

  constructor(
    private readonly car: Car,
    private readonly bufferSlots: number,
    private readonly weekSlots: number,
    private readonly homeLocationId: string,
  ) {
    this.startLocation = car.startLocationId ?? homeLocationId;
    for (const w of car.maintenance) this.maintenance.push({ window: w });
  }

  /** Where the car is immediately before `slot` (i.e. in the gap containing `slot`). */
  locationAt(slot: number): string {
    let location = this.startLocation;
    for (const b of this.blocks) {
      if (b.window.start > slot) break;
      location = b.endLocationId;
    }
    return location;
  }

  private overlapsAnything(start: number, end: number, fixed?: Block): boolean {
    for (const b of this.blocks) {
      if (fixed && this.fixedRideIds.has(b.rideId)) {
        const approved = (slots: number | undefined) => slots != null && Number.isFinite(slots) ? Math.max(0, Math.min(this.bufferSlots, slots)) : this.bufferSlots;
        if (start < b.window.end + approved(b.approvedBufferAfterSlots) && b.window.start < end + approved(fixed.approvedBufferAfterSlots)) return true;
      } else if (tooClose(start, end, b.window.start, b.window.end, this.bufferSlots)) return true;
    }
    for (const m of this.maintenance) {
      if (tooClose(start, end, m.window.start, m.window.end, this.bufferSlots)) return true;
    }
    return false;
  }

  /** Free AND the car is at `originId` when `w` starts. */
  isFree(w: Window, originId: string): boolean {
    if (w.end <= w.start) return false;
    if (this.overlapsAnything(w.start, w.end)) return false;
    return this.locationAt(w.start) === originId;
  }

  /** Inserts a block; rejects (throws) one whose start location mismatches the car's actual location. */
  add(b: Block): void {
    const actual = this.locationAt(b.window.start);
    if (actual !== b.startLocationId) {
      throw new Error(
        `CarTimeline.add: block ${b.rideId} starts at ${b.startLocationId} but car ${this.car.id} is at ${actual}`,
      );
    }
    if (this.overlapsAnything(b.window.start, b.window.end)) {
      throw new Error(`CarTimeline.add: block ${b.rideId} overlaps an existing block/maintenance on car ${this.car.id}`);
    }
    const idx = this.blocks.findIndex((x) => x.window.start > b.window.start);
    if (idx === -1) this.blocks.push(b);
    else this.blocks.splice(idx, 0, b);
  }

  /**
   * Inserts a block without checking the location chain (only the buffer/overlap
   * rule still applies) — used only to seed fixed rides, which are "still
   * honoured" even when their recorded origin does not match the car's
   * computed location (SOLVER §3.1, FIXED_RIDE_LOCATION_MISMATCH warning).
   */
  forceAdd(b: Block): void {
    if (this.overlapsAnything(b.window.start, b.window.end, b)) {
      throw new Error(`CarTimeline.forceAdd: block ${b.rideId} overlaps an existing block/maintenance on car ${this.car.id}`);
    }
    const idx = this.blocks.findIndex((x) => x.window.start > b.window.start);
    if (idx === -1) this.blocks.push(b);
    else this.blocks.splice(idx, 0, b);
    this.fixedRideIds.add(b.rideId);
  }

  remove(rideId: string): void {
    this.blocks = this.blocks.filter((b) => b.rideId !== rideId);
    this.fixedRideIds.delete(rideId);
  }

  has(rideId: string): boolean {
    return this.blocks.some((b) => b.rideId === rideId);
  }

  allBlocks(): readonly Block[] {
    return this.blocks;
  }

  awayAt(slot: number): boolean {
    return this.locationAt(slot) !== this.homeLocationId;
  }

  /** Free intervals (bounded by the buffer on both sides) with the car's location during each. */
  gaps(): Gap[] {
    const result: Gap[] = [];
    let cursor = 0; // earliest slot at which a new block could start
    let location = this.startLocation;

    // Merge blocks and maintenance into one time-ordered obstacle stream;
    // only real blocks change the carried location.
    type Obstacle = { start: number; end: number; endLocationId?: string };
    const obstacles: Obstacle[] = [
      ...this.blocks.map((b) => ({ start: b.window.start, end: b.window.end, endLocationId: b.endLocationId })),
      ...this.maintenance.map((m) => ({ start: m.window.start, end: m.window.end })),
    ].sort((a, b) => a.start - b.start);

    for (const o of obstacles) {
      if (o.start - this.bufferSlots > cursor) {
        result.push({ window: { start: cursor, end: o.start - this.bufferSlots }, locationId: location });
      }
      cursor = Math.max(cursor, o.end + this.bufferSlots);
      if (o.endLocationId !== undefined) location = o.endLocationId;
    }
    if (cursor < this.weekSlots) {
      result.push({ window: { start: cursor, end: this.weekSlots }, locationId: location });
    }
    return result;
  }

  /**
   * Raw obstacle-to-obstacle gaps, without the buffer margin trimmed off
   * each side — the car is physically present at `location` for the whole
   * interval between two rides, even though a *new* booking could only use
   * the buffer-shrunk sub-interval (that's what `gaps()` is for). Used for
   * away-time reporting (carsAway, day-end check), never for placement.
   */
  private rawGaps(): Gap[] {
    const result: Gap[] = [];
    let cursor = 0;
    let location = this.startLocation;
    type Obstacle = { start: number; end: number; endLocationId?: string };
    const obstacles: Obstacle[] = [
      ...this.blocks.map((b) => ({ start: b.window.start, end: b.window.end, endLocationId: b.endLocationId })),
      ...this.maintenance.map((m) => ({ start: m.window.start, end: m.window.end })),
    ].sort((a, b) => a.start - b.start);

    for (const o of obstacles) {
      if (o.start > cursor) {
        result.push({ window: { start: cursor, end: o.start }, locationId: location });
      }
      cursor = Math.max(cursor, o.end);
      if (o.endLocationId !== undefined) location = o.endLocationId;
    }
    if (cursor < this.weekSlots) {
      result.push({ window: { start: cursor, end: this.weekSlots }, locationId: location });
    }
    return result;
  }

  /** Gaps whose location is not home — for SolverOutput.carsAway. */
  awayWindows(): { locationId: string; window: Window }[] {
    return this.rawGaps()
      .filter((g) => g.locationId !== this.homeLocationId && g.window.end > g.window.start)
      .map((g) => ({ locationId: g.locationId, window: g.window }));
  }

  /**
   * Away windows that improperly span a day's dayEndSlot: the car is away at
   * day end and the block that moved it there was not an acknowledged
   * overnight fixed ride (SOLVER §1.3.9, §3.12).
   */
  dayEndViolations(days: DayBounds[]): { window: Window; causeRideId?: string }[] {
    const away = this.awayWindows();
    const violations: { window: Window; causeRideId?: string }[] = [];
    for (const day of days) {
      const spanning = away.find((a) => a.window.start <= day.dayEndSlot && day.dayEndSlot < a.window.end);
      if (!spanning) continue;
      // find the block that produced this away window (the one whose endLocationId === spanning.locationId
      // and whose window.end <= spanning.window.start, i.e. immediately precedes it)
      const cause = [...this.blocks]
        .filter((b) => b.window.end <= spanning.window.start && b.endLocationId === spanning.locationId)
        .sort((a, b) => b.window.end - a.window.end)[0];
      if (!cause || !cause.overnightAck) {
        violations.push({ window: spanning.window, causeRideId: cause?.rideId });
      }
    }
    return violations;
  }
}

export function buildTimelines(
  cars: Car[],
  bufferSlots: number,
  weekSlots: number,
  homeLocationId: string,
): Map<string, CarTimeline> {
  const map = new Map<string, CarTimeline>();
  for (const car of cars) map.set(car.id, new CarTimeline(car, bufferSlots, weekSlots, homeLocationId));
  return map;
}
