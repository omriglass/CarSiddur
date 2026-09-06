// src/solver/greedy.ts
//
// Ordered greedy assignment (docs/SOLVER.md §3.6). Places units — a single
// round-trip request, or a relay pair (§3.6.1) that must land on one car
// together — in score order, preferred time first, falling back to
// bestPlacementWithinFlex. Car choice is a 5-part deterministic key.
//
// Simplification (documented in docs/SOLVER.md §9): unpaired one-way relay
// requests and one-way passenger requests never enter this loop (a lone
// relay leg cannot be placed — the car would end the day away, §1.3.9; a
// passenger leg has no car of its own) — they go straight to the unmet pool
// for suggestion generation.

import { bestPlacementWithinFlex } from './flexibility';
import type { RelayPair } from './relay';
import { reason } from './reasons';
import { dayBoundsForSlot, formatSlotTime, type NormalizedRequest } from './slots';
import { fits, luggageFits, slack } from './seatFit';
import { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';

export interface Unit {
  kind: 'single' | 'pair';
  id: string;
  score: number;
  submittedAtMs: number;
  single?: NormalizedRequest;
  pair?: { pair: RelayPair; outNr: NormalizedRequest; retNr: NormalizedRequest };
}

export function buildUnits(
  roundTrips: NormalizedRequest[],
  pairs: RelayPair[],
  byRequestId: Map<string, NormalizedRequest>,
  scores: Map<string, { total: number }>,
): Unit[] {
  const units: Unit[] = [];
  for (const nr of roundTrips) {
    units.push({
      kind: 'single',
      id: nr.id,
      score: scores.get(nr.id)?.total ?? 0,
      submittedAtMs: nr.request.submittedAtMs,
      single: nr,
    });
  }
  for (const pair of pairs) {
    const outNr = byRequestId.get(pair.outRequestId);
    const retNr = byRequestId.get(pair.returnRequestId);
    if (!outNr || !retNr) continue;
    const outScore = scores.get(outNr.id)?.total ?? 0;
    const retScore = scores.get(retNr.id)?.total ?? 0;
    units.push({
      kind: 'pair',
      id: pair.outRequestId < pair.returnRequestId ? pair.outRequestId : pair.returnRequestId,
      score: Math.max(outScore, retScore),
      submittedAtMs: Math.min(outNr.request.submittedAtMs, retNr.request.submittedAtMs),
      pair: { pair, outNr, retNr },
    });
  }
  return units;
}

export function sortUnits(units: Unit[]): Unit[] {
  return [...units].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.submittedAtMs !== b.submittedAtMs) return a.submittedAtMs - b.submittedAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function fragmentationFor(tl: CarTimeline, window: Window): number {
  for (const gap of tl.gaps()) {
    if (gap.window.start <= window.start && window.end <= gap.window.end) {
      return gap.window.end - gap.window.start - (window.end - window.start);
    }
  }
  return 0;
}

function continuityRank(carId: string, requestId: string, memberId: string, input: SolverInput): number {
  const prev = input.previousAssignments?.find((a) => a.servedRequestIds.includes(requestId));
  if (prev && prev.carId === carId) return 0;
  if (input.stats.usualCarId[memberId] === carId) return 1;
  return 2;
}

interface CarKey {
  shiftCost: number;
  slackVal: number;
  continuity: number;
  fragmentation: number;
  carId: string;
}

function compareKey(a: CarKey, b: CarKey): number {
  if (a.shiftCost !== b.shiftCost) return a.shiftCost - b.shiftCost;
  if (a.slackVal !== b.slackVal) return a.slackVal - b.slackVal;
  if (a.continuity !== b.continuity) return a.continuity - b.continuity;
  if (a.fragmentation !== b.fragmentation) return a.fragmentation - b.fragmentation;
  return a.carId < b.carId ? -1 : a.carId > b.carId ? 1 : 0;
}

export interface PlacedSingle {
  kind: 'single';
  nr: NormalizedRequest;
  carId: string;
  window: Window;
  shift: { departureMin: number; returnMin: number };
}
export interface PlacedPair {
  kind: 'pair';
  pair: RelayPair;
  outNr: NormalizedRequest;
  retNr: NormalizedRequest;
  carId: string;
}
export type Placed = PlacedSingle | PlacedPair;

export interface GreedyResult {
  placed: Placed[];
  unmetUnits: Unit[];
}

function homeSlack(car: Car, nr: NormalizedRequest): number {
  return slack(car, nr.passengers) ?? Number.POSITIVE_INFINITY;
}

/** Runs the ordered greedy pass, mutating `timelines` in place for every unit it places. */
export function runGreedy(
  units: Unit[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
): GreedyResult {
  const sharedCars = [...input.cars].filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  const placed: Placed[] = [];
  const unmetUnits: Unit[] = [];

  for (const unit of sortUnits(units)) {
    if (unit.kind === 'single' && unit.single) {
      const nr = unit.single;
      const leg = nr.legs[0];
      if (!leg) {
        unmetUnits.push(unit);
        continue;
      }
      let best: { car: Car; window: Window; shift: { departureMin: number; returnMin: number }; key: CarKey } | null =
        null;

      // Phase 1: preferred time on every car.
      for (const car of sharedCars) {
        if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
        const tl = timelines.get(car.id);
        if (!tl) continue;
        if (tl.isFree(nr.window, leg.originId)) {
          const key: CarKey = {
            shiftCost: 0,
            slackVal: homeSlack(car, nr),
            continuity: continuityRank(car.id, nr.id, nr.request.memberId, input),
            fragmentation: fragmentationFor(tl, nr.window),
            carId: car.id,
          };
          if (!best || compareKey(key, best.key) < 0) {
            best = { car, window: nr.window, shift: { departureMin: 0, returnMin: 0 }, key };
          }
        }
      }

      // Phase 2: flexibility search per car.
      if (!best) {
        for (const car of sharedCars) {
          if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
          const tl = timelines.get(car.id);
          if (!tl) continue;
          const placement = bestPlacementWithinFlex(tl, nr);
          if (!placement) continue;
          const key: CarKey = {
            shiftCost: placement.cost,
            slackVal: homeSlack(car, nr),
            continuity: continuityRank(car.id, nr.id, nr.request.memberId, input),
            fragmentation: fragmentationFor(tl, placement.window),
            carId: car.id,
          };
          if (!best || compareKey(key, best.key) < 0) {
            best = { car, window: placement.window, shift: placement.shift, key };
          }
        }
      }

      if (!best) {
        unmetUnits.push(unit);
        continue;
      }
      const tl = timelines.get(best.car.id);
      tl?.add({
        rideId: `ride:${nr.id}`,
        window: best.window,
        startLocationId: leg.originId,
        endLocationId: leg.destinationId,
        overnightAck: false,
      });
      placed.push({ kind: 'single', nr, carId: best.car.id, window: best.window, shift: best.shift });
      continue;
    }

    if (unit.kind === 'pair' && unit.pair) {
      const { pair, outNr, retNr } = unit.pair;
      let best: { car: Car; key: CarKey } | null = null;
      for (const car of sharedCars) {
        if (!fits(car, outNr.passengers) || !fits(car, retNr.passengers)) continue;
        if (!luggageFits(car, outNr.luggage ? 1 : 0) || !luggageFits(car, retNr.luggage ? 1 : 0)) continue;
        const tl = timelines.get(car.id);
        if (!tl) continue;
        if (pair.outWindow.end > pair.returnWindow.start) continue;
        if (!tl.isFree(pair.outWindow, input.homeLocationId)) continue;
        // isFree of the back-leg is evaluated on the timeline *after* the out-leg
        // block is added (SOLVER §3.6) — the car is then at destination, so try
        // it tentatively and roll back if the return leg does not fit.
        const outRideId = `ride:${outNr.id}`;
        tl.add({
          rideId: outRideId,
          window: pair.outWindow,
          startLocationId: input.homeLocationId,
          endLocationId: pair.destinationId,
          overnightAck: false,
        });
        const returnOk = tl.isFree(pair.returnWindow, pair.destinationId);
        tl.remove(outRideId);
        if (!returnOk) continue;

        const shiftCost = pair.shiftCost;
        const slackVal = Math.max(homeSlack(car, outNr), homeSlack(car, retNr));
        const continuity = Math.min(
          continuityRank(car.id, outNr.id, outNr.request.memberId, input),
          continuityRank(car.id, retNr.id, retNr.request.memberId, input),
        );
        const fragmentation = fragmentationFor(tl, { start: pair.outWindow.start, end: pair.returnWindow.end });
        const key: CarKey = { shiftCost, slackVal, continuity, fragmentation, carId: car.id };
        if (!best || compareKey(key, best.key) < 0) best = { car, key };
      }
      if (!best) {
        unmetUnits.push(unit);
        continue;
      }
      const tl = timelines.get(best.car.id);
      tl?.add({
        rideId: `ride:${outNr.id}`,
        window: pair.outWindow,
        startLocationId: input.homeLocationId,
        endLocationId: pair.destinationId,
        overnightAck: false,
      });
      tl?.add({
        rideId: `ride:${retNr.id}`,
        window: pair.returnWindow,
        startLocationId: pair.destinationId,
        endLocationId: input.homeLocationId,
        overnightAck: false,
      });
      placed.push({ kind: 'pair', pair, outNr, retNr, carId: best.car.id });
      continue;
    }

    unmetUnits.push(unit);
  }

  return { placed, unmetUnits };
}

function shiftReasonCode(shift: { departureMin: number; returnMin: number }): string {
  return shift.departureMin === 0 && shift.returnMin === 0 ? 'PLACED_PREFERRED' : 'PLACED_SHIFTED';
}

/** Renders Assignment objects for a greedy result; does not touch timelines. */
export function toAssignments(placed: Placed[], input: SolverInput, carsById: Map<string, Car>): Assignment[] {
  const out: Assignment[] = [];
  for (const p of placed) {
    if (p.kind === 'single') {
      const { nr, carId, window, shift } = p;
      const car = carsById.get(carId);
      const code = shiftReasonCode(shift);
      const text =
        code === 'PLACED_PREFERRED'
          ? reason('PLACED_PREFERRED', { car: car?.name ?? carId })
          : reason('PLACED_SHIFTED', {
              car: car?.name ?? carId,
              dep: `${Math.abs(shift.departureMin)} דק'`,
              ret: `${Math.abs(shift.returnMin)} דק'`,
            });
      out.push({
        rideId: `ride:${nr.id}`,
        carId,
        window,
        originId: input.homeLocationId,
        destinationId: input.homeLocationId,
        driverRequestId: nr.id,
        driverMemberId: nr.request.memberId,
        legs: [
          {
            requestId: nr.id,
            leg: 'both',
            carMode: 'keep',
            originId: input.homeLocationId,
            destinationId: nr.destinationId,
            role: 'driver',
          },
        ],
        servedRequestIds: [nr.id],
        passengers: nr.passengers,
        luggageCount: nr.luggage ? 1 : 0,
        shift,
        source: 'solver',
        reasonCode: code,
        reason: text,
      });
    } else {
      const { pair, outNr, retNr, carId } = p;
      const car = carsById.get(carId);
      const dayOut = dayBoundsForSlot(input.week.days, pair.outWindow.start);
      const dayRet = dayBoundsForSlot(input.week.days, pair.returnWindow.end);
      const text = reason('PLACED_RELAY_PAIR', {
        car: car?.name ?? carId,
        member: outNr.request.memberId,
        dest: pair.destinationId,
        dep: formatSlotTime(pair.outWindow.start, dayOut),
        partner: retNr.request.memberId,
        ret: formatSlotTime(pair.returnWindow.end, dayRet),
      });
      const outShift = { departureMin: (pair.outWindow.start - outNr.window.start) * 15, returnMin: 0 };
      const retShift = { departureMin: 0, returnMin: (pair.returnWindow.end - retNr.window.end) * 15 };
      const outRideId = `ride:${outNr.id}`;
      const retRideId = `ride:${retNr.id}`;
      out.push({
        rideId: outRideId,
        carId,
        window: pair.outWindow,
        originId: input.homeLocationId,
        destinationId: pair.destinationId,
        driverRequestId: outNr.id,
        driverMemberId: outNr.request.memberId,
        legs: [
          {
            requestId: outNr.id,
            leg: 'out',
            carMode: 'relay',
            originId: input.homeLocationId,
            destinationId: pair.destinationId,
            role: 'driver',
          },
        ],
        servedRequestIds: [outNr.id],
        passengers: outNr.passengers,
        luggageCount: outNr.luggage ? 1 : 0,
        shift: outShift,
        pairedRideId: retRideId,
        source: 'solver',
        reasonCode: 'PLACED_RELAY_PAIR',
        reason: text,
      });
      out.push({
        rideId: retRideId,
        carId,
        window: pair.returnWindow,
        originId: pair.destinationId,
        destinationId: input.homeLocationId,
        driverRequestId: retNr.id,
        driverMemberId: retNr.request.memberId,
        legs: [
          {
            requestId: retNr.id,
            leg: 'return',
            carMode: 'relay',
            originId: pair.destinationId,
            destinationId: input.homeLocationId,
            role: 'driver',
          },
        ],
        servedRequestIds: [retNr.id],
        passengers: retNr.passengers,
        luggageCount: retNr.luggage ? 1 : 0,
        shift: retShift,
        pairedRideId: outRideId,
        source: 'solver',
        reasonCode: 'PLACED_RELAY_PAIR',
        reason: text,
      });
    }
  }
  return out;
}
