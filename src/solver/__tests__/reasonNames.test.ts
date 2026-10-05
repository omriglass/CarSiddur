// G1 (docs/TODO.md, owner feedback 2026-10-05; docs/SOLVER.md §3.13a): no
// rendered reason/suggestion/warning text may carry a raw id — cars, places
// and members are shown by name.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { placeName } from '../names';
import { baseInput, flex, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { Destination, SolverOutput } from '../types';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const HOME = id(1);
const D_A = id(10);
const D_B = id(11);
const D_PT = id(12);
const D_UNNAMED = id(13);

function destinations(): Record<string, Destination> {
  return {
    [HOME]: { id: HOME, zone: 'home', name: 'Home place' },
    [D_A]: { id: D_A, zone: 'zoneA', name: 'Place A', distanceKm: 20, travelMinutes: 30, publicTransportScore: 0.2 },
    [D_B]: { id: D_B, zone: 'zoneA', name: 'Place B', distanceKm: 22, travelMinutes: 30, publicTransportScore: 0.2 },
    [D_PT]: { id: D_PT, zone: 'zoneP', name: 'Place PT', distanceKm: 30, travelMinutes: 30, publicTransportScore: 0.95 },
    [D_UNNAMED]: { id: D_UNNAMED, zone: 'unknown' },
  };
}

function texts(out: SolverOutput): string[] {
  const t: string[] = [];
  for (const a of out.assignments) t.push(a.reason);
  for (const u of out.unmet) {
    t.push(u.reason);
    for (const s of u.suggestions) t.push(s.reason);
  }
  for (const m of out.mergeOpportunities) t.push(m.reason);
  for (const w of out.warnings) t.push(w.message);
  return t;
}

function scenario(): SolverOutput {
  const req = (n: number, extra: Parameters<typeof makeRequest>[0]) =>
    makeRequest({ id: id(100 + n), memberId: id(200 + n), memberName: `Member ${n}`, ...extra });
  const rt = (n: number, dest: string, d: number, r: number, extra = {}) =>
    req(n, { destinationId: dest, departureMs: slotMs(d), returnMs: slotMs(r), ...extra });
  const input = baseInput({
    homeLocationId: HOME,
    destinations: destinations(),
    cars: [makeCar(id(50), { name: 'Car One' }), makeCar(id(51), { name: 'Car Two' })],
    requests: [
      rt(1, D_A, 36, 52),
      rt(2, D_A, 36, 52),
      rt(3, D_A, 36, 52, { flexDeparture: flex(30, 30) }),
      rt(4, D_PT, 36, 52),
      rt(5, D_B, 37, 51, { passengers: passengers(2) }),
      req(6, { destinationId: D_A, tripShape: 'one_way_to', departureMs: slotMs(110) }),
      req(7, { destinationId: D_A, tripShape: 'one_way_to', departureMs: slotMs(111), canDrive: false }),
      req(8, { destinationId: D_B, tripShape: 'one_way_to', tripType: 'one_way', departureMs: slotMs(200), originId: D_A }),
      req(9, { destinationId: D_B, tripShape: 'round_trip', needsCarAtDestination: false, departureMs: slotMs(300), returnMs: slotMs(310) }),
      req(10, { destinationId: D_UNNAMED, destinationText: 'Free text town', departureMs: slotMs(36), returnMs: slotMs(52), tripShape: 'round_trip' }),
      req(11, { destinationId: D_A, tripShape: 'one_way_to', tripType: 'one_way', departureMs: slotMs(400) }),
    ],
  });
  return solve(input);
}

describe('reason texts never contain raw ids (G1)', () => {
  const out = scenario();
  const codes = new Set<string>();
  for (const a of out.assignments) codes.add(a.reasonCode);
  for (const u of out.unmet) {
    codes.add(u.reasonCode);
    for (const s of u.suggestions) codes.add(s.reasonCode);
  }
  for (const w of out.warnings) codes.add(w.code);

  it('covers unmet reasons, suggestions and warnings', () => {
    expect(out.unmet.length).toBeGreaterThan(0);
    expect(codes.has('UNMET_NO_CAR')).toBe(true);
    for (const c of ['SUGGEST_DENY', 'SUGGEST_EXTERNAL_PT', 'UNMET_NO_CAR_AT_ORIGIN', 'CAR_AWAY_AT_WEEK_END', 'PLACED_RELAY_PAIR']) {
      expect(codes.has(c), c).toBe(true);
    }
    expect([...codes].some((c) => c.startsWith('SUGGEST_MERGE'))).toBe(true);
  });

  it('no rendered text contains a uuid', () => {
    for (const t of texts(out)) expect(t, t).not.toMatch(UUID);
  });
});

describe('placeName()', () => {
  it('prefers the destination name, then the free-text label, never the id', () => {
    const input = baseInput({ destinations: destinations() });
    expect(placeName(input, D_A)).toBe('Place A');
    expect(placeName(input, D_UNNAMED, 'Free text town')).toBe('Free text town');
    expect(placeName(input, D_UNNAMED)).toBe('');
    expect(placeName(input, 'missing')).toBe('');
  });
});

