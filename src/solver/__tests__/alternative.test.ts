// REQ §13.112 (a)/(b), docs/SOLVER.md §3.15 `useAlternative`: plan B ("תוכנית ב׳") and "אסתדר".
// The fallback pass runs after the main solve and never changes it: it only adds a `useAlternative` suggestion when the
// member's plan B (a הקפצה to a drop place, optionally with a pickup) would fit the board as it is left, and drops the
// external-hint suggestions of a request that says "אסתדר".
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, HOME, makeCar, makeDestinations, makeRequest, slotMs } from '../__fixtures__/gen';
import type { FixedRide, Request, SolverInput, Suggestion } from '../types';

const DROP = 'dropX';

function input(over: Partial<SolverInput> = {}): SolverInput {
  return baseInput({
    destinations: { ...makeDestinations(), [DROP]: { id: DROP, zone: 'zoneX', distanceKm: 8, travelMinutes: 15, name: 'Junction' } },
    ...over,
  });
}

/** A pinned ride that keeps the only car busy 08:00-12:00 at home (slots 32..48). */
function morningBlock(): FixedRide {
  return {
    id: 'FX', carId: 'C1', window: { start: 32, end: 48 }, originId: HOME, destinationId: HOME,
    driverRequestId: 'OTHER', driverMemberId: 'owner',
    legs: [{ requestId: 'OTHER', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
    servedRequestIds: ['OTHER'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0, overnightAck: false, kind: 'pinned',
  };
}

/** The main trip collides with the morning block; the plan B (16:00 drop, 18:00 pickup) is in a free afternoon. */
function member(over: Partial<Request> = {}): Request {
  return makeRequest({
    id: 'R1', memberId: 'm1', departureMs: slotMs(36), returnMs: slotMs(44),
    fallback: 'alternative',
    alternative: { dropPlaceId: DROP, arriveByMs: slotMs(64), pickupMs: slotMs(72) },
    ...over,
  });
}

const kinds = (s: Suggestion[]) => s.map((x) => x.kind);

describe('plan B (useAlternative)', () => {
  it('suggests the plan B when the main request is unmet and the הקפצה fits, without placing anything', () => {
    const out = solve(input({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [member()] }));
    const u = out.unmet.find((x) => x.requestId === 'R1')!;
    expect(u).toBeDefined();
    const alt = u.suggestions.find((s) => s.kind === 'useAlternative');
    expect(alt).toMatchObject({ kind: 'useAlternative', requestId: 'R1', carId: 'C1', departSlot: 63, returnSlot: 73, reasonCode: 'SUGGEST_USE_ALTERNATIVE' });
    // the main solve is untouched: only the fixed ride is on the board
    expect(out.assignments.map((a) => a.rideId)).toEqual(['FX']);
    expect(out.stats.served).toBe(1);   // only the fixed ride's own request
    // ordered before the external hints and the deny
    const order = kinds(u.suggestions);
    expect(order.indexOf('useAlternative')).toBeLessThan(order.indexOf('deny'));
    if (order.includes('externalHint')) expect(order.indexOf('useAlternative')).toBeLessThan(order.indexOf('externalHint'));
    expect(order[order.length - 1]).toBe('deny');
  });

  it('names the drop place, the arrival and the pickup in the reason (no ids)', () => {
    const out = solve(input({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [member()] }));
    const alt = out.unmet[0]!.suggestions.find((s) => s.kind === 'useAlternative')!;
    expect(alt.reason).toContain('Junction');
    expect(alt.reason).toContain('16:00');
    expect(alt.reason).toContain('18:00');
    expect(alt.reason).not.toContain(DROP);
  });

  it('a plan B without a pickup is a single drop-off leg', () => {
    const r = member({ alternative: { dropPlaceId: DROP, arriveByMs: slotMs(64) } });
    const out = solve(input({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [r] }));
    const alt = out.unmet[0]!.suggestions.find((s) => s.kind === 'useAlternative');
    expect(alt).toMatchObject({ carId: 'C1', departSlot: 63 });
    expect((alt as { returnSlot?: number }).returnSlot).toBeUndefined();
  });

  it('no suggestion when the plan B does not fit either (car busy in the afternoon too)', () => {
    const afternoon: FixedRide = { ...morningBlock(), id: 'FX2', window: { start: 56, end: 80 }, driverRequestId: 'OTHER2', servedRequestIds: ['OTHER2'],
      legs: [{ requestId: 'OTHER2', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }] };
    const out = solve(input({ cars: [makeCar('C1')], fixedRides: [morningBlock(), afternoon], requests: [member()] }));
    expect(kinds(out.unmet[0]!.suggestions)).not.toContain('useAlternative');
  });

  it('no suggestion when the main request is placed (nothing is unmet)', () => {
    const r = member({ departureMs: slotMs(56), returnMs: slotMs(64) });
    const out = solve(input({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [r] }));
    expect(out.unmet).toHaveLength(0);
    expect(out.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(true);
  });

  it('only for fallback "alternative", a round trip / one way, and never a multi-day series', () => {
    const base = { cars: [makeCar('C1')], fixedRides: [morningBlock()] };
    for (const r of [
      member({ fallback: 'none' }),
      member({ fallback: undefined }),
      member({ tripType: 'drop_off', tripShape: 'one_way_to', returnMs: undefined, needsCarAtDestination: false }),
      member({ seriesId: 's', seriesIndex: 1, seriesCount: 2 }),
    ]) {
      const out = solve(input({ ...base, requests: [r] }));
      for (const u of out.unmet) expect(kinds(u.suggestions)).not.toContain('useAlternative');
    }
  });

  it('is deterministic and independent per request (two members with the same plan B each get it)', () => {
    const r2 = member({ id: 'R2', memberId: 'm2' });
    const i = input({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [member(), r2] });
    const a = solve(i);
    const b = solve(i);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const withAlt = a.unmet.filter((u) => kinds(u.suggestions).includes('useAlternative')).map((u) => u.requestId);
    expect(withAlt).toEqual(['R1', 'R2']);
  });

  it('the plan B uses the member own origin when it is not the home', () => {
    const r = member({ originId: 'destB', alternative: { dropPlaceId: DROP, arriveByMs: slotMs(64), pickupMs: slotMs(72) } });
    const out = solve(input({
      cars: [makeCar('C1', { startLocationId: 'destB' })], fixedRides: [],
      requests: [r, makeRequest({ id: 'BLOCK', memberId: 'mb', originId: 'destB', departureMs: slotMs(32), returnMs: slotMs(48) })],
    }));
    // whatever happens to BLOCK, the plan B (when offered) leaves from the member's own origin: the drive back is destB <-> DROP (default 60 min)
    const alt = out.unmet.find((u) => u.requestId === 'R1')?.suggestions.find((s) => s.kind === 'useAlternative') as { departSlot: number } | undefined;
    if (alt) expect(alt.departSlot).toBe(64 - 4);
  });
});

describe('plan B with a pickup from another place (REQ §13.112 a)', () => {
  const PICK = 'pickX';
  const withPickup = (over: Partial<SolverInput> = {}) => input({
    destinations: { ...makeDestinations(), [DROP]: { id: DROP, zone: 'zoneX', travelMinutes: 15, name: 'Junction' }, [PICK]: { id: PICK, zone: 'zoneY', travelMinutes: 30, name: 'Karkur' } },
    ...over,
  });
  const plan = (extra = {}) => member({ alternative: { dropPlaceId: DROP, arriveByMs: slotMs(64), pickupMs: slotMs(72), pickupPlaceId: PICK, ...extra } });

  it('prices the pickup leg from the pickup place (the car drives there first) and offers both legs, no return slot', () => {
    const out = solve(withPickup({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [plan()] }));
    const alt = out.unmet[0]!.suggestions.find((s) => s.kind === 'useAlternative') as { carId: string; departSlot: number; returnSlot?: number; reason: string } | undefined;
    expect(alt).toMatchObject({ carId: 'C1', departSlot: 63 });
    expect(alt!.returnSlot).toBeUndefined();
    expect(alt!.reason).toContain('Karkur');
    expect(alt!.reason).toContain('18:00');
  });
  it('is not offered when the pickup leg does not fit (car busy at the pickup time)', () => {
    const busy: FixedRide = { ...morningBlock(), id: 'FX3', window: { start: 66, end: 80 }, driverRequestId: 'O3', servedRequestIds: ['O3'],
      legs: [{ requestId: 'O3', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }] };
    const out = solve(withPickup({ cars: [makeCar('C1')], fixedRides: [morningBlock(), busy], requests: [plan()] }));
    expect(kinds(out.unmet[0]!.suggestions)).not.toContain('useAlternative');
  });
  it('a free-text pickup place is never offered', () => {
    const out = solve(withPickup({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [plan({ pickupPlaceId: undefined, pickupPlaceIsFreeText: true, pickupPlaceText: 'somewhere' })] }));
    expect(kinds(out.unmet[0]!.suggestions)).not.toContain('useAlternative');
  });
});

describe('"אסתדר" (fallback manage)', () => {
  const unmetInput = (r: Request) => input({ cars: [makeCar('C1')], fixedRides: [morningBlock()], requests: [r] });

  it('drops the external-hint suggestions; the deny stays', () => {
    const plain = solve(unmetInput(makeRequest({ id: 'R1', departureMs: slotMs(36), returnMs: slotMs(44) })));
    expect(kinds(plain.unmet[0]!.suggestions)).toContain('externalHint');
    const out = solve(unmetInput(makeRequest({ id: 'R1', departureMs: slotMs(36), returnMs: slotMs(44), fallback: 'manage' })));
    const order = kinds(out.unmet[0]!.suggestions);
    expect(order).not.toContain('externalHint');
    expect(order).not.toContain('useAlternative');
    expect(order).toContain('deny');
  });

  it('keeps every other suggestion exactly as without the flag', () => {
    const base = makeRequest({ id: 'R1', departureMs: slotMs(36), returnMs: slotMs(44) });
    const plain = solve(unmetInput(base)).unmet[0]!.suggestions.filter((s) => s.kind !== 'externalHint');
    const manage = solve(unmetInput({ ...base, fallback: 'manage' })).unmet[0]!.suggestions;
    expect(manage).toEqual(plain);
  });
});
