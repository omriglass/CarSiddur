// Chauffeur suggestion gating (docs/SOLVER.md §3.3, §3.11 item 5; owner decision
// 2026-09-14, docs/TODO.md "Chauffeur suggestion is not gated on a free shared car"):
// a `chauffeur` suggestion is offered only when some shared car is free at home for
// the whole standalone-chauffeur window (`[D, D + 2·travel + dwell)` for a drop-off,
// `[R − 2·travel − dwell, R)` for a pick-up) and its seat configuration fits
// `chauffeurLoad(nr.passengers)` — the requester's own load plus one adult for the
// volunteer.

import { describe, expect, it } from 'vitest';
import { buildSuggestions, type SuggestionContext } from '../suggestions';
import { normalize } from '../slots';
import { buildTimelines, type CarTimeline } from '../timeline';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { Car, Suggestion } from '../types';

const HOME = 'home';
const BUFFER_SLOTS = 2; // 30 min

function ctxFor(cars: Car[], requestOverrides: Parameters<typeof makeRequest>[0]): { ctx: SuggestionContext; nr: ReturnType<typeof normalize>['normalized'][number]; timelines: Map<string, CarTimeline> } {
  const input = baseInput({ cars, requests: [makeRequest({ id: 'R1', ...requestOverrides })] });
  const { normalized } = normalize(input);
  const nr = normalized[0]!;
  const timelines = buildTimelines(cars, BUFFER_SLOTS, 96 * 7, HOME);
  const ctx: SuggestionContext = {
    input,
    assignments: [],
    timelines,
    hostDriverRequests: new Map(),
    unpairedRelay: [],
    ejectionSuggestions: new Map(),
  };
  return { ctx, nr, timelines };
}

function chauffeurOf(suggestions: Suggestion[]) {
  return suggestions.find((s): s is Extract<Suggestion, { kind: 'chauffeur' }> => s.kind === 'chauffeur');
}

// destA: travelMinutes 30 -> travelSlots = 2; chauffeurDwellMinutes 10 -> dwellSlots = 1
// (defaultConfig, via baseInput/makeDestinations). Standalone chauffeur window width
// = 2*2 + 1 = 5 slots.

describe('chauffeur suggestion gating — isPassengerOnly (one_way_to, mode passenger)', () => {
  function passengerOutRequest(overrides: Parameters<typeof makeRequest>[0] = {}) {
    return {
      tripShape: 'one_way_to' as const,
      oneWayCarMode: 'passenger' as const,
      departureMs: slotMs(40),
      destinationId: 'destA',
      passengers: passengers(1),
      ...overrides,
    };
  }

  it('a free, seat-fitting shared car -> chauffeur suggested with that car and the standalone window', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(4)] });
    const { ctx, nr } = ctxFor([car], passengerOutRequest());
    const suggestions = buildSuggestions(nr, ctx, []);
    const chauffeur = chauffeurOf(suggestions);
    expect(chauffeur).toBeDefined();
    expect(chauffeur?.carId).toBe('C1');
    expect(chauffeur?.leg).toBe('out');
    expect(chauffeur?.window).toEqual({ start: 40, end: 45 });
  });

  it('every shared car busy for the chauffeur window -> not suggested', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(4)] });
    const { ctx, nr, timelines } = ctxFor([car], passengerOutRequest());
    // occupies home during [40,45) with plenty of margin either side
    timelines.get('C1')!.add({ rideId: 'busy', window: { start: 38, end: 47 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    const suggestions = buildSuggestions(nr, ctx, []);
    expect(chauffeurOf(suggestions)).toBeUndefined();
  });

  it('seats do not fit with the extra volunteer adult -> not suggested', () => {
    // car seats exactly 1 adult; requester alone (1 adult) + volunteer (1 adult) = 2, does not fit
    const car = makeCar('C1', { seatConfigs: [passengers(1)] });
    const { ctx, nr } = ctxFor([car], passengerOutRequest());
    const suggestions = buildSuggestions(nr, ctx, []);
    expect(chauffeurOf(suggestions)).toBeUndefined();
  });

  it('determinism: picks the lexicographically-first qualifying car regardless of input/iteration order', () => {
    // A1 does not fit; B2 fits but is busy; C3 fits and is free -> C3 wins.
    const a1 = makeCar('A1', { seatConfigs: [passengers(1)] });
    const b2 = makeCar('B2', { seatConfigs: [passengers(4)] });
    const c3 = makeCar('C3', { seatConfigs: [passengers(4)] });
    const { ctx, nr, timelines } = ctxFor([c3, a1, b2], passengerOutRequest());
    timelines.get('B2')!.add({ rideId: 'busy', window: { start: 38, end: 47 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    const suggestions1 = buildSuggestions(nr, ctx, []);
    const suggestions2 = buildSuggestions(nr, ctx, []);
    expect(chauffeurOf(suggestions1)?.carId).toBe('C3');
    expect(chauffeurOf(suggestions2)?.carId).toBe('C3');
  });
});

describe('chauffeur suggestion gating — isPassengerOnly (one_way_from, mode passenger)', () => {
  it('a free, seat-fitting shared car -> chauffeur suggested for the return leg', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(4)] });
    const { ctx, nr } = ctxFor([car], {
      tripShape: 'one_way_from',
      oneWayCarMode: 'passenger',
      returnMs: slotMs(80),
      destinationId: 'destA',
      passengers: passengers(1),
    });
    const suggestions = buildSuggestions(nr, ctx, []);
    const chauffeur = chauffeurOf(suggestions);
    expect(chauffeur).toBeDefined();
    expect(chauffeur?.carId).toBe('C1');
    expect(chauffeur?.leg).toBe('return');
    expect(chauffeur?.window).toEqual({ start: 75, end: 80 });
  });
});

describe('chauffeur suggestion gating — unpaired relay leg (one_way_from, mode relay)', () => {
  function relayReturnRequest(overrides: Parameters<typeof makeRequest>[0] = {}) {
    return {
      tripShape: 'one_way_from' as const,
      oneWayCarMode: 'relay' as const,
      returnMs: slotMs(80),
      destinationId: 'destA',
      passengers: passengers(1),
      ...overrides,
    };
  }

  it('a free, seat-fitting shared car -> chauffeur suggested alongside the relay leg', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(4)] });
    const { ctx, nr } = ctxFor([car], relayReturnRequest());
    const suggestions = buildSuggestions(nr, ctx, []);
    const chauffeur = chauffeurOf(suggestions);
    expect(chauffeur).toBeDefined();
    expect(chauffeur?.carId).toBe('C1');
    expect(chauffeur?.leg).toBe('return');
    expect(chauffeur?.window).toEqual({ start: 75, end: 80 });
  });

  it('every shared car busy for the chauffeur window -> not suggested', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(4)] });
    const { ctx, nr, timelines } = ctxFor([car], relayReturnRequest());
    timelines.get('C1')!.add({ rideId: 'busy', window: { start: 73, end: 82 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    const suggestions = buildSuggestions(nr, ctx, []);
    expect(chauffeurOf(suggestions)).toBeUndefined();
  });

  it('seats do not fit with the extra volunteer adult -> not suggested', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(1)] });
    const { ctx, nr } = ctxFor([car], relayReturnRequest());
    const suggestions = buildSuggestions(nr, ctx, []);
    expect(chauffeurOf(suggestions)).toBeUndefined();
  });
});
