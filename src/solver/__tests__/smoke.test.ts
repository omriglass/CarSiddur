import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';

describe('solve() smoke test', () => {
  it('places a single simple round trip on the only car', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({
          id: 'R1',
          destinationId: 'destA',
          departureMs: slotMs(32), // 08:00
          returnMs: slotMs(48), // 12:00
          passengers: passengers(1),
        }),
      ],
    });

    const output = solve(input);
    expect(output.unmet).toHaveLength(0);
    expect(output.assignments).toHaveLength(1);
    expect(output.assignments[0]?.carId).toBe('C1');
    expect(output.assignments[0]?.reasonCode).toBe('PLACED_PREFERRED');
    expect(output.stats.served).toBe(1);
  });

  it('is deterministic across repeated runs and shuffled input arrays', () => {
    const input = baseInput({
      cars: [makeCar('C2'), makeCar('C1')],
      requests: [
        makeRequest({ id: 'R2', destinationId: 'destA', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'R1', destinationId: 'destB', departureMs: slotMs(40), returnMs: slotMs(56) }),
      ],
    });
    const shuffled = { ...input, cars: [...input.cars].reverse(), requests: [...input.requests].reverse() };

    const out1 = solve(input);
    const out2 = solve(shuffled);
    expect(out2).toEqual(out1);

    const out3 = solve(input);
    expect(out3).toEqual(out1);
  });
});
