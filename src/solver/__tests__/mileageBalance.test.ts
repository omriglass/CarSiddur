// F5 (docs/TODO.md "Solver: spread rides across cars to balance mileage";
// owner A11/A12 2026-09-14; docs/SOLVER.md §3.6.2): the mileage tie-break in
// greedy.ts's car-choice key. Every case below keeps every other
// consideration (preferred car, seat fit, continuity, fragmentation) tied on
// purpose, so mileage is the only thing left that *can* decide — exactly the
// "otherwise equally acceptable" condition the feature is scoped to.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, defaultConfig, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';
import type { SolverInput } from '../types';

describe('F5 mileage balancing (docs/SOLVER.md §3.6.2)', () => {
  it('prefers the less-driven car when every other consideration ties, and tags the reason', () => {
    const cars = [makeCar('C1', { mileageKm: 100 }), makeCar('C2', { mileageKm: 20 })];
    const requests = [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })];
    const input = baseInput({ cars, requests, config: defaultConfig() });

    const output = solve(input);

    const a = output.assignments.find((x) => x.servedRequestIds.includes('R1'));
    expect(a?.carId).toBe('C2');
    expect(a?.reasonCode).toBe('CAR_BALANCED_MILEAGE');
    expect(a?.reason).toContain('C2');
  });

  it('is a no-op (byte-for-byte identical output) when no car carries mileageKm', () => {
    const requests = [
      makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'R2', departureMs: slotMs(96 + 32), returnMs: slotMs(96 + 48) }),
    ];
    const withoutField = baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests, config: defaultConfig() });
    const withUndefinedMileage = baseInput({
      cars: [makeCar('C1', { mileageKm: undefined }), makeCar('C2', { mileageKm: undefined })],
      requests,
      config: defaultConfig(),
    });

    expect(solve(withUndefinedMileage)).toEqual(solve(withoutField));
    // ... and every placement reason is the ordinary one — no car ever
    // carrying mileageKm must never produce CAR_BALANCED_MILEAGE.
    for (const a of solve(withoutField).assignments) {
      expect(a.reasonCode).not.toBe('CAR_BALANCED_MILEAGE');
    }
  });

  it('equal mileageKm on every car is exactly as inert as no mileageKm at all', () => {
    const requests = [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })];
    const equalMileage = baseInput({
      cars: [makeCar('C1', { mileageKm: 50 }), makeCar('C2', { mileageKm: 50 })],
      requests,
      config: defaultConfig(),
    });
    const noMileage = baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests, config: defaultConfig() });

    expect(solve(equalMileage)).toEqual(solve(noMileage));
  });

  it('never overrides an earlier consideration: a real shift-cost difference still wins even against a large mileage gap', () => {
    // C1 is busy at the preferred time (a fixed ride), so only a shifted
    // placement is possible there; C2 is free at the preferred time. C2 wins
    // on shiftCost alone (0 vs a real shift) regardless of carrying far more
    // mileage than C1 — shiftCost outranks mileage in the key, so mileage
    // must never be reported as having decided this one.
    const cars = [makeCar('C1', { mileageKm: 0 }), makeCar('C2', { mileageKm: 1000 })];
    const requests = [
      makeRequest({
        id: 'R1',
        departureMs: slotMs(32),
        returnMs: slotMs(48),
        flexDeparture: { earlierMin: 60, laterMin: 60 },
        flexReturn: { earlierMin: 60, laterMin: 60 },
      }),
    ];
    const input: SolverInput = {
      ...baseInput({ cars, requests, config: defaultConfig() }),
      fixedRides: [
        {
          id: 'fixed-1',
          carId: 'C1',
          window: { start: 30, end: 50 },
          originId: 'home',
          destinationId: 'home',
          driverMemberId: 'someone-else',
          legs: [],
          servedRequestIds: ['SOMEONE_ELSE'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
    };

    const output = solve(input);
    const a = output.assignments.find((x) => x.servedRequestIds.includes('R1'));
    expect(a?.carId).toBe('C2');
    expect(a?.reasonCode).not.toBe('CAR_BALANCED_MILEAGE');
  });

  it('balances two same-destination requests across two different days of the same solve (in-solve accumulation)', () => {
    // A maintenance block identical on both cars, mid-week, splits each car's
    // timeline into a "before" and "after" segment at the same boundary —
    // Sunday's request only touches the "before" segment, so Friday's
    // leftover "after" segment is exactly the same size on both cars
    // (fragmentation ties) regardless of which car took Sunday's ride. Both
    // cars opt in with a 0 km baseline (the feature is off when no car carries
    // `mileageKm` at all), so this isolates in-solve accumulation as the only
    // thing that can make the two requests land on different cars. Since
    // 2026-09-14 mileage ranks above fragmentation anyway, so the divider is
    // belt-and-braces rather than load-bearing.
    const divider = { start: 288 + 40, end: 288 + 56 }; // mid-Wednesday
    const cars = [
      makeCar('C1', { maintenance: [divider], mileageKm: 0 }),
      makeCar('C2', { maintenance: [divider], mileageKm: 0 }),
    ];
    // Unit processing order (score tied, same submittedAtMs) falls back to
    // ascending request id (docs/SOLVER.md §3.14) — name them so Sunday's
    // request is genuinely processed first, matching the narrative.
    const requests = [
      makeRequest({ id: 'A_SUN', departureMs: slotMs(32), returnMs: slotMs(48) }), // Sunday
      makeRequest({ id: 'B_FRI', departureMs: slotMs(5 * 96 + 32), returnMs: slotMs(5 * 96 + 48) }), // Friday, same destination
    ];
    const input = baseInput({ cars, requests, config: defaultConfig() });

    const output = solve(input);
    const sun = output.assignments.find((x) => x.servedRequestIds.includes('A_SUN'));
    const fri = output.assignments.find((x) => x.servedRequestIds.includes('B_FRI'));

    // Sunday is a plain tie (both cars start at 0 km) -> ordinary id tie-break.
    expect(sun?.carId).toBe('C1');
    expect(sun?.reasonCode).toBe('PLACED_PREFERRED');
    // Friday: C1 now carries Sunday's round trip in its running total, so the
    // less-driven C2 is preferred, and the reason says so.
    expect(fri?.carId).toBe('C2');
    expect(fri?.reasonCode).toBe('CAR_BALANCED_MILEAGE');
  });

  it('is deterministic: solving the same mileage-bearing input twice yields identical output', () => {
    const cars = [makeCar('C1', { mileageKm: 30 }), makeCar('C2', { mileageKm: 10 })];
    const requests = [
      makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'R2', departureMs: slotMs(96 + 32), returnMs: slotMs(96 + 48) }),
    ];
    const input = baseInput({ cars, requests, config: defaultConfig() });

    expect(solve(input)).toEqual(solve(input));
  });
});
