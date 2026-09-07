import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { tryAutoApprove } from '../live';
import { CarTimeline } from '../timeline';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';

function preferredRequest(preferredCarId = 'preferred') {
  return makeRequest({ id: 'request', preferredCarId, departureMs: slotMs(32), returnMs: slotMs(48) });
}

describe('soft preferred car', () => {
  it('chooses a feasible preferred car before seat slack and the id tie-break, deterministically', () => {
    const input = baseInput({ cars: [makeCar('a-default'), makeCar('preferred', { seatConfigs: [passengers(7)] })], requests: [preferredRequest()] });
    expect(solve(input).assignments[0]?.carId).toBe('preferred');
    expect(solve({ ...input, cars: [...input.cars].reverse() })).toEqual(solve(input));
  });

  it('falls back when the preferred car is absent, blocked, or has insufficient seats', () => {
    const fallback = makeCar('fallback');
    for (const otherCars of [[], [makeCar('preferred', { maintenance: [{ start: 30, end: 50 }] })], [makeCar('preferred', { seatConfigs: [passengers(1)] })]]) {
      const input = baseInput({ cars: [fallback, ...otherCars], requests: [{ ...preferredRequest(), passengers: passengers(2) }] });
      expect(solve(input).assignments[0]?.carId).toBe('fallback');
      expect(solve(input).unmet).toHaveLength(0);
    }
  });

  it('does not prioritize a lower-ranked member merely because they requested the same car', () => {
    const input = baseInput({ cars: [makeCar('a-default'), makeCar('preferred')], requests: [
      { ...preferredRequest(), id: 'low', rideType: 'errands' },
      { ...preferredRequest(), id: 'high', rideType: 'healthcare', destinationId: 'destB' },
    ] });
    expect(solve(input).assignments.find((a) => a.servedRequestIds.includes('high'))?.carId).toBe('preferred');
    expect(solve(input).assignments.find((a) => a.servedRequestIds.includes('low'))?.carId).toBe('a-default');
  });

  it('uses the same preference for live auto-approval and still falls back around blocked cars', () => {
    const cars = [makeCar('a-default'), makeCar('preferred')];
    const input = baseInput({ cars });
    const timelines = Object.fromEntries(cars.map((car) => [car.id, new CarTimeline(car, 2, 96 * 7, input.homeLocationId)]));
    const args = { request: preferredRequest(), cars, timelines, config: input.config, stats: input.stats, week: input.week, homeLocationId: input.homeLocationId };
    expect(tryAutoApprove(args)?.carId).toBe('preferred');
    timelines.preferred!.add({ rideId: 'busy', window: { start: 30, end: 50 }, startLocationId: input.homeLocationId, endLocationId: input.homeLocationId, overnightAck: false });
    expect(tryAutoApprove(args)?.carId).toBe('a-default');
  });
});
