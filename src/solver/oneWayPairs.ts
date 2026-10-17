// src/solver/oneWayPairs.ts
//
// R8B14 (pilot fix round 2026-10): complementary explicit one-way legs (`X -> Y` and `Y -> X`, same
// day, different members) that the single-leg greedy pass cannot place alone. A lone `X -> Y` leg
// would strand the car's next ride (which starts at X), and the lone `Y -> X` leg finds no car at
// Y, so each blocks the other. Placed together on ONE car they cancel out: the first leg leaves
// the car at Y, the second brings it back to X. Pure; mutates `timelines` like the greedy pass.
//
// Each member drives their own leg (a one-way request always has an eligible driver on board; a
// non-driver's one-way is a drop-off and never reaches here). The car waits at Y between the two
// legs; like a relay pair the two blocks need no turnaround buffer between them (CarTimeline
// `relayPairId`). Simplification (docs/SOLVER.md §3.6.1d): the wait is not tested for
// contention (REQ §13.103a) because the alternative is two unplaced members; the Sadran sees both
// rides and decides. Times: each leg may shift inside its declared departure flexibility, the
// smallest total shift wins, then car id.
//
// REQ item 136 (d) (SOLVER §3.6.1d): the same member's out X -> Y and later back Y' -> X are one trip
// (same day or across a night; Y' may be a nearby place), a one-leg drop-off whose relay partner never
// came can join as well. Overnight pairs and any pair with a drop-off leg need the wait to be
// uncontested (`waitContested`); a same-day explicit one-way pair keeps the no-test simplification.

import { reason } from './reasons';
import { travelBetween } from './travel';
import { waitContested } from './relay';
import { memberName, placeName } from './names';
import type { NormalizedRequest } from './slots';
import type { RelayPair } from './relay';
import { byId, dayBoundsForSlot, eligibleDriverMemberId, formatSlotTime, withinRequestDay } from './slots';
import { fits, luggageFits } from './seatFit';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';

export interface OneWayPairResult {
  healed: Assignment[];
  healedIds: Set<string>;
}

function isLoneLeg(nr: NormalizedRequest): boolean {
  const leg = nr.legs[0];
  if (!leg || nr.legs.length !== 1 || leg.side === 'both' || leg.originId === leg.destinationId) return false;
  if (nr.request.destinationIsFreeText || nr.request.originIsFreeText) return false;
  if (eligibleDriverMemberId(nr.request) === undefined) return false;
  // an explicit one-way, or a one-leg drop-off relay candidate that stayed unpaired
  return nr.tripType === 'one_way' || (leg.preferredMode === 'relay' && (leg.side === 'out' || leg.side === 'return'));
}

function startsByDistance(nr: NormalizedRequest): number[] {
  const [lo, hi] = nr.flexDep;
  const out: number[] = [];
  for (let s = Math.min(lo, nr.window.start); s <= Math.max(hi, nr.window.start); s++) out.push(s);
  out.sort((a, b) => Math.abs(a - nr.window.start) - Math.abs(b - nr.window.start) || a - b);
  return out;
}

function pairId(a: string, b: string): string {
  return `oneway:${a}:${b}`;
}

interface OutAndBackCandidate { first: NormalizedRequest; second: NormalizedRequest; hop: number; needsWaitCheck: boolean }

/** Candidate (out, back) legs of item 136 (d): geometry, free text, day order, the nearby-place hop. */
function outAndBackCandidates(lone: NormalizedRequest[], input: SolverInput): OutAndBackCandidate[] {
  const candidates: OutAndBackCandidate[] = [];
  const maxHopMinutes = input.config.detour.maxMinutes;
  const maxHopKm = input.config.detour.maxKm;
  for (const a of lone) {
    for (const b of lone) {
      if (a.id === b.id) continue;
      const sameMember = a.request.memberId === b.request.memberId;
      const la = a.legs[0]!;
      const lb = b.legs[0]!;
      if (la.originId !== lb.destinationId) continue;
      // the back leg starts at the out leg's destination, or (same member only) at a nearby place
      let hop = 0;
      if (la.destinationId !== lb.originId) {
        if (!sameMember || b.request.originIsFreeText) continue;
        const t = travelBetween(input, la.destinationId, lb.originId);
        if (t.minutes > maxHopMinutes || (t.km !== undefined && t.km > maxHopKm)) continue;
        hop = Math.max(1, Math.ceil(t.minutes / 15));
      }
      const crossDay = a.dayIndex !== b.dayIndex;
      if (crossDay && (!sameMember || b.dayIndex < a.dayIndex)) continue;
      // `a` goes first: it must be able to leave no later than `b` can (its window starts first).
      if (!crossDay && (a.window.start > b.window.start || (a.window.start === b.window.start && a.id > b.id))) continue;
      const dropOff = (nr: NormalizedRequest): boolean => nr.tripType !== 'one_way';
      candidates.push({ first: a, second: b, hop, needsWaitCheck: crossDay || dropOff(a) || dropOff(b) });
    }
  }
  return candidates;
}

