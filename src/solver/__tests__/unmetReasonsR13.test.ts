// R13B17 (docs/TODO.md QA run 13): an unmet reason names the real blocker, and its code matches its text.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { FixedRide } from '../types';

const HOME = 'home';

function busy(carId: string, start: number, end: number): FixedRide {
  return {
    id: `FX-${carId}`, carId, window: { start, end }, originId: HOME, destinationId: HOME,
    driverRequestId: `FXR-${carId}`, driverMemberId: 'owner',
    legs: [{ requestId: `FXR-${carId}`, leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
    servedRequestIds: [`FXR-${carId}`], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0,
    overnightAck: false, kind: 'pinned',
  } as FixedRide;
}

const trip = { destinationId: 'destA', departureMs: slotMs(36), returnMs: slotMs(52) };

describe('R13B17 unmet reasons name the real blocker', () => {
  it('large luggage while the big-trunk car is busy and a small car idles at the origin', () => {
    const out = solve(baseInput({
      cars: [makeCar('Yaris', { luggageCapacity: 0 }), makeCar('Octavia', { luggageCapacity: 1 })],
      requests: [makeRequest({ id: 'R1', luggage: true, ...trip })],
      fixedRides: [busy('Octavia', 30, 60)],
    }));
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u?.reasonCode).toBe('UNMET_LARGE_TRUNK_BUSY');
    expect(u?.reason).toContain('תא מטען גדול');
    expect(u?.reason).toContain('Octavia');
    expect(u?.reason).not.toContain('Yaris');
  });

  it('two child seats while the child-seat car is busy and other cars are free', () => {
    const out = solve(baseInput({
      cars: [makeCar('Plain'), makeCar('Kids', { seatConfigs: [passengers(3, 2, 0)] })],
      requests: [makeRequest({ id: 'R1', passengers: passengers(1, 2, 0), ...trip })],
      fixedRides: [busy('Kids', 30, 60)],
    }));
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u?.reasonCode).toBe('UNMET_NO_CAR_SEATS_BUSY');
    expect(u?.reason).toContain('Kids');
  });

  it('more people than the free cars seat', () => {
    const out = solve(baseInput({
      cars: [makeCar('Small'), makeCar('Van', { seatConfigs: [passengers(7, 0, 0)] })],
      requests: [makeRequest({ id: 'R1', passengers: passengers(6), ...trip })],
      fixedRides: [busy('Van', 30, 60)],
    }));
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u?.reasonCode).toBe('UNMET_SEATS_CARS_BUSY');
    expect(u?.reason).toContain('6');
    expect(u?.reason).toContain('Van');
  });

  it('every car busy: plain no-car text without a list of cars', () => {
    const out = solve(baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: [makeRequest({ id: 'R1', ...trip })],
      fixedRides: [busy('C1', 30, 60), { ...busy('C2', 30, 60), id: 'FX-C2b' }],
    }));
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u?.reasonCode).toBe('UNMET_NO_CAR');
    expect(u?.reason).not.toContain('C1');
    expect(u?.reason).not.toContain('חוסמים');
  });

  it('a car free only elsewhere still says there is no car at the origin', () => {
    const out = solve(baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', originId: 'destB', ...trip })],
    }));
    expect(out.unmet.find((x) => x.requestId === 'R1')?.reasonCode).toBe('UNMET_NO_CAR_AT_ORIGIN');
  });
});
