// REQ §13.112 (c), docs/SOLVER.md §3.7a: a `durationLocked` ("N hours somewhere between A and B") request is moved
// as one block everywhere the solver shifts a request — its length never changes.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bestPlacementWithinFlex } from '../flexibility';
import { solve } from '../index';
import { buildHostRides, findMergeHosts } from '../merge';
import { normalize } from '../slots';
import { buildTimelines, CarTimeline } from '../timeline';
import type { Assignment, Car, Request } from '../types';
import {
  baseInput,
  defaultConfig,
  defaultPolicy,
  defaultStats,
  flex,
  makeCar,
  makeDestinations,
  makeRequest,
  makeWeekDays,
  passengers,
  slotMs,
  WEEK_START_MS,
} from '../__fixtures__/gen';

const HOME = 'home';
const WEEK_SLOTS = 96 * 7;
const DAY = 96;

/** A window request: block [start, start+length) slots, slack `slackMin` later at both ends, early 0. */
function windowRequest(over: Partial<Request> & { start: number; length: number; slackMin: number }): Request {
  const { start, length, slackMin, ...rest } = over;
  return makeRequest({
    departureMs: slotMs(start),
    returnMs: slotMs(start + length),
    flexDeparture: flex(0, slackMin),
    flexReturn: flex(0, slackMin),
    durationLocked: true,
    ...rest,
  });
}

function normalizeOne(request: Request) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [request] });
  return normalize(input).normalized[0]!;
}

function busyCar(blocks: [number, number][]): CarTimeline {
  const tl = new CarTimeline(makeCar('C1'), 2, WEEK_SLOTS, HOME);
  blocks.forEach(([start, end], i) =>
    tl.add({ rideId: `b${i}`, window: { start, end }, startLocationId: HOME, endLocationId: HOME, overnightAck: false }),
  );
  return tl;
}

describe('durationLocked placement (bestPlacementWithinFlex)', () => {
  it('normalizes the lock only for a round trip', () => {
    expect(normalizeOne(windowRequest({ start: 32, length: 16, slackMin: 60 })).durationLocked).toBe(true);
    expect(normalizeOne(makeRequest({ departureMs: slotMs(32), returnMs: slotMs(48) })).durationLocked).toBeFalsy();
    expect(normalizeOne(windowRequest({ start: 32, length: 16, slackMin: 60, needsCarAtDestination: false })).durationLocked).toBe(false);
  });

  it('slides later as one block when the car is busy at the start, keeping the length', () => {
    const nr = normalizeOne(windowRequest({ start: 32, length: 16, slackMin: 120 })); // 08:00-12:00, may end by 14:00
    const tl = busyCar([[30, 34]]); // blocker overlapping the start; buffer 2 slots
    const placement = bestPlacementWithinFlex(tl, nr);
    expect(placement).not.toBeNull();
    expect(placement!.window.end - placement!.window.start).toBe(16);
    expect(placement!.window.start).toBe(36);
    expect(placement!.shift).toEqual({ departureMin: 60, returnMin: 60 });
  });

  it('an unlocked request in the same spot cannot slide (each end is clamped on its own and the block would shrink) — the lock adds the slide', () => {
    const nr = normalizeOne(makeRequest({
      departureMs: slotMs(32), returnMs: slotMs(48), flexDeparture: flex(0, 120), flexReturn: flex(0, 120),
    }));
    expect(bestPlacementWithinFlex(busyCar([[30, 34]]), nr)).toBeNull();
  });

  it('is infeasible when no start in the window leaves room for the whole block', () => {
    const nr = normalizeOne(windowRequest({ start: 32, length: 16, slackMin: 60 })); // latest block 36..52
    // Free gap [34, 50) is 16 slots after buffers... block of 16 needs [36,52): the car is busy from 50.
    expect(bestPlacementWithinFlex(busyCar([[30, 34], [50, 56]]), nr)).toBeNull();
  });

  it('never moves earlier than the window start (early slack 0), even when the car is free earlier', () => {
    const nr = normalizeOne(windowRequest({ start: 32, length: 16, slackMin: 120 }));
    const placement = bestPlacementWithinFlex(busyCar([]), nr);
    expect(placement!.window).toEqual({ start: 32, end: 48 });
  });

  it('the beyond-flexibility widening also moves both ends together', () => {
    const nr = normalizeOne(windowRequest({ start: 32, length: 16, slackMin: 0 }));
    const placement = bestPlacementWithinFlex(busyCar([[30, 34]]), nr, { widenMinutes: 120 });
    expect(placement).not.toBeNull();
    expect(placement!.window.end - placement!.window.start).toBe(16);
    expect(placement!.shift.departureMin).toBe(placement!.shift.returnMin);
  });

  it('respects the end of the day (the block must fit inside the request day)', () => {
    const nr = normalizeOne(windowRequest({ start: DAY - 20, length: 16, slackMin: 120 }));
    const placement = bestPlacementWithinFlex(busyCar([[DAY - 22, DAY - 18]]), nr);
    // after the blocker the block would end past midnight -> infeasible
    expect(placement).toBeNull();
  });
});

