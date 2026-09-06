// src/solver/improve.ts
//
// Bounded local improvement (docs/SOLVER.md §3.10): serves an unmet unit by
// relocating already-placed solver rides within their declared flexibility.
// Fixed rides never move. Depth <= 2 blockers, budget-capped by two
// counters; when a solution exists only by ejecting a lower-priority ride
// (no relocation target found for it), the ejection is emitted as a
// shiftWithinFlex suggestion (relocations with toCarId: '') and never
// applied — the greedy order already serves higher scores first.
//
// Simplification (documented in docs/SOLVER.md §9): only single round-trip
// ('keep') placed rides are relocatable; a placed relay pair is treated as
// an immovable blocker (its car is skipped for this unit), and unmet relay
// pairs are not retried by this pass — a conservative reading of "a relay
// pair relocates as one unit" that keeps the search bounded.

import { bestPlacementWithinFlex } from './flexibility';
import type { PlacedSingle, Unit } from './greedy';
import { fits, luggageFits } from './seatFit';
import { reason } from './reasons';
import type { CarTimeline } from './timeline';
import type { Car, Relocation, SolverConfig, SolverInput, Suggestion } from './types';

export interface ImproveResult {
  newlyPlaced: PlacedSingle[];
  stillUnmetUnits: Unit[];
  relocationsApplied: Relocation[];
  ejectionSuggestions: Map<string, Suggestion>;
  budgetExhausted: boolean;
}

interface BudgetState {
  budget: number;
  exhausted: boolean;
}

function overlapsEnvelope(aStart: number, aEnd: number, bStart: number, bEnd: number, bufferSlots: number): boolean {
  return aStart < bEnd + bufferSlots && bStart < aEnd + bufferSlots;
}

