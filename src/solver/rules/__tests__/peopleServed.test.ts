import { describe, expect, it } from 'vitest';
import { peopleServed } from '../peopleServed';
import { PolicyParamsError } from '../../types';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../../__fixtures__/gen';

function ctx(params = peopleServed.defaultParams, relayPairPeople?: Map<string, number>) {
  return {
    params,
    policy: { id: '', version: 1, rules: [] },
    stats: { fairness: {}, usualCarId: {} },
    destinations: {},
    batch: { requests: [], size: 0, relayPairPeople },
  };
}
function nrWith(p: ReturnType<typeof passengers>) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ passengers: p, departureMs: slotMs(32), returnMs: slotMs(48) })] });
  return normalize(input).normalized[0]!;
}

describe('rules/peopleServed', () => {
  it('(adults+childSeats+boosters-1) / cap, capped at 1', () => {
    expect(peopleServed.score(ctx({ cap: 4 }), nrWith(passengers(3, 0, 0)))).toBe(0.5); // 2/4
    expect(peopleServed.score(ctx({ cap: 4 }), nrWith(passengers(1, 0, 0)))).toBe(0); // solo driver
    expect(peopleServed.score(ctx({ cap: 2 }), nrWith(passengers(5, 0, 0)))).toBe(1); // capped
  });

  it('uses the combined relay-pair people count when present', () => {
    const nr = nrWith(passengers(1, 0, 0));
    const overrideMap = new Map([[nr.id, 3]]);
    expect(peopleServed.score(ctx({ cap: 4 }, overrideMap), nr)).toBe(0.75);
  });

  it('validateParams rejects a non-positive cap', () => {
    expect(() => peopleServed.validateParams({ cap: 0 })).toThrow(PolicyParamsError);
  });
});
