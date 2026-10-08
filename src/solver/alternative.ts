// src/solver/alternative.ts
//
// Plan B and the "I will manage" fallback (REQUIREMENTS §13.112 a/b, docs/SOLVER.md §3.15 `useAlternative`).
// Runs AFTER the main solve and never changes it: for every unmet request
//  - `fallback === 'manage'`: the `externalHint` suggestions (cab / rental / public transport) are dropped — the member
//    has no useful fallback; the `deny` stays (the Sadran must refuse it explicitly so the member knows);
//  - `fallback === 'alternative'` with a plan B: the plan B is tried as a drop-off against the board as the main solve left
//    it (every placed ride a fixed block), by solving one synthetic drop-off request through the very same solver
//    (drop-off split, chauffeur / needs-driver rules, car at the origin, turnaround). Success adds a `useAlternative`
//    suggestion (before the external hints and the deny); nothing is placed and the other unmet requests are
//    untouched — each plan B is tested independently against the same board, only one proposal is made at a time.
// Pure and deterministic: the synthetic request goes through the injected `solveBase` (no import cycle with index.ts).

import { reason } from './reasons';
import { byId, dayBoundsForSlot, formatSlotTime, SLOT_MS, toSlotFloor } from './slots';
import { placeName } from './names';
import { effectiveTripType, originIdOf, travelBetween } from './travel';
import type { Assignment, FixedRide, Request, SolverInput, SolverOutput, Suggestion, UnmetRequest } from './types';

/** Id suffix of the synthetic plan-B request inside the test solve (never leaves this module). */
const ALT = '~alt';

type SolveFn = (input: SolverInput) => SolverOutput;

function assignmentToFixed(a: Assignment): FixedRide {
  return {
    id: a.rideId,
    carId: a.carId,
    window: a.window,
    originId: a.originId,
    destinationId: a.destinationId,
    driverRequestId: a.driverRequestId,
    driverMemberId: a.driverMemberId,
    legs: a.legs,
    servedRequestIds: a.servedRequestIds,
    passengers: a.passengers,
    luggageCount: a.luggageCount,
    overnightAck: false,
    ...(a.seriesId ? { seriesId: a.seriesId } : {}),
    kind: 'pinned',
  };
}

/** The board as the main solve left it: the input's own fixed rides (keeping flags such as `locationNeutral`) plus every ride the solver placed. */
function boardAsFixed(input: SolverInput, output: SolverOutput): FixedRide[] {
  const own = new Map(input.fixedRides.map((f) => [f.id, f]));
  const out: FixedRide[] = [];
  for (const a of [...output.assignments].sort((x, y) => byId({ id: x.rideId }, { id: y.rideId }))) {
    out.push(own.get(a.rideId) ?? assignmentToFixed(a));
  }
  return out;
}

/** The plan B as one or two synthetic drop-off requests: the outbound (with a pickup from the same place: round trip), plus — when the pickup is from another place — the pickup leg as a drop-off from that place home. */
function planRequests(input: SolverInput, r: Request): { out: Request; pickup?: Request } | null {
  const alt = r.alternative;
  if (!alt) return null;
  const tripType = effectiveTripType(r);
  if ((tripType !== 'round_trip' && tripType !== 'one_way') || r.seriesId !== undefined || r.originIsFreeText) return null;
  const origin = originIdOf(r, input.homeLocationId);
  if (alt.dropPlaceId === origin) return null;
  const separatePickup = alt.pickupMs !== undefined && (alt.pickupPlaceId !== undefined || alt.pickupPlaceIsFreeText === true);
  // a free-text pickup place is never placed (a car cannot be sent to an unknown place)
  if (separatePickup && (alt.pickupPlaceIsFreeText || alt.pickupPlaceId === origin)) return null;
  // the member's own departure: the drive to the drop place must end by `arriveByMs`
  const outSlots = Math.ceil(travelBetween(input, origin, alt.dropPlaceId).minutes / 15);
  const departureMs = alt.arriveByMs - outSlots * SLOT_MS;
  let returnMs: number | undefined;
  if (alt.pickupMs !== undefined && !separatePickup) {
    // back home = pickup + the drive back
    const backSlots = Math.ceil(travelBetween(input, alt.dropPlaceId, origin).minutes / 15);
    returnMs = alt.pickupMs + backSlots * SLOT_MS;
  }
  const flexNone = { earlierMin: 0, laterMin: 0 } as const;
  const base: Request = {
    ...r,
    tripType: 'drop_off',
    needsCarAtDestination: false,
    flexDeparture: { ...flexNone },
    flexReturn: { ...flexNone },
    durationLocked: undefined,
    preferredCarId: undefined,
    stops: undefined,
    fallback: undefined,
    alternative: undefined,
    servedByAlternative: undefined,
    manualBoost: undefined,
  };
  const out: Request = {
    ...base,
    id: r.id + ALT,
    destinationId: alt.dropPlaceId,
    destinationIsFreeText: alt.dropPlaceIsFreeText ?? false,
    destinationText: alt.dropPlaceText,
    tripShape: returnMs === undefined ? 'one_way_to' : 'round_trip',
    departureMs,
    returnMs,
  };
  if (!separatePickup) return { out };
  const pickup: Request = {
    ...base,
    id: r.id + ALT + 'p',
    originId: alt.pickupPlaceId,
    originIsFreeText: false,
    originText: undefined,
    destinationId: origin,
    destinationIsFreeText: false,
    destinationText: r.originText,
    tripShape: 'one_way_to',
    departureMs: alt.pickupMs,
    returnMs: undefined,
  };
  return { out, pickup };
}

