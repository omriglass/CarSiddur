// src/solver/invariants.ts
//
// assertInvariants() (docs/SOLVER.md §3.12): runs before solve() returns.
// Checks no-overlap per car (buffer + maintenance), seat fit, every request
// served exactly once, fixed rides unchanged, the location chain per car,
// temporary cars only base -> base, and relay pairing consistency. The
// day-end rule is retired (REQUIREMENTS §13.93): a car may legitimately end
// any day away from home — only `WARN_CAR_AWAY_AT_WEEK_END` (index.ts, a
// warning, not an invariant) flags it away from its base at week end. A
// violation throws SolverInvariantError — the caller keeps the previous draft.

import { fits, luggageFits } from './seatFit';
import { minutesToSlots, SLOT_MS } from './slots';
import { CarTimeline } from './timeline';
import type { Assignment, FixedRide, SolverInput, SolverOutput } from './types';
import { SolverInvariantError } from './types';

function weekSlotsOf(input: SolverInput): number {
  return input.week.days.reduce((max, d) => Math.max(max, d.endSlot), 0);
}

export function assertInvariants(input: SolverInput, output: SolverOutput): void {
  const cars = new Map(input.cars.map((c) => [c.id, c]));
  const bufferSlots = minutesToSlots(input.config.bufferMinutes);
  const weekSlots = weekSlotsOf(input);
  const overnightAckByRideId = new Map<string, boolean>(input.fixedRides.map((fr: FixedRide) => [fr.id, fr.overnightAck]));
  const approvedBufferByRideId = new Map(input.fixedRides.map((fr) => [fr.id, fr.approvedBufferAfterSlots]));
  // Both legs of a solver relay pair share one id: no buffer between them (REQUIREMENTS §13.88).
  const relayPairIdByRideId = new Map<string, string>();
  for (const a of output.assignments) {
    if (a.source !== 'solver' || !a.pairedRideId) continue;
    const [first, second] = [a.rideId, a.pairedRideId].sort();
    relayPairIdByRideId.set(a.rideId, `pair:${first}:${second}`);
  }

  const timelines = new Map<string, CarTimeline>();
  for (const car of input.cars) timelines.set(car.id, new CarTimeline(car, bufferSlots, weekSlots, input.homeLocationId));

  const byCar = new Map<string, Assignment[]>();
  for (const a of output.assignments) {
    const list = byCar.get(a.carId) ?? [];
    list.push(a);
    byCar.set(a.carId, list);
  }

  for (const [carId, list] of byCar) {
    const tl = timelines.get(carId);
    const car = cars.get(carId);
    if (!tl || !car) throw new SolverInvariantError(`unknown car ${carId}`, 'UNKNOWN_CAR');

    if (car.type === 'temporary') {
      // REQUIREMENTS §13.93: a temporary car's "home" is its own base
      // location (the owner's default origin), not necessarily the
      // department home — unchanged (home) for every car that omits `baseLocationId`.
      const base = car.baseLocationId ?? input.homeLocationId;
      for (const a of list) {
        if (a.originId !== base || a.destinationId !== base) {
          throw new SolverInvariantError(`temporary car ${carId} used away from its base on ride ${a.rideId}`, 'TEMP_CAR_AWAY');
        }
      }
    }

    const sorted = [...list].sort((a, b) => a.window.start - b.window.start);
    for (const a of sorted) {
      if (a.source === 'solver') {
        const day = input.week.days.find((day) => day.startSlot <= a.window.start && a.window.start < day.endSlot);
        const exactDayEnd = day && a.window.end === day.endSlot && input.requests.some((request) =>
          a.servedRequestIds.includes(request.id) && request.returnMs === input.week.startMs + day.endSlot * SLOT_MS - 60_000);
        if (!day || a.window.end > day.endSlot - 1 && !exactDayEnd) {
          throw new SolverInvariantError(`ride ${a.rideId} crosses its scheduling day`, 'RIDE_OUTSIDE_DAY');
        }
      }
      if (!fits(car, a.passengers)) {
        throw new SolverInvariantError(`ride ${a.rideId} does not fit car ${carId}'s seat configs`, 'SEAT_OVERFLOW');
      }
      if (!luggageFits(car, a.luggageCount)) {
        throw new SolverInvariantError(`ride ${a.rideId} exceeds car ${carId}'s luggage capacity`, 'LUGGAGE_OVERFLOW');
      }
      try {
        const block = {
          rideId: a.rideId,
          window: a.window,
          startLocationId: a.originId,
          endLocationId: a.destinationId,
          overnightAck: overnightAckByRideId.get(a.rideId) ?? Boolean(a.seriesId),
          approvedBufferAfterSlots: approvedBufferByRideId.get(a.rideId),
          seriesId: a.seriesId,
          relayPairId: relayPairIdByRideId.get(a.rideId),
        };
        // Fixed rides are "still honoured" even if their recorded origin does
        // not chain from the previous ride (SOLVER §3.1) — only the solver's
        // own placements must keep a strict location chain.
        if (a.source === 'fixed') tl.forceAdd(block);
        else tl.add(block);
      } catch (e) {
        throw new SolverInvariantError(
          `ride ${a.rideId} on car ${carId}: ${e instanceof Error ? e.message : String(e)}`,
          'OVERLAP_OR_LOCATION',
        );
      }
    }

    // REQUIREMENTS §13.93: the day-end rule (and its CAR_AWAY_AT_DAY_END
    // invariant) is retired — a car legitimately stays wherever its last ride
    // left it, across days and weeks; only `WARN_CAR_AWAY_AT_WEEK_END`
    // (a warning, not an invariant) flags a car away from its base at week end.
  }

  // Every request appears exactly once (assignment, unmet, or servedByFixed).
  const seen = new Set<string>();
  for (const a of output.assignments) {
    for (const rid of a.servedRequestIds) {
      if (seen.has(rid)) throw new SolverInvariantError(`request ${rid} served more than once`, 'DUPLICATE_SERVE');
      seen.add(rid);
    }
  }
  for (const u of output.unmet) {
    if (seen.has(u.requestId)) {
      throw new SolverInvariantError(`request ${u.requestId} both served and unmet`, 'DUPLICATE_SERVE');
    }
    seen.add(u.requestId);
  }
  for (const r of input.requests) {
    if (!seen.has(r.id)) throw new SolverInvariantError(`request ${r.id} missing from output`, 'MISSING_REQUEST');
  }

  // Fixed rides are returned unchanged.
  const outputById = new Map(output.assignments.map((a) => [a.rideId, a]));
  for (const fr of input.fixedRides) {
    const a = outputById.get(fr.id);
    if (!a || a.source !== 'fixed') {
      throw new SolverInvariantError(`fixed ride ${fr.id} missing or not marked fixed`, 'FIXED_RIDE_CHANGED');
    }
    if (a.carId !== fr.carId || a.window.start !== fr.window.start || a.window.end !== fr.window.end) {
      throw new SolverInvariantError(`fixed ride ${fr.id} was changed`, 'FIXED_RIDE_CHANGED');
    }
  }

  // Relay pairing consistency (solver-placed rides only; fixed rides are
  // pre-validated by the caller / SQL's assert_car_chain()). Scoped to
  // PLACED_RELAY_PAIR (the only reasonCode the pairing path produces) —
  // REQUIREMENTS §13.93's explicit `one_way` trip type also places a single
  // `carMode: 'relay'` leg, but has no pairing obligation by design.
  for (const a of output.assignments) {
    if (a.source !== 'solver' || a.reasonCode !== 'PLACED_RELAY_PAIR') continue;
    for (const leg of a.legs) {
      if (leg.carMode !== 'relay') continue;
      if (!a.pairedRideId) {
        throw new SolverInvariantError(`relay ride ${a.rideId} has no pairedRideId`, 'RELAY_UNPAIRED');
      }
      const partner = outputById.get(a.pairedRideId);
      if (!partner || partner.carId !== a.carId) {
        throw new SolverInvariantError(`relay ride ${a.rideId} pairing is broken`, 'RELAY_UNPAIRED');
      }
    }
  }

  // Multi-day series (SOLVER §3.x): every leg on one car, in seriesIndex
  // order, contiguous (no foreign block or gap between two consecutive legs)
  // and location-chained. The buffer/overlap check above already guarantees
  // no *other* ride can be scheduled between two legs; this check confirms
  // the series itself is coherent.
  const bySeriesId = new Map<string, Assignment[]>();
  for (const a of output.assignments) {
    if (!a.seriesId) continue;
    const list = bySeriesId.get(a.seriesId) ?? [];
    list.push(a);
    bySeriesId.set(a.seriesId, list);
  }
  for (const [seriesId, list] of bySeriesId) {
    const sorted = [...list].sort((a, b) => a.window.start - b.window.start);
    const carId = sorted[0]?.carId;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (!a) continue;
      if (a.carId !== carId) {
        throw new SolverInvariantError(`series ${seriesId} spans more than one car`, 'SERIES_MULTI_CAR');
      }
      if (i > 0) {
        const prev = sorted[i - 1];
        if (!prev) continue;
        if (prev.window.end !== a.window.start) {
          throw new SolverInvariantError(`series ${seriesId} legs are not contiguous`, 'SERIES_NOT_CONTIGUOUS');
        }
        if (prev.destinationId !== a.originId) {
          throw new SolverInvariantError(`series ${seriesId} location chain is broken`, 'SERIES_LOCATION_BROKEN');
        }
      }
    }
  }
}
