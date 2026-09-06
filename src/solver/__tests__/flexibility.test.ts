import { describe, expect, it } from 'vitest';
import { bestPlacementWithinFlex } from '../flexibility';
import { normalize } from '../slots';
import { CarTimeline } from '../timeline';
import { baseInput, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';

const HOME = 'home';
const WEEK_SLOTS = 96 * 7;

function normalizeOne(overrides: Parameters<typeof makeRequest>[0] = {}) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest(overrides)] });
  const { normalized } = normalize(input);
  return normalized[0]!;
}

// NOTE on 'both' (keep) legs: per SOLVER.md §3.7, dep'/ret' are clamped
// *independently* toward their own preferred value, and a gap is rejected
// outright if the duration constraint then fails ("both bounds are already
// the closest to the preferred" — no smarter coupled search). Since a
// leg's own preferred return R always lies inside its own flexRet range
// (and symmetrically for D/flexDep), a 'both' leg's placement can only ever
// land unshifted (dep'=D, ret'=R) via this function — genuine non-zero
// shifts for 'both' legs come only from the improvement pass's dedicated
// same-car compression (see improve.test.ts), not from this O(1) formula.
// These tests therefore exercise the single-dimension (one-way) legs, where
// exactly one bound is free to move and the duration is fixed (= travel
// time), which is where this function's flex search actually bites.
describe('bestPlacementWithinFlex', () => {
  it('an out-leg with -0/+60 flex shifts later only, never earlier', () => {
    const nr = normalizeOne({
      tripShape: 'one_way_to',
      oneWayCarMode: 'relay',
      departureMs: slotMs(32),
      flexDeparture: { earlierMin: 0, laterMin: 60 },
    });
    const tl = new CarTimeline(makeCar('C1'), 2, WEEK_SLOTS, HOME);
    tl.add({ rideId: 'blocker', window: { start: 30, end: 34 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    const placement = bestPlacementWithinFlex(tl, nr);
    expect(placement).not.toBeNull();
    expect(placement!.shift.departureMin).toBeGreaterThan(0); // forced later
    expect(placement!.window.start).toBe(36); // right after the buffered blocker
  });

  it('a return-leg with -120/+0 flex shifts earlier only, never later', () => {
    const nr = normalizeOne({
      tripShape: 'one_way_from',
      oneWayCarMode: 'relay',
      returnMs: slotMs(48),
      flexReturn: { earlierMin: 120, laterMin: 0 },
    });
    // The car must already be at the destination for a return-leg relay to
    // start there; seed it as parked at destA from the top of the week.
    const tl = new CarTimeline(makeCar('C1', { startLocationId: 'destA' }), 2, WEEK_SLOTS, HOME);
    // return leg occupies [R-travelSlots, R) = [46,48); a blocker overlapping
    // its tail forces the arrival earlier, never later (laterMin = 0).
    tl.add({ rideId: 'blocker', window: { start: 47, end: 50 }, startLocationId: 'destA', endLocationId: 'destA', overnightAck: false });
    const placement = bestPlacementWithinFlex(tl, nr);
    expect(placement).not.toBeNull();
    expect(placement!.shift.returnMin).toBeLessThan(0); // forced earlier
    expect(placement!.window.end).toBe(45); // 47 - buffer(2)
  });

  it('rejects a clamp result that would collapse the ride below its minimum duration', () => {
    const nr = normalizeOne({
      departureMs: slotMs(32),
      returnMs: slotMs(48),
      flexDeparture: { earlierMin: 120, laterMin: 120 },
      flexReturn: { earlierMin: 120, laterMin: 120 },
    });
    const tl = new CarTimeline(makeCar('C1'), 0, 60, HOME);
    tl.add({ rideId: 'left', window: { start: 0, end: 10 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    tl.add({ rideId: 'right', window: { start: 20, end: 60 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    // Only gap is [10,20) = 10 slots, duration needed is 16 -> infeasible everywhere.
    expect(bestPlacementWithinFlex(tl, nr)).toBeNull();
  });

  it('the earliest minimal-shift point wins when several gaps could host the ride', () => {
    const nr = normalizeOne({
      tripShape: 'one_way_to',
      oneWayCarMode: 'relay',
      departureMs: slotMs(40),
      flexDeparture: { earlierMin: 120, laterMin: 120 },
    });
    const tl = new CarTimeline(makeCar('C1'), 0, WEEK_SLOTS, HOME);
    tl.add({ rideId: 'blocker', window: { start: 38, end: 44 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    const placement = bestPlacementWithinFlex(tl, nr);
    expect(placement).not.toBeNull();
    // Landing before (36) and after (44) the blocker cost the same (60 min);
    // the earlier-departure tie-break (SOLVER §3.7) picks the earlier one.
    expect(placement!.window.start).toBe(36);
    expect(placement!.cost).toBe(60);
  });

  it('a "both" leg lands unshifted when the preferred window is simply free', () => {
    const nr = normalizeOne({ departureMs: slotMs(32), returnMs: slotMs(48) });
    const tl = new CarTimeline(makeCar('C1'), 2, WEEK_SLOTS, HOME);
    const placement = bestPlacementWithinFlex(tl, nr);
    expect(placement).toEqual({ window: { start: 32, end: 48 }, shift: { departureMin: 0, returnMin: 0 }, cost: 0 });
  });

  it('a single-leg (one-way relay) request only searches gaps at its own origin', () => {
    const nr = normalizeOne({
      tripShape: 'one_way_to',
      oneWayCarMode: 'relay',
      departureMs: slotMs(32),
      flexDeparture: { earlierMin: 30, laterMin: 30 },
    });
    const tl = new CarTimeline(makeCar('C1'), 2, WEEK_SLOTS, HOME);
    const placement = bestPlacementWithinFlex(tl, nr);
    expect(placement).not.toBeNull();
    expect(placement!.window.start).toBe(32);
  });
});
