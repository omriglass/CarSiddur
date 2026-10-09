// Pilot fix round P2 (docs/PILOT_FIX_ROUND_2026-10.md): R7B2 chauffeur suggestions hidden by a flag,
// R8B13 one chauffeur-duration rule, R8B14 complementary one-way pairs and a true unmet reason.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { chauffeurTotalSlots } from '../travel';
import { baseInput, makeCar, makeDestinations, makeRequest, slotMs } from '../__fixtures__/gen';
import type { FixedRide, Request } from '../types';

const HOME = 'home';

function fixedHomeRide(carId: string, start: number, end: number): FixedRide {
  return {
    id: `FX-${carId}`, carId, window: { start, end }, originId: HOME, destinationId: HOME,
    driverRequestId: 'FXR', driverMemberId: 'owner',
    legs: [{ requestId: 'FXR', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
    servedRequestIds: ['FXR'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0,
    overnightAck: false, kind: 'pinned',
  } as FixedRide;
}

describe('R7B2: chauffeur suggestions are hidden unless config.chauffeurSuggestions', () => {
  const requests = (): Request[] => [
    makeRequest({ id: 'P', tripType: 'drop_off', tripShape: 'one_way_to', needsCarAtDestination: false, canDrive: false, departureMs: slotMs(36) }),
  ];
  it('no chauffeur suggestion by default (the placement itself is unaffected)', () => {
    const out = solve(baseInput({ cars: [makeCar('C1')], requests: requests() }));
    for (const u of out.unmet) expect(u.suggestions.some((s) => s.kind === 'chauffeur')).toBe(false);
  });
  it('a blocked unmet request gets no chauffeur card either way when the flag is off', () => {
    const cars = [makeCar('C1')];
    const input = baseInput({ cars, requests: requests(), fixedRides: [fixedHomeRide('C1', 34, 60)] });
    const off = solve(input);
    expect(off.unmet.flatMap((u) => u.suggestions).some((s) => s.kind === 'chauffeur')).toBe(false);
  });
});

describe('R8B13: the chauffeur duration is rounded once from exact minutes', () => {
  const destinations = { ...makeDestinations(), NET: { id: 'NET', zone: 'z', distanceKm: 30, travelMinutes: 31 } };
  it('chauffeurTotalSlots: 31 + 31 + 10 = 72 min = 5 slots (75 min), not 3 + 3 + 1 = 7', () => {
    const input = baseInput({ cars: [makeCar('C1')], destinations, requests: [makeRequest({ id: 'R', destinationId: 'NET', tripType: 'drop_off', tripShape: 'one_way_to', needsCarAtDestination: false, departureMs: slotMs(38) })] });
    const req = input.requests[0]!;
    expect(chauffeurTotalSlots(input, req, 'out', HOME, 'NET', 5, 10)).toBe(5);
  });
  it('solve(): the chauffeur ride to a 31-minute place lasts 75 minutes (matches SQL chauffeur_ride_minutes)', () => {
    const input = baseInput({
      cars: [makeCar('C1')], destinations,
      requests: [makeRequest({ id: 'R', destinationId: 'NET', tripType: 'drop_off', tripShape: 'one_way_to', needsCarAtDestination: false, canDrive: false, departureMs: slotMs(38) })],
    });
    const out = solve(input);
    const ride = out.assignments.find((a) => a.servedRequestIds.includes('R'));
    expect(ride).toBeDefined();
    expect(ride!.window).toEqual({ start: 38, end: 43 });
  });
});

describe('R8B14: complementary one-way legs', () => {
  // C1 has a later ride starting at home, so a lone home -> B one-way would strand it; the lone
  // B -> home leg finds no car at B. Together they cancel out.
  const cars = [makeCar('C1')];
  const out1 = makeRequest({ id: 'A', memberId: 'mA', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(32) });
  const back = makeRequest({ id: 'B', memberId: 'mB', tripType: 'one_way', tripShape: 'one_way_to', originId: 'destB', destinationId: HOME, departureMs: slotMs(44) });
  const withLaterRide = () => baseInput({ cars, requests: [out1, back], fixedRides: [fixedHomeRide('C1', 60, 72)] });

  it('places both legs on one car, each member driving their own leg', () => {
    const out = solve(withLaterRide());
    expect(out.unmet).toEqual([]);
    const a = out.assignments.find((x) => x.servedRequestIds.includes('A'));
    const b = out.assignments.find((x) => x.servedRequestIds.includes('B'));
    expect(a?.carId).toBe('C1');
    expect(b?.carId).toBe('C1');
    expect(a?.destinationId).toBe('destB');
    expect(b?.originId).toBe('destB');
    expect(a?.driverMemberId).toBe('mA');
    expect(b?.driverMemberId).toBe('mB');
    expect(a!.window.end).toBeLessThanOrEqual(b!.window.start);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(solve(withLaterRide()))).toBe(JSON.stringify(solve(withLaterRide())));
  });

  it('a lone leg that would strand the car says so, not "no car at the origin"', () => {
    const out = solve(baseInput({ cars, requests: [out1], fixedRides: [fixedHomeRide('C1', 60, 72)] }));
    expect(out.unmet.find((u) => u.requestId === 'A')?.reasonCode).toBe('UNMET_ONE_WAY_STRANDS_CAR');
  });

  it('a leg with no car anywhere near its origin still says there is no car at the origin', () => {
    const lone = makeRequest({ id: 'L', tripType: 'one_way', tripShape: 'one_way_to', originId: 'destB', destinationId: HOME, departureMs: slotMs(44) });
    const out = solve(baseInput({ cars, requests: [lone], fixedRides: [fixedHomeRide('C1', 60, 72)] }));
    expect(out.unmet.find((u) => u.requestId === 'L')?.reasonCode).toBe('UNMET_NO_CAR_AT_ORIGIN');
  });
});
