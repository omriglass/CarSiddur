import { describe, expect, it } from 'vitest';
import { publicTransport } from '../publicTransport';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';

function ctx(destinations = {}) {
  return { params: {}, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations, batch: { requests: [], size: 0 } };
}
function nrAt(destinationId: string) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ destinationId, departureMs: slotMs(32), returnMs: slotMs(48) })] });
  return normalize(input).normalized[0]!;
}

describe('rules/publicTransport', () => {
  it('is 1 - score', () => {
    const destinations = { destA: { id: 'destA', zone: 'z', publicTransportScore: 0.7 } };
    expect(publicTransport.score(ctx(destinations), nrAt('destA'))).toBeCloseTo(0.3);
  });

  it('unknown score defaults to 0.5', () => {
    const destinations = { destA: { id: 'destA', zone: 'z' } };
    expect(publicTransport.score(ctx(destinations), nrAt('destA'))).toBe(0.5);
  });

  it('validateParams always accepts (no params)', () => {
    expect(publicTransport.validateParams({ anything: true })).toEqual({});
  });
});
