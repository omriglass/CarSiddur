// src/solver/seriesRepair.ts
//
// REQUIREMENTS item 136 (e), docs/SOLVER.md §3.16: multi-day trips can be repaired and, when they cannot,
// explained.
//
//   1. runSeriesRepair: a series unit that found no free car after greedy + improve tries each shared car that
//      seats it. The blockers are the placed solver SINGLES (round trips only) overlapping the series' preferred
//      span (incl. buffer). Fixed rides, relay pairs, other series, one-way/chauffeur rides and pooled hosts never
//      move. When every blocker can be re-placed inside its OWN declared flexibility (on another car, or on the
//      same car outside the span) the relocations are applied and the series is placed — all-or-nothing per car.
//      The car with the fewest relocations wins, then the least total shift, then the preference rank, then id.
//   2. suggestSeriesSpan: a series that is still unmet gets one `shiftBeyondFlex` suggestion on its head leg: the
//      nearest later start (up to the end of the first day) and/or earlier end (<= beyondFlexMaxMinutes) at which
//      some shared car is free for the whole span ("a car is free from Thursday 11:30").
//
// Pure and deterministic: every loop runs over id-sorted cars and id-sorted blockers.

import { carPreferenceRank, carsByPreference } from './carPreference';
import { bestPlacementWithinFlex } from './flexibility';
import { addSeriesBlocks, trySeriesOnCar, type PlacedSeries, type PlacedSingle, type SeriesPlacement, type Unit } from './greedy';
import { addsChainBreak, chainBreakIds } from './improve';
import { carName } from './names';
import { dayBoundsForSlot, formatSlotTime, minutesToSlots, type NormalizedRequest } from './slots';
import { fits, luggageFits } from './seatFit';
import { reason, weekdayName } from './reasons';
import type { Block, CarTimeline } from './timeline';
import type { Car, Relocation, SolverInput, Suggestion } from './types';

/** Most blockers moved off one car for one series (bounds the search; see SOLVER §3.16). */
export const MAX_SERIES_BLOCKERS = 6;

export interface SeriesRepairResult {
  newlyPlaced: PlacedSeries[];
  relocations: Relocation[];
  stillUnmetUnits: Unit[];
}

const rideIdOf = (nr: NormalizedRequest): string => `ride:${nr.id}`;

/** Round-trip singles the solver itself placed: the only kind that may be moved for a series. */
function isRelocatable(p: PlacedSingle): boolean {
  return (
    p.nr.legs[0]?.side === 'both' &&
    p.nr.tripType === 'round_trip' &&
    !p.nr.isPassengerOnly &&
    !p.nr.request.seriesId &&
    (p.guests?.length ?? 0) === 0
  );
}

function overlapsSpan(aStart: number, aEnd: number, bStart: number, bEnd: number, bufferSlots: number): boolean {
  return aStart < bEnd + bufferSlots && bStart < aEnd + bufferSlots;
}

function blockOf(p: PlacedSingle, input: SolverInput, window = p.window): Block {
  const leg = p.nr.legs[0];
  return {
    rideId: rideIdOf(p.nr),
    window,
    startLocationId: leg?.originId ?? input.homeLocationId,
    endLocationId: leg?.destinationId ?? input.homeLocationId,
    overnightAck: false,
  };
}

interface Move {
  blocker: PlacedSingle;
  toCarId: string;
  window: { start: number; end: number };
  cost: number;
}

interface Trial {
  car: Car;
  placement: SeriesPlacement;
  moves: Move[];
  shiftTotal: number;
}

interface Budget {
  left: number;
}

/**
 * Tentatively repairs `car` for `su`. With `commit` false every change to the timelines is rolled back before
 * returning (the result still describes what would be done); with `commit` true it stays applied.
 */