function tryAlternative(input: SolverInput, output: SolverOutput, r: Request, solveBase: SolveFn): Suggestion | null {
  const planned = planRequests(input, r);
  const alt = r.alternative;
  if (!planned || !alt || planned.out.departureMs === undefined) return null;
  const { out: synthetic, pickup } = planned;
  const sub = solveBase({ ...input, requests: pickup ? [synthetic, pickup] : [synthetic], fixedRides: boardAsFixed(input, output), previousAssignments: undefined });
  const mine = sub.assignments.filter((a) => a.source === 'solver');
  const rideOf = (id: string, leg: 'out' | 'return') => mine.find((a) => a.legs.some((l) => l.requestId === id && l.leg === leg));
  const outRide = rideOf(synthetic.id, 'out');
  const retRide = pickup ? rideOf(pickup.id, 'out') : rideOf(synthetic.id, 'return');
  if (!outRide || ((pickup || synthetic.returnMs !== undefined) && !retRide)) return null;
  const weekMs = input.week.startMs;
  const departSlot = toSlotFloor(synthetic.departureMs as number, weekMs);
  const returnSlot = synthetic.returnMs === undefined ? undefined : toSlotFloor(synthetic.returnMs, weekMs);
  const day = dayBoundsForSlot(input.week.days, departSlot);
  const arriveSlot = toSlotFloor(alt.arriveByMs, weekMs);
  const pickupSlot = alt.pickupMs === undefined ? undefined : toSlotFloor(alt.pickupMs, weekMs);
  const place = placeName(input, alt.dropPlaceId, alt.dropPlaceText);
  const pickupPlace = pickup ? placeName(input, alt.pickupPlaceId, alt.pickupPlaceText) : '';
  const text = reason('SUGGEST_USE_ALTERNATIVE', {
    place,
    arrive: formatSlotTime(arriveSlot, day),
    pickup: pickupSlot === undefined ? '' : pickup
      ? reason('SUGGEST_USE_ALTERNATIVE_PICKUP_FROM', { pickupPlace, pickup: formatSlotTime(pickupSlot, day) })
      : reason('SUGGEST_USE_ALTERNATIVE_PICKUP', { pickup: formatSlotTime(pickupSlot, day) }),
  });
  return {
    kind: 'useAlternative',
    requestId: r.id,
    carId: outRide.carId,
    ...(retRide && retRide.carId !== outRide.carId ? { returnCarId: retRide.carId } : {}),
    departSlot,
    ...(returnSlot !== undefined ? { returnSlot } : {}),
    reasonCode: 'SUGGEST_USE_ALTERNATIVE',
    reason: text,
    cost: 0,
    confidence: 0.45,
  };
}

/** Insert point: after every placement-type suggestion, before the external hints and the deny. */
function withSuggestion(list: Suggestion[], suggestion: Suggestion): Suggestion[] {
  const at = list.findIndex((s) => s.kind === 'externalHint' || s.kind === 'deny');
  if (at < 0) return [...list, suggestion];
  return [...list.slice(0, at), suggestion, ...list.slice(at)];
}

export function applyFallbacks(input: SolverInput, output: SolverOutput, solveBase: SolveFn): SolverOutput {
  if (!input.requests.some((r) => r.fallback === 'alternative' || r.fallback === 'manage')) return output;
  const byRequest = new Map(input.requests.map((r) => [r.id, r]));
  let changed = false;
  const unmet: UnmetRequest[] = output.unmet.map((u) => {
    const r = byRequest.get(u.requestId);
    if (!r || !r.fallback || r.fallback === 'none') return u;
    if (r.fallback === 'manage') {
      const suggestions = u.suggestions.filter((s) => s.kind !== 'externalHint');
      if (suggestions.length === u.suggestions.length) return u;
      changed = true;
      return { ...u, suggestions };
    }
    const suggestion = tryAlternative(input, output, r, solveBase);
    if (!suggestion) return u;
    changed = true;
    return { ...u, suggestions: withSuggestion(u.suggestions, suggestion) };
  });
  return changed ? { ...output, unmet } : output;
}