describe('durationLocked in solve()', () => {
  function week(requests: Request[], carCount = 1) {
    return baseInput({
      week: { startMs: WEEK_START_MS, days: makeWeekDays() },
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      cars: Array.from({ length: carCount }, (_, i) => makeCar(`C${i}`, { seatConfigs: [passengers(4, 0, 0)] })),
      requests,
    });
  }

  it('a window request displaced by another request is placed later with its exact length', () => {
    const blocker = makeRequest({ id: 'A-blocker', departureMs: slotMs(DAY + 32), returnMs: slotMs(DAY + 40), submittedAtMs: 0 });
    const locked = windowRequest({ id: 'B-window', start: DAY + 32, length: 16, slackMin: 180, submittedAtMs: 10 });
    const out = solve(week([blocker, locked]));
    const a = out.assignments.find((x) => x.servedRequestIds.includes('B-window'));
    expect(a).toBeDefined();
    expect(a!.window.end - a!.window.start).toBe(16);
    expect(a!.window.start).toBeGreaterThanOrEqual(DAY + 32);
    expect(a!.window.end).toBeLessThanOrEqual(DAY + 32 + 16 + 12);
  });

  it('property: every placed window request has exactly its length and lies inside [A, B]', () => {
    const arb = fc.record({
      lockedStart: fc.integer({ min: DAY + 24, max: DAY + 48 }),
      length: fc.integer({ min: 4, max: 24 }),
      slackSlots: fc.integer({ min: 1, max: 16 }),
      others: fc.array(
        fc.record({ start: fc.integer({ min: DAY + 20, max: DAY + 70 }), length: fc.integer({ min: 4, max: 20 }), slack: fc.constantFrom(0, 30, 60) }),
        { minLength: 0, maxLength: 10 },
      ),
      cars: fc.integer({ min: 1, max: 2 }),
    });
    fc.assert(
      fc.property(arb, ({ lockedStart, length, slackSlots, others, cars }) => {
        const locked = windowRequest({ id: 'Z-window', start: lockedStart, length, slackMin: slackSlots * 15, submittedAtMs: 5_000 });
        const rest = others.map((o, i) => makeRequest({
          id: `O${String(i).padStart(2, '0')}`, departureMs: slotMs(o.start), returnMs: slotMs(o.start + o.length),
          flexDeparture: flex(o.slack, o.slack), flexReturn: flex(o.slack, o.slack), submittedAtMs: i,
        }));
        const out = solve(week([...rest, locked], cars));
        for (const a of out.assignments) {
          if (!a.servedRequestIds.includes('Z-window')) continue;
          expect(a.window.end - a.window.start).toBe(length);
          expect(a.window.start).toBeGreaterThanOrEqual(lockedStart);
          expect(a.window.end).toBeLessThanOrEqual(lockedStart + length + slackSlots);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('durationLocked in merge candidates', () => {
  const cars: Car[] = [makeCar('C1', { seatConfigs: [passengers(4)] })];
  const common = () => ({
    destinations: { destA: { id: 'destA', zone: 'zoneA', distanceKm: 20, travelMinutes: 30 }, bus: { id: 'bus', zone: 'zoneA', distanceKm: 5, travelMinutes: 10 } },
    config: defaultConfig(),
    cars: new Map(cars.map((c) => [c.id, c])),
    hostTimelines: buildTimelines(cars, 2, WEEK_SLOTS, HOME),
    homeLocationId: HOME,
    travel: [
      { fromId: HOME, toId: 'bus', travelMinutes: 15, distanceKm: 5 },
      { fromId: 'bus', toId: 'destA', travelMinutes: 30, distanceKm: 20 },
    ],
  });
  const host = (): Assignment => ({
    rideId: 'host-ride', carId: 'C1', window: { start: 32, end: 48 }, originId: HOME, destinationId: HOME,
    driverRequestId: 'HOST', driverMemberId: 'host-member',
    legs: [{ requestId: 'HOST', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
    servedRequestIds: ['HOST'], passengers: passengers(1), luggageCount: 0, shift: { departureMin: 0, returnMin: 0 },
    source: 'solver', reasonCode: 'PLACED_PREFERRED', reason: 'x',
  });
  const run = (hostLocked: boolean, guestOver: Partial<Request>) => {
    const hostRequest = hostLocked
      ? windowRequest({ id: 'HOST', start: 32, length: 16, slackMin: 60 })
      : makeRequest({ id: 'HOST', departureMs: slotMs(32), returnMs: slotMs(48), flexDeparture: flex(0, 60), flexReturn: flex(0, 60) });
    const hostNr = normalizeOne(hostRequest);
    const guest = normalizeOne(makeRequest({ id: 'GUEST', departureMs: slotMs(30), returnMs: slotMs(48), ...guestOver }));
    return findMergeHosts({
      guest, leg: 'out', hosts: buildHostRides([host()], new Map(cars.map((c) => [c.id, c]))),
      hostDriverRequests: new Map([['host-ride', hostNr]]), ...common(),
    });
  };

  it('a merge that adds driving would grow a window host: refused (an unlocked host takes it, starting earlier)', () => {
    const guestOver = { originId: 'bus', destinationId: 'destA', flexDeparture: flex(60, 60) };
    expect(run(false, guestOver)).toHaveLength(1);
    expect(run(true, guestOver)).toHaveLength(0);
  });

  it('a zero-detour merge into a window host is fine, and the host shifts as one block when the guest needs it', () => {
    const guestOver = { destinationId: 'destA', departureMs: slotMs(34), returnMs: slotMs(50), flexDeparture: flex(0, 0), flexReturn: flex(0, 0), tripShape: 'one_way_to' as const };
    const candidates = run(true, guestOver);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.window.end - c.window.start).toBe(16);
    if (c.hostShift) expect(c.hostShift.departureMin).toBe(c.hostShift.returnMin);
  });

  it('a window guest riding along must get at least its block of time (host ride shorter: refused; an ordinary guest is fine)', () => {
    const hostNr = normalizeOne(makeRequest({ id: 'HOST', departureMs: slotMs(32), returnMs: slotMs(48) }));
    const search = (durationLocked: boolean) => {
      // synthetic guest: 32..56 with its return allowed 2 h earlier, so the host's 32..48 is inside its envelope
      const guest = normalizeOne(makeRequest({ id: 'GUEST', destinationId: 'destA', departureMs: slotMs(32), returnMs: slotMs(56), durationLocked, flexDeparture: flex(0, 0), flexReturn: flex(120, 0) }));
      return findMergeHosts({ guest, leg: 'both', hosts: buildHostRides([host()], new Map(cars.map((c) => [c.id, c]))), hostDriverRequests: new Map([['host-ride', hostNr]]), ...common() });
    };
    expect(search(false)).toHaveLength(1);
    expect(search(true)).toHaveLength(0);
  });
});