function tryRepairOnCar(
  su: import('./slots').SeriesUnit,
  car: Car,
  blockers: PlacedSingle[],
  sharedCars: Car[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  budget: Budget,
  commit: boolean,
): Trial | null {
  const tl = timelines.get(car.id);
  if (!tl) return null;
  const baselines = new Map<string, Set<string>>([[car.id, chainBreakIds(tl)]]);
  const baselineOf = (id: string, t: CarTimeline): Set<string> => {
    let b = baselines.get(id);
    if (!b) {
      b = chainBreakIds(t);
      baselines.set(id, b);
    }
    return b;
  };
  const removed: Block[] = [];
  const addedTargets: { carId: string; rideId: string }[] = [];
  let seriesAdded = false;
  const rollback = (): void => {
    for (const a of addedTargets) timelines.get(a.carId)?.remove(a.rideId);
    if (seriesAdded) for (const leg of su.legs) tl.remove(`ride:${leg.requestId}`);
    for (const b of removed) tl.restore(b);
  };

  for (const b of blockers) {
    const blk = tl.remove(rideIdOf(b.nr));
    if (blk) removed.push(blk);
  }
  const placement = trySeriesOnCar(tl, su.legs, su.seriesCount);
  if (!placement) {
    rollback();
    return null;
  }
  addSeriesBlocks(tl, su, placement);
  seriesAdded = true;
  if (addsChainBreak(tl, baselineOf(car.id, tl))) {
    rollback();
    return null;
  }

  const moves: Move[] = [];
  for (const b of blockers) {
    let best: Move | null = null;
    for (const target of carsByPreference(sharedCars, b.nr.request.preferredCarId)) {
      if (budget.left <= 0) break;
      budget.left--;
      if (!fits(target, b.nr.passengers) || !luggageFits(target, b.nr.luggage ? 1 : 0)) continue;
      const targetTl = timelines.get(target.id);
      if (!targetTl) continue;
      const place = bestPlacementWithinFlex(targetTl, b.nr);
      if (!place) continue;
      if (best && place.cost >= best.cost) continue;
      const baseline = baselineOf(target.id, targetTl);
      const probe = blockOf(b, input, place.window);
      targetTl.add(probe);
      const broke = addsChainBreak(targetTl, baseline);
      targetTl.remove(probe.rideId);
      if (broke) continue;
      best = { blocker: b, toCarId: target.id, window: place.window, cost: place.cost };
    }
    if (!best) {
      rollback();
      return null;
    }
    timelines.get(best.toCarId)?.add(blockOf(b, input, best.window));
    addedTargets.push({ carId: best.toCarId, rideId: rideIdOf(b.nr) });
    moves.push(best);
  }

  const shiftTotal = placement.shiftCost + moves.reduce((s, m) => s + m.cost, 0);
  const trial: Trial = { car, placement, moves, shiftTotal };
  if (!commit) {
    rollback();
    return trial;
  }
  for (const m of moves) {
    const b = m.blocker;
    b.carId = m.toCarId;
    b.window = m.window;
    b.shift = {
      departureMin: (m.window.start - b.nr.window.start) * 15,
      returnMin: (m.window.end - b.nr.window.end) * 15,
    };
    // moved to make room for a multi-day trip, never for mileage balance
    b.balancedMileage = false;
  }
  return trial;
}

export function runSeriesRepair(
  unmetUnits: Unit[],
  placedSingles: PlacedSingle[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
): SeriesRepairResult {
  const sharedCars = [...input.cars].filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  const bufferSlots = Math.round(input.config.bufferMinutes / 15);
  const result: SeriesRepairResult = { newlyPlaced: [], relocations: [], stillUnmetUnits: [] };
  const budget: Budget = { left: input.config.improvementBudget };

  for (const unit of unmetUnits) {
    const su = unit.series;
    const first = su?.legs[0];
    const last = su?.legs[su.legs.length - 1];
    if (unit.kind !== 'series' || !su || !first || !last || budget.left <= 0) {
      result.stillUnmetUnits.push(unit);
      continue;
    }
    const spanStart = first.window.start;
    const spanEnd = last.window.end;
    const perUnit: Budget = { left: Math.min(input.config.perRequestBudget, budget.left) };
    const startBudget = perUnit.left;

    const trials: Trial[] = [];
    for (const car of sharedCars) {
      if (perUnit.left <= 0) break;
      if (!su.legs.every((leg) => fits(car, leg.passengers) && luggageFits(car, leg.luggage ? 1 : 0))) continue;
      const blockers = placedSingles
        .filter(
          (p) =>
            p.carId === car.id &&
            isRelocatable(p) &&
            overlapsSpan(p.window.start, p.window.end, spanStart, spanEnd, bufferSlots),
        )
        .sort((a, b) => (a.nr.id < b.nr.id ? -1 : 1));
      if (blockers.length === 0 || blockers.length > MAX_SERIES_BLOCKERS) continue;
      const trial = tryRepairOnCar(su, car, blockers, sharedCars, timelines, input, perUnit, false);
      if (trial) trials.push(trial);
    }
    budget.left -= startBudget - perUnit.left;

    trials.sort(
      (a, b) =>
        a.moves.length - b.moves.length ||
        a.shiftTotal - b.shiftTotal ||
        carPreferenceRank(a.car.id, su.legs.map((l) => l.request.preferredCarId)) -
          carPreferenceRank(b.car.id, su.legs.map((l) => l.request.preferredCarId)) ||
        (a.car.id < b.car.id ? -1 : 1),
    );
    const chosen = trials[0];
    if (!chosen) {
      result.stillUnmetUnits.push(unit);
      continue;
    }
    const blockers = chosen.moves.map((m) => m.blocker);
    const fromCar = chosen.car.id;
    const applied = tryRepairOnCar(su, chosen.car, blockers, sharedCars, timelines, input, { left: Number.POSITIVE_INFINITY }, true);
    if (!applied) {
      // the dry run succeeded on identical state, so this is unreachable; keep the unit unmet rather than throw
      result.stillUnmetUnits.push(unit);
      continue;
    }
    for (const m of applied.moves) {
      result.relocations.push({ rideId: rideIdOf(m.blocker.nr), fromCarId: fromCar, toCarId: m.toCarId, window: m.window });
    }
    result.newlyPlaced.push({
      kind: 'series',
      series: su,
      carId: chosen.car.id,
      firstWindow: applied.placement.firstWindow,
      lastWindow: applied.placement.lastWindow,
    });
  }
  return result;
}

/**
 * Suggestion for a series that is still unmet: the cheapest (later start, earlier end) pair at which some
 * shared car is free for the whole span. Only the series head can carry it (SQL `series_span` is applied on the
 * head, SOLVER §3.15), so a series whose head is not in this week gets none.
 */
export function suggestSeriesSpan(
  su: import('./slots').SeriesUnit,
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
): Suggestion | null {
  const first = su.legs[0];
  const last = su.legs[su.legs.length - 1];
  if (!first || !last || first.seriesIndex !== 1) return null;
  const canEnd = last.seriesIndex === su.seriesCount;
  const maxStartShift = Math.max(0, first.window.end - first.window.start - 1);
  const maxEndShift = canEnd ? Math.min(minutesToSlots(input.config.beyondFlexMaxMinutes), Math.max(0, last.window.end - last.window.start - 1)) : 0;

  let best: { car: Car; D: number; R: number; cost: number } | null = null;
  for (const car of [...input.cars].filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!su.legs.every((leg) => fits(car, leg.passengers) && luggageFits(car, leg.luggage ? 1 : 0))) continue;
    const tl = timelines.get(car.id);
    if (!tl) continue;
    for (let ds = 0; ds <= maxStartShift; ds++) {
      for (let rs = 0; rs <= maxEndShift; rs++) {
        const cost = (ds + rs) * 15;
        if (best && cost >= best.cost) break;
        if (ds === 0 && rs === 0) continue;
        const D = first.window.start + ds;
        const R = last.window.end - rs;
        if (R <= D) break;
        if (!tl.isFree({ start: D, end: R }, first.originId, undefined, last.destinationId)) continue;
        best = { car, D, R, cost };
        break;
      }
    }
  }
  if (!best) return null;

  const days = input.week.days;
  const depDay = dayBoundsForSlot(days, best.D);
  const retDay = dayBoundsForSlot(days, Math.max(best.D, best.R - 1));
  const startMoved = best.D !== first.window.start;
  const endMoved = best.R !== last.window.end;
  const car = carName(input.cars, best.car.id);
  const code = startMoved && endMoved ? 'SUGGEST_SERIES_SPAN_BOTH' : startMoved ? 'SUGGEST_SERIES_SPAN_START' : 'SUGGEST_SERIES_SPAN_END';
  return {
    kind: 'shiftBeyondFlex',
    requestId: first.requestId,
    carId: best.car.id,
    window: { start: best.D, end: best.R },
    shift: { departureMin: (best.D - first.window.start) * 15, returnMin: (best.R - last.window.end) * 15 },
    reasonCode: code,
    reason: reason(code, {
      car,
      depDay: weekdayName(depDay.dayIndex),
      dep: formatSlotTime(best.D, depDay),
      retDay: weekdayName(retDay.dayIndex),
      ret: formatSlotTime(best.R, retDay),
    }),
    cost: best.cost,
    confidence: Math.max(0, 0.5 - best.cost / 480),
  };
}
