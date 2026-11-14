// R20B5 (REQUIREMENTS item 234, docs/SOLVER.md §3.7b): auto-fill never moves a person into two rides at once.
// QA run 20 pass 2: עדי drove her private car while auto-fill moved her other trip earlier, onto the same hours.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, flex, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';
import { freeStretches, legWindow } from '../personBusy';
import type { FixedRide, LegSide } from '../types';

const HOME = 'home';

function ride(id: string, carId: string, start: number, end: number, riders: { memberId: string; leg: LegSide }[]): FixedRide {
  return {
    id, carId, window: { start, end }, originId: HOME, destinationId: HOME,
    driverMemberId: riders[0]?.memberId, riders,
    legs: [], servedRequestIds: [], passengers: { adults: riders.length, childSeats: 0, boosters: 0 }, luggageCount: 0,
    overnightAck: false, kind: 'pinned',
  };
}

// Her trip 10:00–12:00 may move up to 2 h later as one block (a window request). The only shared car is taken
// 08:00–10:30, so with the turnaround it is free from 11:00: the solver moves her to 11:00–13:00.
const adi = () => makeRequest({
  id: 'ADI', memberId: 'adi', memberName: 'עדי', tripType: 'round_trip', durationLocked: true,
  departureMs: slotMs(40), returnMs: slotMs(48), flexDeparture: flex(0, 120), flexReturn: flex(0, 120),
});
const shared = [makeCar('C1')];
const taken = ride('TAKEN', 'C1', 32, 42, [{ memberId: 'other', leg: 'both' }]);
const privateCar = makeCar('PRIV', { type: 'temporary', ownerMemberId: 'adi' });

describe('R20B5 person busy', () => {
  it('without another ride of hers, the trip moves to 11:00–13:00', () => {
    const out = solve(baseInput({ cars: shared, requests: [adi()], fixedRides: [taken] }));
    const a = out.assignments.find((x) => x.servedRequestIds.includes('ADI'));
    expect(a?.window).toEqual({ start: 44, end: 52 });
  });

  it('driving her private car 12:00–13:00, the trip is not moved onto it and says why', () => {
    const out = solve(baseInput({
      cars: [...shared, privateCar], requests: [adi()],
      fixedRides: [taken, ride('PRIVATE', 'PRIV', 48, 52, [{ memberId: 'adi', leg: 'both' }])],
    }));
    expect(out.assignments.some((x) => x.servedRequestIds.includes('ADI'))).toBe(false);
    const u = out.unmet.find((x) => x.requestId === 'ADI');
    expect(u?.reasonCode).toBe('UNMET_PERSON_BUSY');
    expect(u?.reason).toBe('עדי כבר בנסיעה אחרת בשעות האלה');
  });

  it('a passenger of another ride counts too, but only over the leg she rides', () => {
    // a 12:00–16:00 ride on C2 she only returns on: busy about 15:00–16:00, so 11:00–13:00 on C1 is fine
    const returnOnly = solve(baseInput({
      cars: [...shared, makeCar('C2')], requests: [adi()],
      fixedRides: [taken, ride('RET', 'C2', 48, 64, [{ memberId: 'driver2', leg: 'both' }, { memberId: 'adi', leg: 'return' }])],
    }));
    expect(returnOnly.assignments.find((x) => x.servedRequestIds.includes('ADI'))?.window).toEqual({ start: 44, end: 52 });
    // the same ride on its out leg: busy 12:00–13:00 (the default travel time), the move is refused
    const outLeg = solve(baseInput({
      cars: [...shared, makeCar('C2')], requests: [adi()],
      fixedRides: [taken, ride('OUT', 'C2', 48, 64, [{ memberId: 'driver2', leg: 'both' }, { memberId: 'adi', leg: 'out' }])],
    }));
    expect(outLeg.unmet.find((x) => x.requestId === 'ADI')?.reasonCode).toBe('UNMET_PERSON_BUSY');
  });

  it('someone else on the ride is not her: a ride she is not on never blocks her', () => {
    const out = solve(baseInput({
      cars: [...shared, privateCar], requests: [adi()],
      fixedRides: [taken, ride('PRIVATE', 'PRIV', 48, 52, [{ memberId: 'someone', leg: 'both' }])],
    }));
    expect(out.assignments.find((x) => x.servedRequestIds.includes('ADI'))?.window).toEqual({ start: 44, end: 52 });
  });

  it('hours she filed overlapping are kept as filed (only the solver\'s own moves are checked)', () => {
    const out = solve(baseInput({
      cars: [...shared, privateCar], requests: [adi()],
      // 10:15–11:15 overlaps what she filed (10:00–12:00), so it does not stop the move to 11:00–13:00
      fixedRides: [taken, ride('PRIVATE', 'PRIV', 41, 45, [{ memberId: 'adi', leg: 'both' }])],
    }));
    expect(out.assignments.find((x) => x.servedRequestIds.includes('ADI'))?.window).toEqual({ start: 44, end: 52 });
  });
});

describe('personBusy helpers', () => {
  it('legWindow: both = the ride; out/return = that leg\'s travel at its end of the ride', () => {
    expect(legWindow({ start: 40, end: 60 }, 'both', 2)).toEqual({ start: 40, end: 60 });
    expect(legWindow({ start: 40, end: 60 }, 'out', 2)).toEqual({ start: 40, end: 42 });
    expect(legWindow({ start: 40, end: 60 }, 'return', 2)).toEqual({ start: 58, end: 60 });
  });

  it('freeStretches cuts a gap by the busy hours', () => {
    expect(freeStretches({ start: 0, end: 100 }, [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 90, end: 120 }]))
      .toEqual([{ start: 0, end: 10 }, { start: 30, end: 90 }]);
    expect(freeStretches({ start: 0, end: 10 }, [])).toEqual([{ start: 0, end: 10 }]);
  });
});