export function pairComplementaryOneWays(
  unmet: NormalizedRequest[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  carsById: Map<string, Car>,
  scores: Map<string, { total: number }>,
  /** every normalized request (demand for the wait-contention test); absent = no demand known */
  all: readonly NormalizedRequest[] = [],
): OneWayPairResult {
  const healed: Assignment[] = [];
  const healedIds = new Set<string>();
  const sharedCars = input.cars.filter((c) => c.type === 'shared').sort((a, b) => byId({ id: a.id }, { id: b.id }));
  const lone = unmet.filter(isLoneLeg);
  const score = (nr: NormalizedRequest): number => scores.get(nr.id)?.total ?? 0;

  const candidates = outAndBackCandidates(lone, input);
  candidates.sort((x, y) => {
    const sx = Math.max(score(x.first), score(x.second));
    const sy = Math.max(score(y.first), score(y.second));
    if (sx !== sy) return sy - sx;
    if (x.first.id !== y.first.id) return byId({ id: x.first.id }, { id: y.first.id });
    return byId({ id: x.second.id }, { id: y.second.id });
  });

  const used = new Set<string>();
  const sharedCount = sharedCars.length;
  for (const { first, second, hop, needsWaitCheck } of candidates) {
    if (used.has(first.id) || used.has(second.id)) continue;
    if (needsWaitCheck && waitContested(all, first.window.end, second.window.start - hop, [first, second], sharedCount)) continue;
    const la = first.legs[0]!;
    const lb = second.legs[0]!;
    const pid = pairId(first.id, second.id);

    const combos: { sa: number; sb: number; cost: number }[] = [];
    for (const sa of startsByDistance(first)) {
      for (const sb of startsByDistance(second)) {
        combos.push({ sa, sb, cost: Math.abs(sa - first.window.start) + Math.abs(sb - second.window.start) });
      }
    }
    combos.sort((x, y) => x.cost - y.cost || x.sa - y.sa || x.sb - y.sb);

    let chosen: { carId: string; wa: Window; wb: Window; wbCar: Window } | null = null;
    for (const combo of combos) {
      const wa: Window = { start: combo.sa, end: combo.sa + first.minDurationSlots };
      const wb: Window = { start: combo.sb, end: combo.sb + second.minDurationSlots };
      // the back block starts `hop` slots early: the empty drive from the out leg's place to the back leg's
      // place (0 when it is the same place), so the car's chain stays Y -> Y' -> X (SOLVER §3.6.1d)
      const wbCar: Window = { start: wb.start - hop, end: wb.end };
      if (wa.end > wbCar.start) continue;
      if (!withinRequestDay(first, wa) || !withinRequestDay(second, wbCar)) continue;
      for (const car of sharedCars) {
        if (!fits(car, first.passengers) || !luggageFits(car, first.luggage ? 1 : 0)) continue;
        if (!fits(car, second.passengers) || !luggageFits(car, second.luggage ? 1 : 0)) continue;
        const tl = timelines.get(car.id);
        if (!tl || !tl.isFree(wa, la.originId)) continue;
        tl.add({ rideId: `ride:${first.id}`, window: wa, startLocationId: la.originId, endLocationId: la.destinationId, overnightAck: false, relayPairId: pid });
        if (tl.isFree(wbCar, la.destinationId, pid, lb.destinationId)) {
          tl.remove(`ride:${first.id}`);
          chosen = { carId: car.id, wa, wb, wbCar };
          break;
        }
        tl.remove(`ride:${first.id}`);
      }
      if (chosen) break;
    }
    if (!chosen) continue;

    const tl = timelines.get(chosen.carId);
    if (!tl) continue;
    tl.add({ rideId: `ride:${first.id}`, window: chosen.wa, startLocationId: la.originId, endLocationId: la.destinationId, overnightAck: false, relayPairId: pid });
    tl.add({ rideId: `ride:${second.id}`, window: chosen.wbCar, startLocationId: la.destinationId, endLocationId: lb.destinationId, overnightAck: false, relayPairId: pid });

    const car = carsById.get(chosen.carId);
    const dayA = dayBoundsForSlot(input.week.days, chosen.wa.start);
    const dayB = dayBoundsForSlot(input.week.days, chosen.wb.end);
    const driverA = eligibleDriverMemberId(first.request);
    const driverB = eligibleDriverMemberId(second.request);
    const text = reason('PLACED_RELAY_PAIR', {
      car: car?.name ?? '',
      member: memberName(input, driverA ?? first.request.memberId),
      dest: placeName(input, la.destinationId, first.request.destinationText),
      dep: formatSlotTime(chosen.wa.start, dayA),
      partner: memberName(input, driverB ?? second.request.memberId),
      ret: formatSlotTime(chosen.wb.end, dayB),
    });
    const outDest = la.destinationId;
    const rideA = `ride:${first.id}`;
    const rideB = `ride:${second.id}`;
    const build = (nr: NormalizedRequest, rideId: string, pairedRideId: string, window: Window, driver: string | undefined, legStart: number = window.start): Assignment => {
      const leg = nr.legs[0]!;
      return {
        rideId,
        carId: chosen!.carId,
        window,
        // a hop makes the block start at the car's place (the out leg's destination), not at the member's
        originId: window.start === legStart ? leg.originId : outDest,
        destinationId: leg.destinationId,
        driverRequestId: nr.id,
        driverMemberId: driver,
        legs: [{
          requestId: nr.id,
          leg: leg.side === 'return' ? 'return' : 'out',
          carMode: 'relay',
          originId: leg.originId,
          destinationId: leg.destinationId,
          role: driver === nr.request.memberId ? 'driver' : 'passenger',
        }],
        servedRequestIds: [nr.id],
        passengers: nr.passengers,
        luggageCount: nr.luggage ? 1 : 0,
        shift: { departureMin: (legStart - nr.window.start) * 15, returnMin: 0 },
        pairedRideId,
        source: 'solver',
        reasonCode: 'PLACED_RELAY_PAIR',
        reason: text,
      };
    };
    healed.push(build(first, rideA, rideB, chosen.wa, driverA), build(second, rideB, rideA, chosen.wbCar, driverB, chosen.wb.start));
    used.add(first.id);
    used.add(second.id);
    healedIds.add(first.id);
    healedIds.add(second.id);
  }
  return { healed, healedIds };
}

/**
 * R8B14: why an unmet explicit one-way leg `X -> Y` is unmet, so the reason is TRUE.
 * `strands`: a fitting car stands at X and a window exists, but taking it would leave the car at Y
 * while its next ride starts at X (the old text then wrongly said "no car at X").
 * `atOrigin`: some fitting car is at X for part of the request's span (so "no car at X" is false).
 */
export function oneWayUnmetCause(
  nr: NormalizedRequest,
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
): { strands: boolean; atOrigin: boolean; awayAtWeekEnd: boolean } {
  const leg = nr.legs[0];
  if (!leg) return { strands: false, atOrigin: false, awayAtWeekEnd: false };
  const fitting = input.cars.filter((c) => c.type === 'shared' && fits(c, nr.passengers) && luggageFits(c, nr.luggage ? 1 : 0));
  let strands = false;
  let awayAtWeekEnd = false;
  let atOrigin = false;
  for (const car of fitting) {
    const tl = timelines.get(car.id);
    if (!tl) continue;
    const spanStart = Math.min(nr.flexDep[0], nr.window.start);
    const spanEnd = Math.max(nr.flexDep[1], nr.window.start) + nr.minDurationSlots;
    if (tl.gaps().some((g) => g.locationId === nr.originId && g.window.start < spanEnd && spanStart < g.window.end)) atOrigin = true;
    for (const gap of tl.gaps()) {
      if (gap.locationId !== nr.originId) continue;
      const start = Math.max(gap.window.start, spanStart, nr.dayWindow.start);
      const end = start + nr.minDurationSlots;
      if (end > Math.min(gap.window.end, nr.dayWindow.end) || start > Math.max(nr.flexDep[1], nr.window.start)) continue;
      if (!tl.isFree({ start, end }, nr.originId)) continue;
      if (!tl.isFree({ start, end }, nr.originId, undefined, leg.destinationId)) strands = true;
      else if (!tl.isFree({ start, end }, nr.originId, undefined, leg.destinationId, { baseAtWeekEnd: true })) awayAtWeekEnd = true;
    }
  }
  return { strands, atOrigin, awayAtWeekEnd };
}

/**
 * REQ item 136 (d) (SOLVER §3.6.1d), the greedy half: the SAME member's out `X -> Y` and later back `Y' -> X`
 * become one relay-style pair unit BEFORE the greedy pass, so the pair is ranked by the higher leg score and
 * is not left the leftover cars. Windows are the preferred ones; when the legs overlap the back leg shifts
 * later, then the out leg earlier, inside the declared departure flexibility (`tryPair` style). With a nearby
 * back place the pair's `returnWindow` is the car's block (starting `hop` slots before the member's departure
 * from Y'). Choice: smallest idle wait + shift, then ids; each leg joins at most one pair. A pair that
 * cannot be placed falls back to the post-pass and the ordinary healing paths.
 */
export function pairSameMemberOutAndBack(
  pool: NormalizedRequest[],
  input: SolverInput,
  all: readonly NormalizedRequest[],
): { pairs: RelayPair[]; usedIds: Set<string> } {
  const sharedCars = input.cars.filter((c) => c.type === 'shared');
  const lone = pool.filter(isLoneLeg);
  interface Built { first: NormalizedRequest; second: NormalizedRequest; pair: RelayPair; rank: number }
  const built: Built[] = [];
  for (const c of outAndBackCandidates(lone, input)) {
    const { first, second, hop } = c;
    if (first.request.memberId !== second.request.memberId) continue;
    if (!sharedCars.some((car) => fits(car, first.passengers)) || !sharedCars.some((car) => fits(car, second.passengers))) continue;
    if (c.needsWaitCheck && waitContested(all, first.window.end, second.window.start - hop, [first, second], sharedCars.length)) continue;
    let outW: Window = { start: first.window.start, end: first.window.end };
    let startB = second.window.start;
    let shiftSlots = 0;
    const need = outW.end - (startB - hop);
    if (need > 0) {
      const laterB = Math.max(0, second.flexDep[1] - startB);
      const retShift = Math.min(need, laterB);
      const outShift = need - retShift;
      if (outShift > Math.max(0, first.window.start - first.flexDep[0])) continue;
      startB += retShift;
      outW = { start: outW.start - outShift, end: outW.end - outShift };
      shiftSlots = need;
    }
    const retW: Window = { start: startB - hop, end: startB + second.minDurationSlots };
    if (!withinRequestDay(first, outW) || !withinRequestDay(second, retW)) continue;
    const la = first.legs[0]!;
    built.push({
      first, second,
      rank: retW.start - outW.end + shiftSlots * 15,
      pair: {
        id: `pair:${first.id}:${second.id}`,
        outRequestId: first.id,
        returnRequestId: second.id,
        originId: la.originId,
        destinationId: la.destinationId,
        outWindow: outW,
        returnWindow: retW,
        idleSlots: retW.start - outW.end,
        shiftCost: shiftSlots * 15,
        outAndBack: { returnLegOriginId: second.legs[0]!.originId, returnLegStart: startB },
      },
    });
  }
  built.sort((x, y) => x.rank - y.rank || byId({ id: x.first.id }, { id: y.first.id }) || byId({ id: x.second.id }, { id: y.second.id }));
  const usedIds = new Set<string>();
  const pairs: RelayPair[] = [];
  for (const b of built) {
    if (usedIds.has(b.first.id) || usedIds.has(b.second.id)) continue;
    usedIds.add(b.first.id);
    usedIds.add(b.second.id);
    pairs.push(b.pair);
  }
  return { pairs, usedIds };
}
