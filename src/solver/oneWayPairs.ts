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

import { reason } from './reasons';
import { memberName, placeName } from './names';
import type { NormalizedRequest } from './slots';
import { byId, dayBoundsForSlot, eligibleDriverMemberId, formatSlotTime, withinRequestDay } from './slots';
import { fits, luggageFits } from './seatFit';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';

export interface OneWayPairResult {
  healed: Assignment[];
  healedIds: Set<string>;
}

function isLoneOneWay(nr: NormalizedRequest): boolean {
  const leg = nr.legs[0];
  return (
    nr.tripType === 'one_way' &&
    nr.legs.length === 1 &&
    !!leg &&
    leg.side !== 'both' &&
    leg.originId !== leg.destinationId &&
    !nr.request.destinationIsFreeText &&
    eligibleDriverMemberId(nr.request) !== undefined
  );
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

export function pairComplementaryOneWays(
  unmet: NormalizedRequest[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  carsById: Map<string, Car>,
  scores: Map<string, { total: number }>,
): OneWayPairResult {
  const healed: Assignment[] = [];
  const healedIds = new Set<string>();
  const sharedCars = input.cars.filter((c) => c.type === 'shared').sort((a, b) => byId({ id: a.id }, { id: b.id }));
  const lone = unmet.filter(isLoneOneWay);
  const score = (nr: NormalizedRequest): number => scores.get(nr.id)?.total ?? 0;

  interface Candidate { first: NormalizedRequest; second: NormalizedRequest }
  const candidates: Candidate[] = [];
  for (const a of lone) {
    for (const b of lone) {
      if (a.id === b.id) continue;
      if (a.request.memberId === b.request.memberId) continue;
      const la = a.legs[0]!;
      const lb = b.legs[0]!;
      if (la.originId !== lb.destinationId || la.destinationId !== lb.originId) continue;
      if (a.dayIndex !== b.dayIndex) continue;
      // `a` goes first: it must be able to leave no later than `b` can (its window starts first).
      if (a.window.start > b.window.start || (a.window.start === b.window.start && a.id > b.id)) continue;
      candidates.push({ first: a, second: b });
    }
  }
  candidates.sort((x, y) => {
    const sx = Math.max(score(x.first), score(x.second));
    const sy = Math.max(score(y.first), score(y.second));
    if (sx !== sy) return sy - sx;
    if (x.first.id !== y.first.id) return byId({ id: x.first.id }, { id: y.first.id });
    return byId({ id: x.second.id }, { id: y.second.id });
  });

  const used = new Set<string>();
  for (const { first, second } of candidates) {
    if (used.has(first.id) || used.has(second.id)) continue;
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

    let chosen: { carId: string; wa: Window; wb: Window } | null = null;
    for (const combo of combos) {
      const wa: Window = { start: combo.sa, end: combo.sa + first.minDurationSlots };
      const wb: Window = { start: combo.sb, end: combo.sb + second.minDurationSlots };
      if (wa.end > wb.start) continue;
      if (!withinRequestDay(first, wa) || !withinRequestDay(second, wb)) continue;
      for (const car of sharedCars) {
        if (!fits(car, first.passengers) || !luggageFits(car, first.luggage ? 1 : 0)) continue;
        if (!fits(car, second.passengers) || !luggageFits(car, second.luggage ? 1 : 0)) continue;
        const tl = timelines.get(car.id);
        if (!tl || !tl.isFree(wa, la.originId)) continue;
        tl.add({ rideId: `ride:${first.id}`, window: wa, startLocationId: la.originId, endLocationId: la.destinationId, overnightAck: false, relayPairId: pid });
        if (tl.isFree(wb, lb.originId, pid, lb.destinationId)) {
          tl.remove(`ride:${first.id}`);
          chosen = { carId: car.id, wa, wb };
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
    tl.add({ rideId: `ride:${second.id}`, window: chosen.wb, startLocationId: lb.originId, endLocationId: lb.destinationId, overnightAck: false, relayPairId: pid });

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
    const rideA = `ride:${first.id}`;
    const rideB = `ride:${second.id}`;
    const build = (nr: NormalizedRequest, rideId: string, pairedRideId: string, window: Window, driver: string | undefined): Assignment => {
      const leg = nr.legs[0]!;
      return {
        rideId,
        carId: chosen!.carId,
        window,
        originId: leg.originId,
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
        shift: { departureMin: (window.start - nr.window.start) * 15, returnMin: 0 },
        pairedRideId,
        source: 'solver',
        reasonCode: 'PLACED_RELAY_PAIR',
        reason: text,
      };
    };
    healed.push(build(first, rideA, rideB, chosen.wa, driverA), build(second, rideB, rideA, chosen.wb, driverB));
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
): { strands: boolean; atOrigin: boolean } {
  const leg = nr.legs[0];
  if (!leg) return { strands: false, atOrigin: false };
  const fitting = input.cars.filter((c) => c.type === 'shared' && fits(c, nr.passengers) && luggageFits(c, nr.luggage ? 1 : 0));
  let strands = false;
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
      if (tl.isFree({ start, end }, nr.originId) && !tl.isFree({ start, end }, nr.originId, undefined, leg.destinationId)) strands = true;
    }
  }
  return { strands, atOrigin };
}
