import { describe, expect, it } from 'vitest';
import { chauffeurLoad, dominates, fits, luggageFits, slack, sum } from '../seatFit';
import { makeCar, passengers } from '../__fixtures__/gen';

describe('seatFit', () => {
  it('exact match dominates', () => {
    expect(dominates(passengers(4, 0, 0), passengers(4, 0, 0))).toBe(true);
  });

  it('dominance fails when only one component is short', () => {
    expect(dominates(passengers(4, 0, 0), passengers(4, 1, 0))).toBe(false);
    expect(dominates(passengers(3, 1, 0), passengers(4, 0, 0))).toBe(false);
  });

  it('a booster does not fit a child-seat position and vice versa', () => {
    const car = makeCar('c', { seatConfigs: [passengers(3, 1, 0)] });
    expect(fits(car, passengers(3, 0, 1))).toBe(false);
    expect(fits(car, passengers(3, 1, 0))).toBe(true);
  });

  it('a car with no seat configs never fits anyone', () => {
    const car = makeCar('c', { seatConfigs: [] });
    expect(fits(car, passengers(1, 0, 0))).toBe(false);
  });

  it('slack picks the minimal dominating configuration', () => {
    const car = makeCar('c', { seatConfigs: [passengers(7, 0, 0), passengers(4, 0, 0), passengers(5, 2, 0)] });
    expect(slack(car, passengers(4, 0, 0))).toBe(0); // exact match on {4,0,0}
    expect(slack(car, passengers(3, 0, 0))).toBe(1); // {4,0,0} beats {7,0,0} and {5,2,0}
  });

  it('slack is null when nothing fits', () => {
    const car = makeCar('c', { seatConfigs: [passengers(2, 0, 0)] });
    expect(slack(car, passengers(3, 0, 0))).toBeNull();
  });

  it('merged sum fits where singles fit but the sum does not', () => {
    const car = makeCar('c', { seatConfigs: [passengers(3, 1, 0)] });
    const host = passengers(2, 1, 0);
    const guest = passengers(1, 0, 0);
    expect(fits(car, host)).toBe(true);
    expect(fits(car, guest)).toBe(true);
    expect(fits(car, sum(host, guest))).toBe(true); // (3,1,0) exactly

    const guest2 = passengers(1, 1, 0);
    expect(fits(car, sum(host, guest2))).toBe(false); // (3,2,0) does not fit {3,1,0}
  });

  it('luggage fits up to the car capacity', () => {
    const car = makeCar('c', { luggageCapacity: 1 });
    expect(luggageFits(car, 1)).toBe(true);
    expect(luggageFits(car, 2)).toBe(false);
  });

  it('chauffeur load adds exactly one adult for the volunteer', () => {
    expect(chauffeurLoad(passengers(2, 1, 0))).toEqual({ adults: 3, childSeats: 1, boosters: 0 });
  });
});