export function runImprove(
  unmetUnits: Unit[],
  placedSingles: PlacedSingle[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  scores: Map<string, { total: number }>,
): ImproveResult {
  const config: SolverConfig = input.config;
  const sharedCars = [...input.cars].filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  const bufferSlots = Math.round(config.bufferMinutes / 15);

  const budgetState: BudgetState = { budget: config.improvementBudget, exhausted: false };
  const newlyPlaced: PlacedSingle[] = [];
  const relocationsApplied: Relocation[] = [];
  const ejectionSuggestions = new Map<string, Suggestion>();
  const stillUnmetUnits: Unit[] = [];

  const singleUnits = [...unmetUnits].sort((a, b) => b.score - a.score);

  for (const unit of singleUnits) {
    if (budgetState.exhausted) {
      stillUnmetUnits.push(unit);
      continue;
    }
    if (unit.kind !== 'single' || !unit.single) {
      stillUnmetUnits.push(unit);
      continue;
    }
    const nr = unit.single;
    const leg = nr.legs[0];
    if (!leg) {
      stillUnmetUnits.push(unit);
      continue;
    }

    let perReq = config.perRequestBudget;
    let solved = false;

    for (const car of sharedCars) {
      if (solved || budgetState.exhausted || perReq <= 0) break;
      if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
      const tl = timelines.get(car.id);
      if (!tl) continue;

      // Fixed rides overlapping the flexible envelope make this car unusable.
      const envStart = nr.flexDep[0];
      const envEnd = nr.flexRet[1];
      const fixedBlockers = input.fixedRides.filter(
        (fr) => fr.carId === car.id && overlapsEnvelope(fr.window.start, fr.window.end, envStart, envEnd, bufferSlots),
      );
      if (fixedBlockers.length > 0) continue;

      const blockers = placedSingles.filter(
        (p) =>
          p.carId === car.id &&
          overlapsEnvelope(p.window.start, p.window.end, envStart, envEnd, bufferSlots) &&
          !newlyPlaced.includes(p),
      );
      if (blockers.length > 2) continue;
      if (blockers.length === 0) continue; // handled already by the greedy phase's own flex search

      // Depth 1: relocate each blocker individually.
      for (const b of blockers) {
        if (solved || budgetState.exhausted || perReq <= 0) break;
        const result = tryRelocateSetAndPlace(nr, car, [b], sharedCars, timelines, input, budgetState, () => {
          perReq--;
        });
        if (result) {
          relocationsApplied.push(...result.relocations);
          newlyPlaced.push({ kind: 'single', nr, carId: car.id, window: result.window, shift: result.shift });
          solved = true;
        }
      }

      // Depth 2: relocate the pair of blockers together.
      if (!solved && blockers.length === 2 && !budgetState.exhausted && perReq > 0) {
        const [b1, b2] = blockers;
        if (b1 && b2) {
          const result = tryRelocateSetAndPlace(nr, car, [b1, b2], sharedCars, timelines, input, budgetState, () => {
            perReq--;
          });
          if (result) {
            relocationsApplied.push(...result.relocations);
            newlyPlaced.push({ kind: 'single', nr, carId: car.id, window: result.window, shift: result.shift });
            solved = true;
          }
        }
      }

      // Ejection fallback (depth 1 only): only when `u` genuinely outranks the
      // blocker (REQUIREMENTS §7.1: displacing a placed ride is only ever for
      // a *higher*-priority request) and removing it permanently (not
      // relocating it) would let `u` fit — surfaced as a suggestion, never
      // applied automatically.
      const soleBlocker = blockers.length === 1 ? blockers[0] : undefined;
      const blockerScore = soleBlocker ? (scores.get(soleBlocker.nr.id)?.total ?? 0) : 0;
      if (!solved && soleBlocker && unit.score > blockerScore) {
        const suggestion = ejectionCandidate(nr, car, soleBlocker, tl, input);
        if (suggestion) ejectionSuggestions.set(nr.id, suggestion);
      }
    }

    if (!solved) stillUnmetUnits.push(unit);
    if (budgetState.budget <= 0) budgetState.exhausted = true;
  }

  return { newlyPlaced, stillUnmetUnits, relocationsApplied, ejectionSuggestions, budgetExhausted: budgetState.exhausted };
}

interface RelocationOutcome {
  relocations: Relocation[];
  window: { start: number; end: number };
  shift: { departureMin: number; returnMin: number };
}

function tryRelocateSetAndPlace(
  nr: import('./slots').NormalizedRequest,
  car: Car,
  blockers: PlacedSingle[],
  sharedCars: Car[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  budgetState: BudgetState,
  spend: () => void,
): RelocationOutcome | null {
  const tl = timelines.get(car.id);
  if (!tl) return null;

  // Fast path (single blocker only): rather than relocating the blocker to a
  // different car, try compressing both windows on the SAME car — shift the
  // chronologically-earlier one as early as its own flex allows, the later
  // one as late as its own flex allows, closing exactly the needed gap
  // (mirrors relay.ts's pairing math; SOLVER §3.10 worked example, R8/R5).
  if (blockers.length === 1) {
    const b = blockers[0];
    if (b) {
      budgetState.budget--;
      spend();
      const bufferSlots = Math.round(input.config.bufferMinutes / 15);
      const compressed = closeGapSameCar(nr, b, bufferSlots);
      if (compressed) {
        tl.remove(`ride:${b.nr.id}`);
        const bFits = tl.isFree(compressed.bWindow, b.nr.legs[0]?.originId ?? input.homeLocationId);
        if (bFits) {
          tl.add({
            rideId: `ride:${b.nr.id}`,
            window: compressed.bWindow,
            startLocationId: b.nr.legs[0]?.originId ?? input.homeLocationId,
            endLocationId: b.nr.legs[0]?.destinationId ?? input.homeLocationId,
            overnightAck: false,
          });
          const uFits = tl.isFree(compressed.uWindow, nr.legs[0]?.originId ?? input.homeLocationId);
          if (uFits) {
            const leg = nr.legs[0];
            tl.add({
              rideId: `ride:${nr.id}`,
              window: compressed.uWindow,
              startLocationId: leg?.originId ?? input.homeLocationId,
              endLocationId: leg?.destinationId ?? input.homeLocationId,
              overnightAck: false,
            });
            b.carId = car.id;
            b.window = compressed.bWindow;
            b.shift = {
              departureMin: (compressed.bWindow.start - b.nr.window.start) * 15,
              returnMin: (compressed.bWindow.end - b.nr.window.end) * 15,
            };
            return {
              relocations: [{ rideId: `ride:${b.nr.id}`, fromCarId: car.id, toCarId: car.id, window: compressed.bWindow }],
              window: compressed.uWindow,
              shift: {
                departureMin: (compressed.uWindow.start - nr.window.start) * 15,
                returnMin: (compressed.uWindow.end - nr.window.end) * 15,
              },
            };
          }
          tl.remove(`ride:${b.nr.id}`);
        }
        // roll back b to its original window before falling through
        tl.add({
          rideId: `ride:${b.nr.id}`,
          window: b.window,
          startLocationId: b.nr.legs[0]?.originId ?? input.homeLocationId,
          endLocationId: b.nr.legs[0]?.destinationId ?? input.homeLocationId,
          overnightAck: false,
        });
      }
    }
  }

  // Remove all blockers from `car`'s timeline up front.
  for (const b of blockers) tl.remove(`ride:${b.nr.id}`);

  const newTargets: { blocker: PlacedSingle; targetCarId: string; window: { start: number; end: number } }[] = [];
  let ok = true;

  for (const b of blockers) {
    if (budgetState.budget <= 0) {
      ok = false;
      break;
    }
    let placedTarget: { targetCarId: string; window: { start: number; end: number } } | null = null;
    for (const target of sharedCars) {
      if (target.id === car.id) continue; // same-car case already tried above
      if (budgetState.budget <= 0) break;
      budgetState.budget--;
      spend();
      if (!fits(target, b.nr.passengers) || !luggageFits(target, b.nr.luggage ? 1 : 0)) continue;
      const targetTl = timelines.get(target.id);
      if (!targetTl) continue;
      const placement = bestPlacementWithinFlex(targetTl, b.nr);
      if (!placement) continue;
      placedTarget = { targetCarId: target.id, window: placement.window };
      targetTl.add({
        rideId: `ride:${b.nr.id}`,
        window: placement.window,
        startLocationId: b.nr.legs[0]?.originId ?? input.homeLocationId,
        endLocationId: b.nr.legs[0]?.destinationId ?? input.homeLocationId,
        overnightAck: false,
      });
      break;
    }
    if (!placedTarget) {
      ok = false;
      break;
    }
    newTargets.push({ blocker: b, targetCarId: placedTarget.targetCarId, window: placedTarget.window });
  }

  if (ok) {
    const placement = bestPlacementWithinFlex(tl, nr);
    if (placement) {
      const leg = nr.legs[0];
      tl.add({
        rideId: `ride:${nr.id}`,
        window: placement.window,
        startLocationId: leg?.originId ?? input.homeLocationId,
        endLocationId: leg?.destinationId ?? input.homeLocationId,
        overnightAck: false,
      });
      for (const t of newTargets) {
        t.blocker.carId = t.targetCarId;
        t.blocker.window = t.window;
        t.blocker.shift = {
          departureMin: (t.window.start - t.blocker.nr.window.start) * 15,
          returnMin: (t.window.end - t.blocker.nr.window.end) * 15,
        };
      }
      return {
        relocations: newTargets.map((t) => ({
          rideId: `ride:${t.blocker.nr.id}`,
          fromCarId: car.id,
          toCarId: t.targetCarId,
          window: t.window,
        })),
        window: placement.window,
        shift: placement.shift,
      };
    }
    ok = false;
  }

  // Roll back: remove any tentative target blocks and restore originals.
  for (const t of newTargets) {
    timelines.get(t.targetCarId)?.remove(`ride:${t.blocker.nr.id}`);
  }
  for (const b of blockers) {
    tl.add({
      rideId: `ride:${b.nr.id}`,
      window: b.window,
      startLocationId: b.nr.legs[0]?.originId ?? input.homeLocationId,
      endLocationId: b.nr.legs[0]?.destinationId ?? input.homeLocationId,
      overnightAck: false,
    });
  }
  return null;
}

interface Bounded {
  window: { start: number; end: number };
  flexDep: [number, number];
  flexRet: [number, number];
}

/**
 * Closes the gap between two chronologically-ordered flexible windows on the
 * same car: the earlier one shifts as early as its own flex allows, the
 * later one as late as its own flex allows, splitting exactly the needed
 * gap closure (never more). Returns null if they don't have a clear
 * before/after order or the combined flex can't close the gap.
 */
function closeGapSameCar(
  nr: import('./slots').NormalizedRequest,
  b: PlacedSingle,
  bufferSlots: number,
): { bWindow: { start: number; end: number }; uWindow: { start: number; end: number } } | null {
  const bBounded: Bounded = { window: b.window, flexDep: b.nr.flexDep, flexRet: b.nr.flexRet };
  const uBounded: Bounded = { window: nr.window, flexDep: nr.flexDep, flexRet: nr.flexRet };

  // Order by start time — the two windows may already overlap directly (not
  // just within the buffer margin); "early" moves earlier, "late" moves later.
  const earlyIsB = bBounded.window.start <= uBounded.window.start;

  const early = earlyIsB ? bBounded : uBounded;
  const late = earlyIsB ? uBounded : bBounded;

  const needed = early.window.end + bufferSlots - late.window.start;
  if (needed <= 0) return { bWindow: bBounded.window, uWindow: uBounded.window };

  const maxEarlyShift = Math.max(0, Math.min(early.window.start - early.flexDep[0], early.window.end - early.flexRet[0]));
  const maxLateShift = Math.max(0, Math.min(late.flexDep[1] - late.window.start, late.flexRet[1] - late.window.end));
  if (maxEarlyShift + maxLateShift < needed) return null;

  const earlyShift = Math.min(needed, maxEarlyShift);
  const lateShift = needed - earlyShift;

  const newEarly = { start: early.window.start - earlyShift, end: early.window.end - earlyShift };
  const newLate = { start: late.window.start + lateShift, end: late.window.end + lateShift };

  return earlyIsB ? { bWindow: newEarly, uWindow: newLate } : { bWindow: newLate, uWindow: newEarly };
}

function ejectionCandidate(
  nr: import('./slots').NormalizedRequest,
  car: Car,
  blocker: PlacedSingle,
  tl: CarTimeline,
  input: SolverInput,
): Suggestion | null {
  tl.remove(`ride:${blocker.nr.id}`);
  const placement = bestPlacementWithinFlex(tl, nr);
  tl.add({
    rideId: `ride:${blocker.nr.id}`,
    window: blocker.window,
    startLocationId: blocker.nr.legs[0]?.originId ?? input.homeLocationId,
    endLocationId: blocker.nr.legs[0]?.destinationId ?? input.homeLocationId,
    overnightAck: false,
  });
  if (!placement) return null;

  return {
    kind: 'shiftWithinFlex',
    requestId: nr.id,
    carId: car.id,
    window: placement.window,
    shift: placement.shift,
    relocations: [{ rideId: `ride:${blocker.nr.id}`, fromCarId: car.id, toCarId: '', window: blocker.window }],
    reasonCode: 'SUGGEST_SHIFT_WITHIN_FLEX',
    reason: reason('SUGGEST_SHIFT_WITHIN_FLEX', { car: car.name }),
    cost: placement.cost,
    confidence: 0.5,
  };
}
